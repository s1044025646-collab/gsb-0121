import { iou } from './geometry.js';
import type { Box, ErrorSample, GtBox, ParsedReport, PredBox, PrPoint } from './types.js';

export type Interpolation = 'all_point' | '11_point';

export interface EvalOptions {
  /** IoU thresholds, e.g. [0.5] or [0.5,0.55,...,0.95]. */
  iouThresholds: number[];
  interpolation: Interpolation;
  /**
   * When true (standard mAP convention), classes with zero GT boxes are
   * excluded from the per-threshold mean. When false they contribute AP 0.
   */
  excludeClassesWithoutGt: boolean;
  generatedAt: string;
}

interface IndexedPred extends PredBox {
  imageIdx: number;
  /** Stable position: image index then original index inside that image. */
  order: number;
}

interface ImageGt extends GtBox {
  matched: boolean;
}

export interface EvalImage {
  externalId: string;
  width: number;
  height: number;
  gt: GtBox[];
  predictions: PredBox[];
}

interface MatchResult {
  /** Per ranked-prediction outcome in ranking order. */
  outcomes: PredOutcome[];
  errors: ErrorSample[];
}

interface PredOutcome {
  category: string;
  confidence: number;
  /** true positive for the predicted class at this threshold. */
  tp: boolean;
  imageExternalId: string;
}

/**
 * One-to-one greedy matching at a fixed IoU threshold.
 * Predictions are consumed in confidence (then stable tie-break) order.
 * A prediction can match at most one GT and each GT is claimed at most once.
 */
function matchAtThreshold(
  images: EvalImage[],
  threshold: number,
  ranked: IndexedPred[],
): MatchResult {
  const gtState: ImageGt[][] = images.map((im) => im.gt.map((g) => ({ ...g, matched: false })));
  const outcomes: PredOutcome[] = [];
  const errors: ErrorSample[] = [];

  for (const pred of ranked) {
    const im = images[pred.imageIdx];
    const candidates = gtState[pred.imageIdx];
    // Best unmatched GT of the SAME class above the threshold.
    let best = -1;
    let bestIou = threshold;
    candidates.forEach((g, idx) => {
      if (g.matched || g.category !== pred.category) return;
      const v = iou(g, pred);
      if (v > bestIou) {
        bestIou = v;
        best = idx;
      }
    });

    if (best >= 0) {
      candidates[best].matched = true;
      outcomes.push({ category: pred.category, confidence: pred.confidence, tp: true, imageExternalId: im.externalId });
      continue;
    }

    // False positive: classify the reason using the best overlapping GT.
    let bestAny = -1;
    let bestAnyIou = 0;
    candidates.forEach((g, idx) => {
      if (g.category !== pred.category) return;
      const v = iou(g, pred);
      if (v > bestAnyIou) {
        bestAnyIou = v;
        bestAny = idx;
      }
    });
    let bestOther = -1;
    let bestOtherIou = 0;
    candidates.forEach((g, idx) => {
      if (g.category === pred.category) return;
      const v = iou(g, pred);
      if (v > bestOtherIou) {
        bestOtherIou = v;
        bestOther = idx;
      }
    });

    if (bestAny >= 0 && bestAnyIou >= threshold) {
      // Same-class overlap exists but the GT is already claimed -> duplicate.
      errors.push({
        type: 'duplicate',
        imageExternalId: im.externalId,
        iouThreshold: threshold,
        category: pred.category,
        confidence: pred.confidence,
        iou: round(bestAnyIou),
        gtBox: candidates[bestAny],
        predBox: stripPred(pred),
        detail: `prediction duplicates an already-matched ${pred.category} GT (IoU ${round(bestAnyIou)})`,
      });
    } else if (bestAny >= 0 && bestAnyIou > 0) {
      errors.push({
        type: 'localization',
        imageExternalId: im.externalId,
        iouThreshold: threshold,
        category: pred.category,
        confidence: pred.confidence,
        iou: round(bestAnyIou),
        gtBox: candidates[bestAny],
        predBox: stripPred(pred),
        detail: `prediction overlaps ${pred.category} GT but IoU ${round(bestAnyIou)} < threshold ${threshold}`,
      });
    } else if (bestOther >= 0 && bestOtherIou >= threshold) {
      errors.push({
        type: 'wrong_class',
        imageExternalId: im.externalId,
        iouThreshold: threshold,
        category: pred.category,
        expectedCategory: candidates[bestOther].category,
        confidence: pred.confidence,
        iou: round(bestOtherIou),
        gtBox: candidates[bestOther],
        predBox: stripPred(pred),
        detail: `prediction labeled ${pred.category} but strongly overlaps ${candidates[bestOther].category} GT (IoU ${round(bestOtherIou)})`,
      });
    } else {
      errors.push({
        type: 'background_fp',
        imageExternalId: im.externalId,
        iouThreshold: threshold,
        category: pred.category,
        confidence: pred.confidence,
        iou: round(Math.max(bestAnyIou, bestOtherIou)),
        predBox: stripPred(pred),
        detail: bestAnyIou === 0 && bestOtherIou === 0
          ? 'prediction has no overlap with any GT'
          : `prediction overlaps no GT above threshold ${threshold}`,
      });
    }
    outcomes.push({ category: pred.category, confidence: pred.confidence, tp: false, imageExternalId: im.externalId });
  }

  // Any unmatched GT is a missed detection.
  gtState.forEach((cands, imageIdx) => {
    for (const g of cands) {
      if (!g.matched) {
        errors.push({
          type: 'missed_gt',
          imageExternalId: images[imageIdx].externalId,
          iouThreshold: threshold,
          category: g.category,
          gtBox: { left: g.left, top: g.top, right: g.right, bottom: g.bottom },
          detail: `no prediction matched ${g.category} GT at IoU ${threshold}`,
        });
      }
    }
  });

  return { outcomes, errors };
}

