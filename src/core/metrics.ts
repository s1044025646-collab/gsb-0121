import { matchClass, type MatchThresholds } from "./matching.ts";
import type {
  ClassApResult,
  GtBoxRow,
  MatchRecord,
  PredBoxRow,
  PrPoint,
} from "./types.ts";

/**
 * Build the precision/recall curve by sweeping predictions in their
 * stable ranked order. The point at rank k uses the score of the k-th
 * prediction as the operating threshold (>= score), with precision and
 * recall computed against all GT of the class.
 */
export function buildPrCurve(records: MatchRecord[], numGt: number): PrPoint[] {
  const ranked = records
    .filter((r) => r.predId !== null)
    .sort((a, b) => {
      const sa = a.score ?? -1;
      const sb = b.score ?? -1;
      if (sb !== sa) return sb - sa;
      if (a.imageId !== b.imageId) return a.imageId - b.imageId;
      return (a.predId ?? 0) - (b.predId ?? 0);
    });

  const points: PrPoint[] = [];
  let tp = 0;
  let fp = 0;
  for (const r of ranked) {
    if (r.tp) tp += 1;
    else fp += 1;
    const precision = tp / (tp + fp);
    const recall = numGt === 0 ? 0 : tp / numGt;
    points.push({
      threshold: r.score ?? 0,
      precision,
      recall,
      tp,
      fp,
      fn: numGt - tp,
    });
  }
  return points;
}

/**
 * PASCAL VOC 11-point interpolation.
 * p_inter(r_j) = max precision at any recall >= r_j,
 * for r_j in {0, 0.1, ..., 1.0}. AP = mean of the 11 values.
 */
export function interpolatedAp11(
  pr: PrPoint[],
  numGt: number,
): { ap: number; interpolatedPrecision: number[] } {
  const maxAt = (recallFloor: number): number => {
    let best = 0;
    for (const p of pr) {
      if (p.recall + 1e-12 >= recallFloor && p.precision > best) best = p.precision;
    }
    return best;
  };

  const interp: number[] = [];
  let sum = 0;
  for (let k = 0; k <= 10; k += 1) {
    const recallLevel = k / 10;
    const value = numGt === 0 ? 0 : maxAt(recallLevel);
    interp.push(value);
    sum += value;
  }
  return { ap: sum / 11, interpolatedPrecision: interp };
}

export function evaluateClass(
  categoryId: number,
  name: string | null,
  gts: GtBoxRow[],
  preds: PredBoxRow[],
  thresholds: MatchThresholds,
): { result: ClassApResult; records: MatchRecord[] } {
  const classGt = gts.filter((g) => g.categoryId === categoryId);
  const records = matchClass(categoryId, gts, preds, thresholds);
  const pr = buildPrCurve(records, classGt.length);
  const { ap, interpolatedPrecision } = interpolatedAp11(pr, classGt.length);
  const result: ClassApResult = {
    categoryId,
    name,
    numGt: classGt.length,
    ap,
    pr,
    interpolatedPrecision,
  };
  return { result, records };
}

/**
 * mAP summary rule: AP is averaged only over classes that have at least
 * one GT box ("present classes"). Classes with no GT target keep AP 0,
 * are reported separately, and never enter the mean (avoids rewarding or
 * punishing a class that cannot be recalled).
 */
export function meanAp(perClass: ClassApResult[]): {
  map: number;
  classesWithGt: number;
} {
  const present = perClass.filter((c) => c.numGt > 0);
  if (present.length === 0) return { map: 0, classesWithGt: 0 };
  const sum = present.reduce((acc, c) => acc + c.ap, 0);
  return { map: sum / present.length, classesWithGt: present.length };
}
