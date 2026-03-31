import * as Tesseract from 'tesseract.js';

export type CardLanguage = 'eng' | 'eng+fra' | 'fra';
export type OcrStatus = 'idle' | 'loading' | 'ready' | 'scanning' | 'done' | 'error';

export interface OcrSignal {
  confidence: number;
  label: string;
  value: string;
}

export interface OcrLineResult {
  confidence: number;
  text: string;
}

export interface OcrWordResult {
  confidence: number;
  text: string;
}

export interface OcrCollectorCandidate {
  confidence: number;
  source: string;
  value: string;
}

export interface OcrZoneResult {
  confidence: number;
  debugImageUrl: string;
  debugLabel: string;
  id: 'collector' | 'footer' | 'hp' | 'name';
  label: string;
  text: string;
}

export interface OcrResultSummary {
  averageConfidence: number;
  collectorNumber: string;
  collectorNumberCandidates: OcrCollectorCandidate[];
  debugImageUrl: string;
  debugLabel: string;
  lines: OcrLineResult[];
  rawText: string;
  signals: OcrSignal[];
  words: OcrWordResult[];
  zones: OcrZoneResult[];
}

type ProgressListener = (message: Tesseract.LoggerMessage) => void;

const genericSignalMatchers = [
  {
    label: 'HP / PV',
    pattern: /\b(?:HP|PV)\s*\d{2,4}\b|\b\d{2,4}\s*(?:HP|PV)\b/i,
  },
  {
    label: 'Type / stade',
    pattern:
      /\b(?:Basic|Basique|Stage ?1|Stage ?2|Niveau ?1|Niveau ?2|VSTAR|VMAX|GX|EX|MEGA)\b/i,
  },
];

const generalWorkerParams: Partial<Tesseract.WorkerParams> = {
  preserve_interword_spaces: '1',
  tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
  user_defined_dpi: '300',
};

const nameWorkerParams: Partial<Tesseract.WorkerParams> = {
  preserve_interword_spaces: '1',
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  user_defined_dpi: '300',
};

const hpWorkerParams: Partial<Tesseract.WorkerParams> = {
  preserve_interword_spaces: '0',
  tessedit_char_whitelist: 'HPPV0123456789',
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  user_defined_dpi: '300',
};

const numberWorkerParams: Partial<Tesseract.WorkerParams> = {
  preserve_interword_spaces: '0',
  tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-.',
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  user_defined_dpi: '300',
};

const footerWorkerParams: Partial<Tesseract.WorkerParams> = {
  preserve_interword_spaces: '1',
  tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
  user_defined_dpi: '300',
};

let activeProgressListener: ProgressListener = () => undefined;
let workerPromise: Promise<Tesseract.Worker> | null = null;
let currentWorkerLanguage: CardLanguage | null = null;

interface CropRegion {
  height: number;
  label: string;
  left: number;
  top: number;
  width: number;
}

interface PreparedCanvas {
  canvas: HTMLCanvasElement;
  label: string;
}

export function setOcrProgressListener(listener: ProgressListener): void {
  activeProgressListener = listener;
}

export async function warmupOcr(language: CardLanguage): Promise<void> {
  await getWorker(language);
}

export async function terminateOcrWorker(): Promise<void> {
  if (!workerPromise) {
    currentWorkerLanguage = null;
    return;
  }

  const worker = await workerPromise;
  workerPromise = null;
  currentWorkerLanguage = null;
  await worker.terminate();
}

export async function recognizeCanvas(
  source: HTMLCanvasElement,
  language: CardLanguage,
): Promise<OcrResultSummary> {
  const worker = await getWorker(language);
  const primary = prepareEnhancedCanvas(source);
  let best = await runRecognition(worker, primary);

  if (shouldTryFallback(best.summary)) {
    const fallback = await runRecognition(worker, prepareColorFallbackCanvas(source));

    if (scoreSummary(fallback.summary) > scoreSummary(best.summary)) {
      best = fallback;
    }
  }

  const nameZone = await detectNameZone(worker, source);
  const hpZone = await detectHpZone(worker, source);
  const collectorZoneData = await detectCollectorZone(worker, source);
  const footerZone = await detectFooterZone(worker, source);

  const zones = [nameZone, hpZone, collectorZoneData.zone, footerZone];
  const collectorNumberCandidates = collectorZoneData.candidates;
  const collectorNumber = collectorNumberCandidates[0]?.value ?? '';

  return {
    ...best.summary,
    collectorNumber,
    collectorNumberCandidates,
    debugImageUrl: best.prepared.canvas.toDataURL('image/jpeg', 0.92),
    debugLabel: best.prepared.label,
    signals: detectSignals(
      best.summary.lines,
      zones,
      collectorNumberCandidates,
    ),
    zones,
  };
}

