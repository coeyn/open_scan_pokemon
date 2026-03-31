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
  const { data } = await worker.recognize(
    source,
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
    averageConfidence,
    lines,
    rawText,
    signals: detectSignals(lines),
    words,
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
