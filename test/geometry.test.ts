import { describe, expect, it } from 'vitest';
import { iou, intersectionArea } from '../src/geometry.js';

describe('iou', () => {
  it('is 1 for identical boxes', () => {
    const b = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(iou(b, b)).toBe(1);
  });

  it('is 0 for disjoint boxes', () => {
    expect(
      iou(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 20, top: 20, right: 30, bottom: 30 },
      ),
    ).toBe(0);
  });

  it('matches a hand-computed partial overlap', () => {
    // Two 10x10 boxes offset by 5 on both axes: intersection 5x5=25, union 175.
    const v = iou(
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 5, top: 5, right: 15, bottom: 15 },
    );
    expect(v).toBeCloseTo(25 / 175, 9);
    expect(intersectionArea(
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 5, top: 5, right: 15, bottom: 15 },
    )).toBe(25);
  });

  it('handles touching edges with zero intersection', () => {
    expect(
      iou(
        { left: 0, top: 0, right: 10, bottom: 10 },
        { left: 10, top: 0, right: 20, bottom: 10 },
      ),
    ).toBe(0);
  });
});