function getWorker(language: CardLanguage): Promise<Tesseract.Worker> {
  return ensureWorker(language);
}

function createWorker(language: CardLanguage): Promise<Tesseract.Worker> {
  return Tesseract.createWorker(language, Tesseract.OEM.LSTM_ONLY, {
    logger: (message) => activeProgressListener(message),
  }).then(async (worker) => {
    await worker.setParameters(generalWorkerParams);

    return worker;
  });
}

async function ensureWorker(language: CardLanguage): Promise<Tesseract.Worker> {
  if (workerPromise && currentWorkerLanguage === language) {
    return workerPromise;
  }

  if (workerPromise) {
    const previousWorker = await workerPromise;

    workerPromise = null;
    currentWorkerLanguage = null;
    await previousWorker.terminate();
  }

  workerPromise = createWorker(language);
  currentWorkerLanguage = language;

  return workerPromise;
}

function collectLines(blocks: Tesseract.Block[] | null): OcrLineResult[] {
  if (!blocks) {
    return [];
  }

  const lines: OcrLineResult[] = [];

  blocks.forEach((block) => {
    block.paragraphs.forEach((paragraph) => {
      paragraph.lines.forEach((line) => {
        const text = normalizeSpaces(line.text).trim();

        if (!text) {
          return;
        }

        lines.push({
          confidence: Number(line.confidence.toFixed(1)),
          text,
        });
      });
    });
  });

  return lines;
}

function collectWords(lines: OcrLineResult[]): OcrWordResult[] {
  return lines
    .flatMap((line) =>
      line.text.split(' ').map((chunk) => ({
        confidence: line.confidence,
        text: normalizeSpaces(chunk).trim(),
      })),
    )
    .filter((word) => word.text.length > 0);
}

function detectSignals(
  lines: OcrLineResult[],
  zones: OcrZoneResult[],
  collectorNumberCandidates: OcrCollectorCandidate[],
): OcrSignal[] {
  const signals: OcrSignal[] = [];
  const usedValues = new Set<string>();
  const collectorNumber = collectorNumberCandidates[0];
  const nameZone = zones.find((zone) => zone.id === 'name' && zone.text);
  const hpZone = zones.find((zone) => zone.id === 'hp' && zone.text);

  if (nameZone) {
    usedValues.add(nameZone.text);
    signals.push({
      confidence: nameZone.confidence,
      label: 'Nom probable',
      value: nameZone.text,
    });
  }

  if (collectorNumber) {
    usedValues.add(collectorNumber.value);
    signals.push({
      confidence: collectorNumber.confidence,
      label: 'Numero probable',
      value: collectorNumber.value,
    });
  }

  if (hpZone && !usedValues.has(hpZone.text)) {
    usedValues.add(hpZone.text);
    signals.push({
      confidence: hpZone.confidence,
      label: 'HP / PV',
      value: hpZone.text,
    });
  }

  genericSignalMatchers.forEach((matcher) => {
    const match = lines.find((line) => matcher.pattern.test(line.text));

    if (!match) {
      return;
    }

    const value = match.text;

    if (usedValues.has(value)) {
      return;
    }

    usedValues.add(value);
    signals.push({
      confidence: match.confidence,
      label: matcher.label,
      value,
    });
  });

  return signals;
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ');
}