function stripPred(p: IndexedPred): Box {
  return { left: p.left, top: p.top, right: p.right, bottom: p.bottom };
}

export interface PrResult {
  points: PrPoint[];
  ap: number;
}

/**
 * Build the precision/recall curve for one class from ranked outcomes.
 * Precisions are made monotonic by taking the running maximum from the tail
 * (standard interpolation); recall increments by 1/numGt per TP.
 */
export function buildPrCurve(
  outcomes: PredOutcome[],
  numGt: number,
  interpolation: Interpolation,
): PrResult {
  const points: PrPoint[] = [];
  if (numGt <= 0) {
    // No GT: recall is undefined. AP is defined as 0 and the curve is empty.
    return { points, ap: 0 };
  }
  let tp = 0;
  let fp = 0;
  const raw: { confidence: number; tp: number; fp: number; precision: number; recall: number }[] = [];
  for (const o of outcomes) {
    if (o.tp) tp += 1;
    else fp += 1;
    raw.push({
      confidence: o.confidence,
      tp,
      fp,
      precision: tp / (tp + fp),
      recall: tp / numGt,
    });
  }

 // Tail envelope so precision never increases as threshold drops.
  let runningMax = 0;
  const envelope = raw
    .slice()
    .reverse()
    .map((r) => {
      runningMax = Math.max(runningMax, r.precision);
      return { ...r, precision: runningMax };
    })
    .reverse();

  let ap: number;
  if (interpolation === '11_point') {
    // PASCAL VOC 11-point interpolation: mean of p_interp at recall 0..1 step .1.
    let sum = 0;
    for (let k = 0; k <= 10; k += 1) {
      const r = k / 10;
      const hit = envelope.filter((e) => e.recall >= r);
      sum += hit.length ? hit[0].precision : 0;
    }
    ap = sum / 11;
  } else {
    // All-point (COCO-style step) interpolation over unique recall levels:
    // AP = sum (r_n - r_{n-1}) * p_interp(r_n), starting at r_0 = 0.
    let sum = 0;
    let prevRecall = 0;
    for (const e of envelope) {
      if (e.recall > prevRecall) {
        sum += (e.recall - prevRecall) * e.precision;
        prevRecall = e.recall;
      }
    }
    ap = sum;
  }

  return { points: envelope, ap: round(ap) };
}

function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

export function evaluate(images: EvalImage[], opts: EvalOptions): ParsedReport {
  const thresholds = [...opts.iouThresholds].sort((a, b) => a - b);
  // Adapt ImageInput-like list (kept tolerant for internal callers).
  const ranked = rankPredictionsFromEval(images);

  const categories = new Set<string>();
  const gtCountByCategory = new Map<string, number>();
  for (const im of images) {
    for (const g of im.gt) {
      categories.add(g.category);
      gtCountByCategory.set(g.category, (gtCountByCategory.get(g.category) ?? 0) + 1);
    }
    for (const p of im.predictions) categories.add(p.category);
  }

  const apPerClass: Record<string, number>[] = [];
  const mAPPerThreshold: number[] = [];
  const allErrors: ErrorSample[] = [];
  const perClass: ParsedReport['perClass'] = [];

  for (const category of [...categories].sort()) {
    const numGt = gtCountByCategory.get(category) ?? 0;
    const apByThreshold: Record<string, number> = {};
    const prCurves: Record<string, PrPoint[]> = {};
    for (const threshold of thresholds) {
      const { outcomes, errors } = matchAtThreshold(images, threshold, ranked);
      if (threshold === thresholds[0]) allErrors.push(...errors);
      const classOutcomes = outcomes.filter((o) => o.category === category);
      const { points, ap } = buildPrCurve(classOutcomes, numGt, opts.interpolation);
      apByThreshold[String(threshold)] = ap;
      prCurves[String(threshold)] = points;
    }
    perClass.push({ category, numGt, apByThreshold, prCurves });
  }

  for (const threshold of thresholds) {
    const aps = perClass
      .filter((c) => !opts.excludeClassesWithoutGt || c.numGt > 0)
      .map((c) => c.apByThreshold[String(threshold)] ?? 0);
    const mean = aps.length ? aps.reduce((a, b) => a + b, 0) / aps.length : 0;
    mAPPerThreshold.push(round(mean));
    const row: Record<string, number> = {};
    for (const c of perClass) row[c.category] = c.apByThreshold[String(threshold)] ?? 0;
    apPerClass.push(row);
  }

  const mAP = round(mAPPerThreshold.reduce((a, b) => a + b, 0) / (mAPPerThreshold.length || 1));

  return {
    iouThresholds: thresholds,
    apPerClass,
    mAPPerThreshold,
    mAP,
    perClass,
    errors: allErrors,
    totals: {
      images: images.length,
      gt: images.reduce((n, im) => n + im.gt.length, 0),
      predictions: images.reduce((n, im) => n + im.predictions.length, 0),
    },
    generatedAt: opts.generatedAt,
  };
}

function rankPredictionsFromEval(images: EvalImage[]): IndexedPred[] {
  const ranked: IndexedPred[] = [];
  images.forEach((im, imageIdx) => {
    im.predictions.forEach((p, j) => {
      ranked.push({ ...p, imageIdx, order: imageIdx * 1_000_000 + j });
    });
  });
  ranked.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.imageIdx !== b.imageIdx) return a.imageIdx - b.imageIdx;
    return a.order - b.order;
  });
  return ranked;
}
