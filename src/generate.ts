import { createHash } from 'node:crypto';
import type { Box, GtBox, ImageInput, PredBox, PredictionInput } from './types.js';

export interface Rng {
  next(): number;
}

/** Deterministic PRNG (mulberry32) so generated datasets can be replayed exactly. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export interface GenerateOptions {
  seed: number;
  imageCount: number;
  width?: number;
  height?: number;
  categories: string[];
  /** Probability an image contains no GT objects (empty image). */
  emptyRate?: number;
  /** Probability a GT is missed by the predictor. */
  missRate?: number;
  /** Extra duplicate predictions per matched object. */
  duplicateRate?: number;
  /** Probability a prediction is shifted enough to land below IoU 0.5. */
  localizationErrorRate?: number;
  /** Probability the predictor emits the wrong class label. */
  wrongClassRate?: number;
  /** Probability of a pure background false positive. */
  backgroundFpRate?: number;
}

export interface GeneratedDataset {
  images: ImageInput[];
  predictions: PredictionInput[];
}

export function generateDataset(opts: GenerateOptions): GeneratedDataset {
  const rng = seededRng(opts.seed);
  const width = opts.width ?? 640;
  const height = opts.height ?? 480;
  const images: ImageInput[] = [];
  const predictions: PredictionInput[] = [];
  const emptyRate = opts.emptyRate ?? 0.1;
  const missRate = opts.missRate ?? 0.1;
  const duplicateRate = opts.duplicateRate ?? 0.1;
  const localizationErrorRate = opts.localizationErrorRate ?? 0.1;
  const wrongClassRate = opts.wrongClassRate ?? 0.05;
  const backgroundFpRate = opts.backgroundFpRate ?? 0.05;

  for (let i = 0; i < opts.imageCount; i += 1) {
    const externalId = `img_${String(i).padStart(4, '0')}`;
    const gt: GtBox[] = [];
    const boxes: PredBox[] = [];

    if (rng.next() > emptyRate) {
      const objectCount = 1 + Math.floor(rng.next() * 4);
      for (let j = 0; j < objectCount; j += 1) {
        const box = randomBox(rng, width, height);
        const category = opts.categories[Math.floor(rng.next() * opts.categories.length)];
        gt.push({ ...box, category });

        if (rng.next() < missRate) continue; // full miss

        let predBox = box;
        let predCategory = category;
        if (rng.next() < localizationErrorRate) {
          predBox = shiftBox(box, width, height, rng);
        }
        if (rng.next() < wrongClassRate && opts.categories.length > 1) {
          predCategory = otherCategory(opts.categories, category, rng);
        }
        boxes.push({ ...predBox, category: predCategory, confidence: round(0.5 + rng.next() * 0.5) });

        if (rng.next() < duplicateRate) {
          boxes.push({
            ...jitter(box, rng, 3),
            category,
            confidence: round(0.3 + rng.next() * 0.4),
          });
        }
      }
    }

    if (rng.next() < backgroundFpRate) {
      boxes.push({
        ...randomBox(rng, width, height),
        category: opts.categories[Math.floor(rng.next() * opts.categories.length)],
        confidence: round(rng.next() * 0.4),
      });
    }

    images.push({ externalId, width, height, gt });
    predictions.push({ externalId, boxes });
  }

  return { images, predictions };
}

function randomBox(rng: Rng, width: number, height: number): Box {
  const w = 30 + Math.floor(rng.next() * 80);
  const h = 30 + Math.floor(rng.next() * 80);
  const left = Math.floor(rng.next() * (width - w));
  const top = Math.floor(rng.next() * (height - h));
  return { left, top, right: left + w, bottom: top + h };
}

function jitter(box: Box, rng: Rng, px: number): Box {
  const dx = Math.floor((rng.next() - 0.5) * 2 * px);
  const dy = Math.floor((rng.next() - 0.5) * 2 * px);
  return { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy };
}

function shiftBox(box: Box, width: number, height: number, rng: Rng): Box {
  // Large shift typically drives IoU well below 0.5 while staying in bounds.
  const bw = box.right - box.left;
  const bh = box.bottom - box.top;
  const maxDx = Math.max(0, width - bw);
  const maxDy = Math.max(0, height - bh);
  const left = Math.floor(rng.next() * (maxDx + 1));
  const top = Math.floor(rng.next() * (maxDy + 1));
  // Keep some chance of partial overlap so IoU > 0 but < 0.5.
  if (rng.next() < 0.5) {
    return {
      left: Math.max(0, Math.min(width - bw, box.left + Math.floor(bw * 0.8))),
      top: box.top,
      right: Math.min(width, box.right + Math.floor(bw * 0.8)),
      bottom: box.bottom,
    };
  }
  return { left, top, right: Math.min(width, left + bw), bottom: Math.min(height, top + bh) };
}

function otherCategory(categories: string[], current: string, rng: Rng): string {
  const others = categories.filter((c) => c !== current);
  return others[Math.floor(rng.next() * others.length)];
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Deterministic fingerprint of the exact bytes submitted. Re-running the same
 * evaluation inputs yields the same hash and therefore the same frozen report.
 */
export function hashInput(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function canonicalJson(payload: unknown): string {
  return JSON.stringify(sortKeys(payload));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