async function runRecognition(
  worker: Tesseract.Worker,
  prepared: PreparedCanvas,
): Promise<{ prepared: PreparedCanvas; summary: OcrResultSummary }> {
  await worker.setParameters(generalWorkerParams);

  const { data } = await worker.recognize(
    prepared.canvas,
    { rotateAuto: true },
    { blocks: true, text: true },
  );

  const lines = collectLines(data.blocks);
  const words = collectWords(lines);
  const rawText = normalizeSpaces(data.text).trim();
  const averageConfidence =
    lines.length > 0
      ? Number(
          (
            lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length
          ).toFixed(1),
        )
      : 0;

  return {
    prepared,
    summary: {
      averageConfidence,
      collectorNumber: '',
      collectorNumberCandidates: [],
      debugImageUrl: '',
      debugLabel: prepared.label,
      lines,
      rawText,
      signals: [],
      words,
      zones: [],
    },
  };
}

function shouldTryFallback(summary: OcrResultSummary): boolean {
  return (
    summary.averageConfidence < 62 ||
    summary.lines.length < 2 ||
    summary.rawText.length < 20
  );
}

function scoreSummary(summary: OcrResultSummary): number {
  return (
    summary.averageConfidence +
    summary.lines.length * 6 +
    Math.min(summary.words.length, 40) * 0.75
  );
}

async function detectNameZone(
  worker: Tesseract.Worker,
  source: HTMLCanvasElement,
): Promise<OcrZoneResult> {
  const region: CropRegion = {
    height: 0.16,
    label: 'bande nom',
    left: 0.05,
    top: 0.05,
    width: 0.68,
  };

  return recognizeZone(worker, {
    id: 'name',
    label: 'Nom',
    params: nameWorkerParams,
    region,
    source,
    textFromRaw: (rawText) =>
      normalizeSpaces(rawText)
        .replace(/[^0-9A-ZÀ-ÿ'\-.\s]/g, ' ')
        .trim(),
    variants: (cropped) => [
      prepareEnhancedCanvas(cropped),
      prepareColorFallbackCanvas(cropped),
    ],
  });
}

async function detectHpZone(
  worker: Tesseract.Worker,
  source: HTMLCanvasElement,
): Promise<OcrZoneResult> {
  const region: CropRegion = {
    height: 0.15,
    label: 'coin HP',
    left: 0.72,
    top: 0.04,
    width: 0.23,
  };

  return recognizeZone(worker, {
    id: 'hp',
    label: 'HP / PV',
    params: hpWorkerParams,
    region,
    source,
    textFromRaw: (rawText) => extractHpText(rawText),
    variants: (cropped) => [
      {
        canvas: prepareNumberCanvas(cropped, false),
        label: 'hp gris contraste',
      },
      {
        canvas: prepareNumberCanvas(cropped, true),
        label: 'hp binaire fort',
      },
    ],
  });
}

async function detectFooterZone(
  worker: Tesseract.Worker,
  source: HTMLCanvasElement,
): Promise<OcrZoneResult> {
  const region: CropRegion = {
    height: 0.18,
    label: 'bande basse',
    left: 0.02,
    top: 0.79,
    width: 0.94,
  };

  return recognizeZone(worker, {
    id: 'footer',
    label: 'Bande basse',
    params: footerWorkerParams,
    region,
    source,
    textFromRaw: (rawText) => normalizeSpaces(rawText).trim(),
    variants: (cropped) => [
      prepareEnhancedCanvas(cropped),
      prepareColorFallbackCanvas(cropped),
    ],
  });
}

async function detectCollectorZone(
  worker: Tesseract.Worker,
  source: HTMLCanvasElement,
): Promise<{ candidates: OcrCollectorCandidate[]; zone: OcrZoneResult }> {
  const candidates = new Map<string, OcrCollectorCandidate>();
  const regions: CropRegion[] = [
    { label: 'bas gauche large', left: 0.02, top: 0.81, width: 0.54, height: 0.18 },
    { label: 'bas gauche serre', left: 0.02, top: 0.86, width: 0.4, height: 0.1 },
    { label: 'bande basse', left: 0.02, top: 0.81, width: 0.78, height: 0.18 },
  ];
  let bestZone: OcrZoneResult = {
    confidence: 0,
    debugImageUrl: '',
    debugLabel: '',
    id: 'collector',
    label: 'Numero',
    text: '',
  };
  let bestScore = -1;

  await worker.setParameters(numberWorkerParams);

  for (const region of regions) {
    const variants = prepareCollectorRegionVariants(source, region);

    for (const variant of variants) {
      const { data } = await worker.recognize(
        variant.canvas,
        { rotateAuto: false },
        { text: true },
      );
      const rawText = normalizeSpaces(data.text).trim();
      const extracted = extractCollectorNumber(data.text);
      const confidence = Number(data.confidence.toFixed(1));
      const score =
        confidence + (extracted ? 80 : 0) + Math.min(rawText.length, 20);

      if (score > bestScore) {
        bestScore = score;
        bestZone = {
          confidence,
          debugImageUrl: variant.canvas.toDataURL('image/jpeg', 0.92),
          debugLabel: `${region.label} / ${variant.label}`,
          id: 'collector',
          label: 'Numero',
          text: extracted || rawText,
        };
      }

      if (!extracted) {
        continue;
      }

      const previous = candidates.get(extracted);

      if (!previous || confidence > previous.confidence) {
        candidates.set(extracted, {
          confidence,
          source: `${region.label} / ${variant.label}`,
          value: extracted,
        });
      }
    }
  }

  return {
    candidates: [...candidates.values()].sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }

      return right.value.length - left.value.length;
    }),
    zone: bestZone,
  };
}

