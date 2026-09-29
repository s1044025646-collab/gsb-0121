import { describe, expect, it } from 'vitest';
import { buildPrCurve, evaluate, type EvalImage } from '../src/eval.js';

const opts = (overrides = {}) => ({
  iouThresholds: [0.5],
  interpolation: 'all_point' as const,
  excludeClassesWithoutGt: true,
  generatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('hand-computed AP', () => {
  it('perfect single prediction gives AP 1', () => {
    const images: EvalImage[] = [
      {
        externalId: 'i',
        width: 100,
        height: 100,
        gt: [{ left: 0, top: 0, right: 10, bottom: 10, category: 'a' }],
        predictions: [{ left: 0, top: 0, right: 10, bottom: 10, category: 'a', confidence: 0.9 }],
      },
    ];
    const report = evaluate(images, opts());
    expect(report.mAP).toBe(1);
    expect(report.mAPPerThreshold).toEqual([1]);
    expect(report.errors).toHaveLength(0);
  });

  it('computes the classic 2-recall-level curve by hand', () => {
    // One class, two GT. Ranked predictions: FP(0.9), TP(0.8), TP(0.7).
    // Raw precision: 0, 1/2, 2/3. Tail envelope: 2/3, 2/3, 2/3.
    // Recalls: 0 (FP), 1/2, 1.
    // all-point AP = (1/2)*(2/3) + (1/2)*(2/3) = 2/3.
    const gt1 = { left: 0, top: 0, right: 10, bottom: 10, category: 'a' };
    const gt2 = { left: 20, top: 20, right: 30, bottom: 30, category: 'a' };
    const images: EvalImage[] = [
      {
        externalId: 'i1',
        width: 100,
        height: 100,
        gt: [gt1, gt2],
        predictions: [
          { left: 50, top: 50, right: 60, bottom: 60, category: 'a', confidence: 0.9 },
          { ...gt1, confidence: 0.8 },
          { ...gt2, confidence: 0.7 },
        ],
      },
    ];
    const report = evaluate(images, opts());
    expect(report.mAP).toBeCloseTo(2 / 3, 6);
    const curve = report.perClass[0].prCurves['0.5'];
    expect(curve.map((p) => [p.recall, p.precision])).toEqual([
      [0, 2 / 3],
      [0.5, 2 / 3],
      [1, 2 / 3],
    ]);
    // The leading FP is attributable.
    expect(report.errors.some((e) => e.type === 'background_fp')).toBe(true);
  });

  it('buildPrCurve is empty/AP 0 when the class has no GT', () => {
    const { points, ap } = buildPrCurve([], 0, 'all_point');
    expect(points).toEqual([]);
    expect(ap).toBe(0);
  });

  it('all misses yields AP 0 and one missed_gt per GT', () => {
    const images: EvalImage[] = [
      {
        externalId: 'i',
        width: 100,
        height: 100,
        gt: [{ left: 0, top: 0, right: 10, bottom: 10, category: 'a' }],
        predictions: [],
      },
    ];
    const report = evaluate(images, opts());
    expect(report.mAP).toBe(0);
    expect(report.errors).toEqual([
      expect.objectContaining({ type: 'missed_gt', category: 'a' }),
    ]);
  });
});

describe('matching attribution', () => {
  const gt = { left: 0, top: 0, right: 10, bottom: 10, category: 'a' };

  it('flags duplicate predictions (one GT matched once)', () => {
    // The higher-scoring box claims the GT first; the second box is an FP at
    // recall 0, dragging the interpolated AP below 1.
    const images: EvalImage[] = [
      {
        externalId: 'i',
        width: 100,
        height: 100,
        gt: [gt],
        predictions: [
          { left: 1, top: 1, right: 11, bottom: 11, category: 'a', confidence: 0.9 },
          { ...gt, confidence: 0.8 },
        ],
      },
    ];
    const report = evaluate(images, opts());
    // The TP is ranked before the low-score duplicate; under the standard
    // tail-envelope interpolation an FP after the last reached recall level
    // does not reduce AP (still 1), but the duplicate is fully attributable.
    expect(report.mAP).toBe(1);
    expect(report.errors.some((e) => e.type === 'duplicate')).toBe(true);
  });

  it('flags localization errors when IoU is below threshold', () => {
    // Shift by ~0.8 of width keeps IoU > 0 but < 0.5.
    const images: EvalImage[] = [
      {
        externalId: 'i',
        width: 100,
        height: 100,
        gt: [gt],
        predictions: [{ left: 8, top: 0, right: 18, bottom: 10, category: 'a', confidence: 0.9 }],
      },
    ];
    const report = evaluate(images, opts());
    expect(report.mAP).toBe(0);
    expect(report.errors[0].type).toBe('localization');
    expect(report.errors[0].iou).toBeGreaterThan(0);
    expect(report.errors[0].iou).toBeLessThan(0.5);
  });

  it('flags wrong-class predictions', () => {
    const images: EvalImage[] = [
      {
        externalId: 'i',
        width: 100,
        height: 100,
        gt: [gt],
        predictions: [{ ...gt, category: 'b', confidence: 0.9 }],
      },
    ];
    const report = evaluate(images, opts());
    expect(report.errors.some((e) => e.type === 'wrong_class' && e.expectedCategory === 'a')).toBe(true);
    // Class 'a' GT is unmatched -> missed; class 'b' has no GT (excluded).
    expect(report.errors.some((e) => e.type === 'missed_gt' && e.category === 'a')).toBe(true);
  });

  it('resolves equal-confidence predictions by stable image/input order', () => {
    // Two GTs, two identical-score preds, only the first-in-order overlaps GT1.
    const images: EvalImage[] = [
      {
        externalId: 'i0',
        width: 200,
        height: 100,
        gt: [
          { left: 0, top: 0, right: 10, bottom: 10, category: 'a' },
          { left: 100, top: 0, right: 110, bottom: 10, category: 'a' },
        ],
        predictions: [
          { left: 0, top: 0, right: 10, bottom: 10, category: 'a', confidence: 0.5 },
          { left: 100, top: 0, right: 110, bottom: 10, category: 'a', confidence: 0.5 },
        ],
      },
    ];
    const r1 = evaluate(images, opts());
    const shuffled: EvalImage[] = [
      {
        ...images[0],
        predictions: [images[0].predictions[1], images[0].predictions[0]],
      },
    ];
    // With both boxes matching distinct GTs order does not change AP; but verify
    // determinism: replaying identical input twice gives identical payloads.
    const r2 = evaluate(images, opts());
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r1.mAP).toBe(1);
    // Shuffling input order while boxes still match distinct GT leaves AP 1 too,
    // but tie-break determinism is what guarantees replay equality.
    expect(evaluate(shuffled, opts()).mAP).toBe(1);
  });

  it('handles dense overlapping targets one-to-one', () => {
    // Three heavily overlapping GTs in one image; 3 correct + 1 duplicate pred.
    const gts = [
      { left: 0, top: 0, right: 20, bottom: 20, category: 'a' },
      { left: 2, top: 0, right: 22, bottom: 20, category: 'a' },
      { left: 4, top: 0, right: 24, bottom: 20, category: 'a' },
    ];
    const images: EvalImage[] = [
      {
        externalId: 'i',
        width: 100,
        height: 100,
        gt: gts,
        predictions: [
          { ...gts[0], confidence: 0.9 },
          { ...gts[1], confidence: 0.8 },
          { ...gts[2], confidence: 0.7 },
          { ...gts[0], confidence: 0.6 },
        ],
      },
    ];
    const report = evaluate(images, opts());
    expect(report.perClass[0].numGt).toBe(3);
    const dupes = report.errors.filter((e) => e.type === 'duplicate');
    expect(dupes).toHaveLength(1);
  });
});

describe('mAP over multiple thresholds and classes', () => {
  it('averages classes then thresholds', () => {
    const images: EvalImage[] = [
      {
        externalId: 'i',
        width: 200,
        height: 100,
        gt: [
          { left: 0, top: 0, right: 10, bottom: 10, category: 'a' },
          { left: 100, top: 0, right: 110, bottom: 10, category: 'b' },
        ],
        predictions: [
          { left: 0, top: 0, right: 10, bottom: 10, category: 'a', confidence: 0.9 },
          // 'b' slightly shifted: IoU with 10x10 shifted 4 => 6/(100+100-36)=0.375
          { left: 104, top: 0, right: 114, bottom: 10, category: 'b', confidence: 0.9 },
        ],
      },
    ];
    const report = evaluate(images, opts({ iouThresholds: [0.5, 0.3] }));
    // Thresholds are sorted ascending: @0.3 both pass -> 1; @0.5 only a -> 0.5.
    expect(report.mAPPerThreshold[0]).toBeCloseTo(1, 9);
    expect(report.mAPPerThreshold[1]).toBeCloseTo(0.5, 9);
    expect(report.mAP).toBeCloseTo(0.75, 9);
  });

  it('11-point interpolation gives 1 for perfect detection', () => {
    const images: EvalImage[] = [
      {
        externalId: 'i',
        width: 100,
        height: 100,
        gt: [{ left: 0, top: 0, right: 10, bottom: 10, category: 'a' }],
        predictions: [{ left: 0, top: 0, right: 10, bottom: 10, category: 'a', confidence: 0.9 }],
      },
    ];
    expect(evaluate(images, opts({ interpolation: '11_point' })).mAP).toBe(1);
  });

  it('empty images contribute no FP when there are no predictions', () => {
    const images: EvalImage[] = [
      { externalId: 'empty', width: 100, height: 100, gt: [], predictions: [] },
      {
        externalId: 'full',
        width: 100,
        height: 100,
        gt: [{ left: 0, top: 0, right: 10, bottom: 10, category: 'a' }],
        predictions: [{ left: 0, top: 0, right: 10, bottom: 10, category: 'a', confidence: 0.9 }],
      },
    ];
    const report = evaluate(images, opts());
    expect(report.mAP).toBe(1);
    expect(report.errors).toHaveLength(0);
  });
});
