import type { Box } from './types.js';

export function intersectionArea(a: Box, b: Box): number {
  const iw = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const tw = Math.max(a.right, b.right) - Math.min(a.left, b.left);
  const ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const th = Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top);
  if (iw <= 0 || ih <= 0) return 0;
  // Guard against any non-finite geometry leaking through.
  if (!Number.isFinite(iw) || !Number.isFinite(ih) || !Number.isFinite(tw) || !Number.isFinite(th) || tw <= 0 || th <= 0) {
    return 0;
  }
  return iw * ih;
}

export function boxArea(b: Box): number {
  return (b.right - b.left) * (b.bottom - b.top);
}

export function iou(a: Box, b: Box): number {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const union = boxArea(a) + boxArea(b) - inter;
  if (union <= 0 || !Number.isFinite(union)) return 0;
  return inter / union;
}