async function recognizeZone(
  worker: Tesseract.Worker,
  config: {
    id: OcrZoneResult['id'];
    label: string;
    params: Partial<Tesseract.WorkerParams>;
    region: CropRegion;
    source: HTMLCanvasElement;
    textFromRaw: (rawText: string) => string;
    variants: (cropped: HTMLCanvasElement) => PreparedCanvas[];
  },
): Promise<OcrZoneResult> {
  const cropped = cropCanvas(config.source, config.region);
  const variants = config.variants(cropped);
  let best: OcrZoneResult = {
    confidence: 0,
    debugImageUrl: variants[0]?.canvas.toDataURL('image/jpeg', 0.92) ?? '',
    debugLabel: variants[0]?.label ?? '',
    id: config.id,
    label: config.label,
    text: '',
  };
  let bestScore = -1;

  await worker.setParameters(config.params);

  for (const variant of variants) {
    const { data } = await worker.recognize(
      variant.canvas,
      { rotateAuto: false },
      { text: true },
    );
    const text = config.textFromRaw(data.text);
    const confidence = Number(data.confidence.toFixed(1));
    const score = confidence + Math.min(text.length, 28) * 2;

    if (score <= bestScore) {
      continue;
    }

    bestScore = score;
    best = {
      confidence,
      debugImageUrl: variant.canvas.toDataURL('image/jpeg', 0.92),
      debugLabel: `${config.region.label} / ${variant.label}`,
      id: config.id,
      label: config.label,
      text,
    };
  }

  return best;
}
function cropCanvas(
  source: HTMLCanvasElement,
  region: CropRegion,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const left = Math.round(source.width * region.left);
  const top = Math.round(source.height * region.top);
  const width = Math.max(1, Math.round(source.width * region.width));
  const height = Math.max(1, Math.round(source.height * region.height));

  canvas.width = width;
  canvas.height = height;

  if (!context) {
    return source;
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, left, top, width, height, 0, 0, width, height);

  return canvas;
}

function prepareEnhancedCanvas(source: HTMLCanvasElement): PreparedCanvas {
  const scaledCanvas = scaleCanvas(source, 2, 1900);
  const context = scaledCanvas.getContext('2d');

  if (!context) {
    return { canvas: scaledCanvas, label: 'crop agrandi' };
  }

  const image = context.getImageData(0, 0, scaledCanvas.width, scaledCanvas.height);
  const data = image.data;
  let minLuma = 255;
  let maxLuma = 0;

  for (let index = 0; index < data.length; index += 4) {
    const luma = getLuma(data[index], data[index + 1], data[index + 2]);

    minLuma = Math.min(minLuma, luma);
    maxLuma = Math.max(maxLuma, luma);
  }

  const range = Math.max(28, maxLuma - minLuma);

  for (let index = 0; index < data.length; index += 4) {
    const luma = getLuma(data[index], data[index + 1], data[index + 2]);
    const normalized = Math.min(1, Math.max(0, (luma - minLuma) / range));
    const contrasted = Math.pow(normalized, 0.82);
    const boosted = Math.round(contrasted * 255);

    data[index] = boosted;
    data[index + 1] = boosted;
    data[index + 2] = boosted;
  }

  context.putImageData(image, 0, 0);

  return {
    canvas: scaledCanvas,
    label: 'crop contraste fort',
  };
}

