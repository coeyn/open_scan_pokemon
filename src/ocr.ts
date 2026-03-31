import * as Tesseract from 'tesseract.js';

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

export interface OcrResultSummary {
  averageConfidence: number;
  debugImageUrl: string;
  debugLabel: string;
  lines: OcrLineResult[];
  rawText: string;
  signals: OcrSignal[];
  words: OcrWordResult[];
}

type ProgressListener = (message: Tesseract.LoggerMessage) => void;

const OCR_LANGS = 'eng+fra';
const progressMatchers = [
  {
    label: 'Numero probable',
    pattern:
      /\b(?:[A-Z]{0,4}\d{1,3}\/[A-Z0-9]{1,4}|[A-Z]{0,4}\d{1,3}|[A-Z]{1,3}\d{1,3}\/[A-Z0-9]{1,4}|\d{1,3}\/\d{1,3})\b/i,
  },
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

let activeProgressListener: ProgressListener = () => undefined;
let workerPromise: Promise<Tesseract.Worker> | null = null;

interface PreparedCanvas {
  canvas: HTMLCanvasElement;
  label: string;
}

export function setOcrProgressListener(listener: ProgressListener): void {
  activeProgressListener = listener;
}

export async function warmupOcr(): Promise<void> {
  await getWorker();
}

export async function terminateOcrWorker(): Promise<void> {
  if (!workerPromise) {
    return;
  }

  const worker = await workerPromise;
  workerPromise = null;
  await worker.terminate();
}

export async function recognizeCanvas(
  source: HTMLCanvasElement,
): Promise<OcrResultSummary> {
  const worker = await getWorker();
  const primary = prepareEnhancedCanvas(source);
  let best = await runRecognition(worker, primary);

  if (shouldTryFallback(best.summary)) {
    const fallback = await runRecognition(worker, prepareColorFallbackCanvas(source));

    if (scoreSummary(fallback.summary) > scoreSummary(best.summary)) {
      best = fallback;
    }
  }

  return {
    ...best.summary,
    debugImageUrl: best.prepared.canvas.toDataURL('image/jpeg', 0.92),
    debugLabel: best.prepared.label,
  };
}

function getWorker(): Promise<Tesseract.Worker> {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker(
      OCR_LANGS,
      Tesseract.OEM.LSTM_ONLY,
      {
        logger: (message) => activeProgressListener(message),
      },
    ).then(async (worker) => {
      await worker.setParameters({
        preserve_interword_spaces: '1',
        tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
        user_defined_dpi: '300',
      });

      return worker;
    });
  }

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

function detectSignals(lines: OcrLineResult[]): OcrSignal[] {
  const signals: OcrSignal[] = [];
  const usedValues = new Set<string>();

  progressMatchers.forEach((matcher) => {
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

  const probableName = lines.find(
    (line) =>
      line.text.length >= 4 &&
      !progressMatchers.some((matcher) => matcher.pattern.test(line.text)),
  );

  if (probableName && !usedValues.has(probableName.text)) {
    signals.unshift({
      confidence: probableName.confidence,
      label: 'Nom probable',
      value: probableName.text,
    });
  }

  return signals;
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ');
}

async function runRecognition(
  worker: Tesseract.Worker,
  prepared: PreparedCanvas,
): Promise<{ prepared: PreparedCanvas; summary: OcrResultSummary }> {
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
      debugImageUrl: '',
      debugLabel: prepared.label,
      lines,
      rawText,
      signals: detectSignals(lines),
      words,
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
    summary.signals.length * 14 +
    Math.min(summary.words.length, 40) * 0.75
  );
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
    const normalized = Math.min(
      1,
      Math.max(0, (luma - minLuma) / range),
    );
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

function getLuma(red: number, green: number, blue: number): number {
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}
