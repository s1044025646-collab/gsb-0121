import { iou } from "./geometry.ts";
import type {
  ErrorKind,
  GtBoxRow,
  MatchRecord,
  PredBoxRow,
} from "./types.ts";

export interface MatchThresholds {
  /** IoU at/above which a same-class pair counts as a true positive. */
  match: number;
  /** IoU at/above which an unmatched prediction overlapping another class is called wrong_class. */
  wrongClass: number;
  /** IoU at/above which an unmatched prediction overlapping an already-matched same-class GT is a duplicate. */
  duplicate: number;
}

export const DEFAULT_THRESHOLDS: MatchThresholds = {
  match: 0.5,
  wrongClass: 0.1,
  duplicate: 0.5,
};

interface RankedPred extends PredBoxRow {
  order: number;
}

/**
 * One-to-one greedy matching with an explicit, deterministic tie-break:
 * score DESC, then imageId ASC, then prediction id ASC (insertion order).
 * A ground-truth box can be claimed at most once.
 */
export function matchClass(
  categoryId: number,
  gts: GtBoxRow[],
  preds: PredBoxRow[],
  t: MatchThresholds,
): MatchRecord[] {
  const classGt = gts.filter((g) => g.categoryId === categoryId);
  const otherGt = gts.filter((g) => g.categoryId !== categoryId);

  const ranked: RankedPred[] = preds
    .filter((p) => p.categoryId === categoryId)
    .map((p, idx) => ({ ...p, order: idx }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.imageId !== b.imageId) return a.imageId - b.imageId;
      if (a.id !== b.id) return a.id - b.id;
      return a.order - b.order;
    });

  const claimed = new Set<number>();
  const records: MatchRecord[] = [];

  for (const pred of ranked) {
    const sameInImage = classGt.filter((g) => g.imageId === pred.imageId);
    const otherInImage = otherGt.filter((g) => g.imageId === pred.imageId);

    let bestUnmatched: GtBoxRow | null = null;
    let bestUnmatchedIou = -1;
    let bestAny: GtBoxRow | null = null;
    let bestAnyIou = -1;
    for (const gt of sameInImage) {
      const v = iou(pred, gt);
      if (v > bestAnyIou) {
        bestAnyIou = v;
        bestAny = gt;
      }
      if (!claimed.has(gt.id) && v > bestUnmatchedIou) {
        bestUnmatchedIou = v;
        bestUnmatched = gt;
      }
    }

    let bestOtherIou = -1;
    let bestOther: GtBoxRow | null = null;
    for (const gt of otherInImage) {
      const v = iou(pred, gt);
      if (v > bestOtherIou) {
        bestOtherIou = v;
        bestOther = gt;
      }
    }

    if (bestUnmatched && bestUnmatchedIou >= t.match) {
      claimed.add(bestUnmatched.id);
      records.push({
        imageId: pred.imageId,
        categoryId,
        gtId: bestUnmatched.id,
        predId: pred.id,
        iou: round(bestUnmatchedIou),
        tp: true,
        errorKind: null,
        score: pred.score,
        detail: `Matched gt#${bestUnmatched.id} with IoU ${bestUnmatchedIou.toFixed(4)}.`,
      });
      continue;
    }

    let kind: ErrorKind;
    let detail: string;
    let gtId: number | null = null;

    if (bestOther && bestOtherIou >= t.wrongClass) {
      kind = "wrong_class";
      gtId = bestOther.id;
      detail = `Predicted class ${categoryId} overlaps gt#${bestOther.id} (class ${bestOther.categoryId}) at IoU ${bestOtherIou.toFixed(4)}.`;
    } else if (bestAny && bestAnyIou >= t.duplicate && claimed.has(bestAny.id)) {
      kind = "duplicate";
      gtId = bestAny.id;
      detail = `Overlaps already-matched gt#${bestAny.id} at IoU ${bestAnyIou.toFixed(4)} (match IoU threshold ${t.match}); redundant box.`;
    } else if (bestAny && bestAnyIou > 0) {
      kind = "localization";
      gtId = bestAny.id;
      detail = `Same-class gt#${bestAny.id} nearby but IoU ${bestAnyIou.toFixed(4)} is below match threshold ${t.match}.`;
    } else {
      kind = "background_fp";
      detail = "No overlapping ground truth; prediction on empty/background region.";
    }

    records.push({
      imageId: pred.imageId,
      categoryId,
      gtId,
      predId: pred.id,
      iou: round(Math.max(bestAnyIou, bestOtherIou, 0)),
      tp: false,
      errorKind: kind,
      score: pred.score,
      detail,
    });
  }

  for (const gt of classGt) {
    if (!claimed.has(gt.id)) {
      records.push({
        imageId: gt.imageId,
        categoryId,
        gtId: gt.id,
        predId: null,
        iou: 0,
        tp: false,
        errorKind: "missed",
        score: null,
        detail: `Ground truth gt#${gt.id} was never matched by any prediction at IoU >= ${t.match}.`,
      });
    }
  }

  return records;
}

function round(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}