function prepareColorFallbackCanvas(source: HTMLCanvasElement): PreparedCanvas {
  return {
    canvas: scaleCanvas(source, 1.6, 1800),
    label: 'crop couleur',
  };
}

function prepareCollectorRegionVariants(
  source: HTMLCanvasElement,
  region: CropRegion,
): PreparedCanvas[] {
  const cropped = cropCanvas(source, region);

  return [
    {
      canvas: prepareNumberCanvas(cropped, false),
      label: 'gris contraste',
    },
    {
      canvas: prepareNumberCanvas(cropped, true),
      label: 'binaire fort',
    },
  ];
}

function prepareNumberCanvas(
  source: HTMLCanvasElement,
  useThreshold: boolean,
): HTMLCanvasElement {
  const scaled = scaleCanvas(source, 3.2, 2200);
  const context = scaled.getContext('2d');

  if (!context) {
    return scaled;
  }

  const image = context.getImageData(0, 0, scaled.width, scaled.height);
  const data = image.data;
  let minLuma = 255;
  let maxLuma = 0;

  for (let index = 0; index < data.length; index += 4) {
    const luma = getLuma(data[index], data[index + 1], data[index + 2]);

    minLuma = Math.min(minLuma, luma);
    maxLuma = Math.max(maxLuma, luma);
  }

  const range = Math.max(24, maxLuma - minLuma);
  const threshold = minLuma + range * 0.58;

  for (let index = 0; index < data.length; index += 4) {
    const luma = getLuma(data[index], data[index + 1], data[index + 2]);
    const normalized = Math.min(1, Math.max(0, (luma - minLuma) / range));
    const contrasted = Math.pow(normalized, 0.72);
    const boosted = Math.round(contrasted * 255);
    const nextValue = useThreshold
      ? boosted >= threshold
        ? 255
        : 0
      : boosted;

    data[index] = nextValue;
    data[index + 1] = nextValue;
    data[index + 2] = nextValue;
  }

  context.putImageData(image, 0, 0);

  return scaled;
}

function scaleCanvas(
  source: HTMLCanvasElement,
  multiplier: number,
  maxLongestEdge: number,
): HTMLCanvasElement {
  const longestEdge = Math.max(source.width, source.height);
  const scale = Math.min(multiplier, maxLongestEdge / longestEdge);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  canvas.width = width;
  canvas.height = height;

  if (!context) {
    return source;
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);

  return canvas;
}

function extractCollectorNumber(rawValue: string): string {
  const normalized = rawValue
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[,;:]/g, '')
    .replace(/[|]/g, '1')
    .replace(/[()]/g, '');
  const slashMatch = normalized.match(
    /(?:[A-Z]{1,5}-?)?\d{1,3}\/[A-Z0-9]{1,4}/,
  );

  if (slashMatch) {
    return slashMatch[0];
  }

  const promoMatch = normalized.match(/[A-Z]{2,6}-?\d{1,4}/);

  if (promoMatch) {
    return promoMatch[0];
  }

  return '';
}

function extractHpText(rawValue: string): string {
  const normalized = rawValue.toUpperCase().replace(/\s+/g, '');
  const prefixMatch = normalized.match(/(?:HP|PV)\d{2,4}/);

  if (prefixMatch) {
    const label = prefixMatch[0].startsWith('PV') ? 'PV' : 'HP';

    return `${label} ${prefixMatch[0].replace(/^(HP|PV)/, '')}`;
  }

  const suffixMatch = normalized.match(/\d{2,4}(?:HP|PV)/);

  if (suffixMatch) {
    const numeric = suffixMatch[0].replace(/(HP|PV)$/, '');
    const label = suffixMatch[0].endsWith('PV') ? 'PV' : 'HP';

    return `${label} ${numeric}`;
  }

  return '';
}

function getLuma(red: number, green: number, blue: number): number {
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}
