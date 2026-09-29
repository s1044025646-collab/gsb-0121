import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrCurve, interpolatedAp11, evaluateClass, meanAp } from "./metrics.ts";
import { DEFAULT_THRESHOLDS } from "./matching.ts";
import type { GtBoxRow, PredBoxRow } from "./types.ts";

function gt(id: number, imageId: number, categoryId = 1, b = { x: 0, y: 0, w: 10, h: 10 }): GtBoxRow {
  return { id, imageId, categoryId, ...b };
}
function pred(
  id: number,
  imageId: number,
  score: number,
  categoryId = 1,
  b = { x: 0, y: 0, w: 10, h: 10 },
): PredBoxRow {
  return { id, imageId, categoryId, score, ...b };
}

test("perfect prediction yields AP 1 and PR (1,1)", () => {
  const gts = [gt(1, 1), gt(2, 2)];
  const preds = [pred(1, 1, 0.9), pred(2, 2, 0.8)];
  const { result, records } = evaluateClass(1, "cat", gts, preds, DEFAULT_THRESHOLDS);
  assert.equal(records.filter((r) => r.tp).length, 2);
  assert.deepEqual(result.pr.map((p) => [p.precision, p.recall]), [[1, 0.5], [1, 1]]);
  assert.equal(result.ap, 1);
});

test("all-missed yields AP 0 and only missed records", () => {
  const gts = [gt(1, 1)];
  const { result, records } = evaluateClass(1, "cat", gts, [], DEFAULT_THRESHOLDS);
  assert.equal(result.ap, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.errorKind, "missed");
});

test("one TP at recall 0.5 and one FP gives hand-checked 11-point AP", () => {
  const gts = [gt(1, 1), gt(2, 2)];
  const preds = [pred(1, 1, 0.9), pred(2, 3, 0.8)];
  const { result } = evaluateClass(1, "cat", gts, preds, DEFAULT_THRESHOLDS);
  const pr = buildPrCurve(
    evaluateClass(1, "cat", gts, preds, DEFAULT_THRESHOLDS).records,
    2,
  );
  assert.deepEqual(
    pr.map((p) => [p.precision, p.recall]),
    [[1, 0.5], [0.5, 0.5]],
  );
  const { ap } = interpolatedAp11(pr, 2);
  assert.equal(ap, 6 / 11);
  assert.equal(Math.round(result.ap * 1e9) / 1e9, Math.round((6 / 11) * 1e9) / 1e9);
});

test("tie scores keep a stable insertion/image order and one-to-one GT claim", () => {
  const gts = [
    gt(1, 1, 1, { x: 0, y: 0, w: 10, h: 10 }),
  ];
  const preds = [
    pred(10, 1, 0.5, 1, { x: 0, y: 0, w: 10, h: 10 }),
    pred(11, 1, 0.5, 1, { x: 0, y: 0, w: 10, h: 10 }),
  ];
  const first = evaluateClass(1, "cat", gts, preds, DEFAULT_THRESHOLDS).records;
  const second = evaluateClass(1, "cat", gts, [preds[1]!, preds[0]!], DEFAULT_THRESHOLDS).records;
  assert.deepEqual(
    first.map((r) => r.predId),
    second.map((r) => r.predId),
  );
  assert.equal(first.filter((r) => r.tp).length, 1);
  const fp = first.find((r) => r.predId !== null && !r.tp);
  assert.equal(fp?.errorKind, "duplicate");
  assert.equal(fp?.predId, 11);
});

test("dense overlapping targets: each GT claimed at most once", () => {
  const gts = [
    gt(1, 1, 1, { x: 0, y: 0, w: 10, h: 10 }),
    gt(2, 1, 1, { x: 1, y: 1, w: 10, h: 10 }),
  ];
  const preds = [
    pred(10, 1, 0.9, 1, { x: 0, y: 0, w: 10, h: 10 }),
    pred(11, 1, 0.8, 1, { x: 0, y: 0, w: 10, h: 10 }),
  ];
  const { records } = evaluateClass(1, "cat", gts, preds, DEFAULT_THRESHOLDS);
  const claimedGt = records.filter((r) => r.tp).map((r) => r.gtId);
  assert.equal(new Set(claimedGt).size, claimedGt.length);
});

test("wrong class, localization and background are attributed distinctly", () => {
  const gts = [gt(1, 1, 1, { x: 0, y: 0, w: 10, h: 10 })];
  const wrongClass = pred(10, 1, 0.9, 2);
  const loc = pred(11, 1, 0.7, 1, { x: 8, y: 0, w: 10, h: 10 });
  const bg = pred(12, 2, 0.6, 1);
  const cat1 = evaluateClass(1, "cat", gts, [wrongClass, loc, bg], DEFAULT_THRESHOLDS).records;
  const cat2 = evaluateClass(2, "dog", gts, [wrongClass, loc, bg], DEFAULT_THRESHOLDS).records;
  const kinds = [
    ...cat1.filter((r) => r.predId !== null).map((r) => r.errorKind),
    ...cat2.filter((r) => r.predId !== null).map((r) => r.errorKind),
  ];
  assert.ok(kinds.includes("wrong_class"));
  assert.ok(kinds.includes("localization"));
  assert.ok(kinds.includes("background_fp"));
  assert.ok(cat1.some((r) => r.errorKind === "missed"));
});

test("mean AP ignores classes with no ground truth", () => {
  const { map, classesWithGt } = meanAp([
    { categoryId: 1, name: "a", numGt: 2, ap: 1, pr: [], interpolatedPrecision: [] },
    { categoryId: 2, name: "b", numGt: 0, ap: 0, pr: [], interpolatedPrecision: [] },
  ]);
  assert.equal(map, 1);
  assert.equal(classesWithGt, 1);
});
