/**
 * Deterministic, seedable PRNG (mulberry32). Injecting a seed makes every
 * generated dataset/prediction set fully repeatable for tests and demos.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GeneratedDataset {
  slug: string;
  note: string;
  categories: { id: number; name: string }[];
  images: {
    key: string;
    width: number;
    height: number;
    boxes: { categoryId: number; x: number; y: number; w: number; h: number }[];
  }[];
}

export interface GeneratedPrediction {
  imageKey: string;
  categoryId: number;
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScenarioOptions {
  imageCount?: number;
  emptyImageCount?: number;
  boxCount?: number;
  categories?: { id: number; name: string }[];
}

export function generateDataset(
  slug: string,
  seed: number,
  opts: ScenarioOptions = {},
): GeneratedDataset {
  const rng = makeRng(seed);
  const categories = opts.categories ?? [
    { id: 1, name: "cat" },
    { id: 2, name: "dog" },
  ];
  const imageCount = opts.imageCount ?? 6;
  const emptyCount = opts.emptyImageCount ?? 1;
  const boxesPerImage = opts.boxCount ?? 2;
  const width = 100;
  const height = 100;

  const images: GeneratedDataset["images"] = [];
  for (let i = 0; i < imageCount; i += 1) {
    const key = `img-${String(i).padStart(3, "0")}`;
    const boxes = [];
    if (i >= emptyCount) {
      for (let j = 0; j < boxesPerImage; j += 1) {
        const cat = categories[Math.floor(rng() * categories.length)]!;
        const w = 10 + Math.floor(rng() * 20);
        const h = 10 + Math.floor(rng() * 20);
        const x = Math.floor(rng() * (width - w));
        const y = Math.floor(rng() * (height - h));
        boxes.push({ categoryId: cat.id, x, y, w, h });
      }
    }
    images.push({ key, width, height, boxes });
  }
  return { slug, note: `synthetic seed=${seed}`, categories, images };
}

export interface PredictStyle {
  /** Fraction of GT boxes reproduced. */
  recall?: number;
  /** Localization jitter in pixels. */
  jitter?: number;
  /** Probability a prediction gets the wrong category. */
  wrongClassRate?: number;
  /** Probability of emitting an extra duplicate box. */
  duplicateRate?: number;
  /** Probability of an extra background false positive. */
  backgroundRate?: number;
}

export function generatePredictions(
  dataset: GeneratedDataset,
  seed: number,
  style: PredictStyle = {},
): GeneratedPrediction[] {
  const rng = makeRng(seed);
  const {
    recall = 1,
    jitter = 0,
    wrongClassRate = 0,
    duplicateRate = 0,
    backgroundRate = 0,
  } = style;
  const catIds = dataset.categories.map((c) => c.id);
  const out: GeneratedPrediction[] = [];

  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
  const jit = () => Math.round((rng() * 2 - 1) * jitter);

  for (const img of dataset.images) {
    for (const gt of img.boxes) {
      if (rng() > recall) continue;
      let categoryId = gt.categoryId;
      if (rng() < wrongClassRate && catIds.length > 1) {
        categoryId = catIds.find((c) => c !== gt.categoryId)!;
      }
      const w = gt.w;
      const h = gt.h;
      const x = clamp(gt.x + jit(), img.width - w);
      const y = clamp(gt.y + jit(), img.height - h);
      out.push({
        imageKey: img.key,
        categoryId,
        score: round(0.5 + rng() * 0.5),
        x,
        y,
        w,
        h,
      });
      if (rng() < duplicateRate) {
        out.push({
          imageKey: img.key,
          categoryId: gt.categoryId,
          score: round(0.3 + rng() * 0.3),
          x,
          y,
          w,
          h,
        });
      }
    }
    if (rng() < backgroundRate) {
      const w = 10;
      const h = 10;
      out.push({
        imageKey: img.key,
        categoryId: catIds[0]!,
        score: round(rng() * 0.6),
        x: Math.floor(rng() * (img.width - w)),
        y: Math.floor(rng() * (img.height - h)),
        w,
        h,
      });
    }
  }
  return out;
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Perfect prediction set: every GT reproduced exactly with score 1. */
export function perfectPredictions(dataset: GeneratedDataset): GeneratedPrediction[] {
  const out: GeneratedPrediction[] = [];
  for (const img of dataset.images) {
    for (const gt of img.boxes) {
      out.push({ imageKey: img.key, categoryId: gt.categoryId, score: 1, ...pickBox(gt) });
    }
  }
  return out;
}

function pickBox(b: { x: number; y: number; w: number; h: number }) {
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}
