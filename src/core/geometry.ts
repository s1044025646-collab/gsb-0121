import type { Box } from "./types.ts";
import { AppError } from "./errors.ts";

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function boxArea(b: Box): number {
  return b.w * b.h;
}

export function intersectionArea(a: Box, b: Box): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const iw = Math.min(ax2, bx2) - Math.max(a.x, b.x);
  const ih = Math.min(ay2, by2) - Math.max(a.y, b.y);
  if (iw <= 0 || ih <= 0) return 0;
  return iw * ih;
}

/** Strict IoU. Never divides by zero: both inputs are validated positive-area. */
export function iou(a: Box, b: Box): number {
  const inter = intersectionArea(a, b);
  if (inter === 0) return 0;
  const union = boxArea(a) + boxArea(b) - inter;
  if (union <= 0) {
    throw new AppError("INVALID_BOX", "IoU union is non-positive; boxes must have positive area.");
  }
  return inter / union;
}

export function boxRight(b: Box): number {
  return b.x + b.w;
}
export function boxBottom(b: Box): number {
  return b.y + b.h;
}

/**
 * Validate a box against image dimensions.
 * Out-of-bounds and non-positive dimensions are hard errors (never silently clipped).
 */
export function validateBoxInImage(
  b: Box,
  imgW: number,
  imgH: number,
  ref: string,
): void {
  if (!isFiniteNumber(b.x) || !isFiniteNumber(b.y) || !isFiniteNumber(b.w) || !isFiniteNumber(b.h)) {
    throw new AppError("INVALID_BOX", `Box at ${ref} has non-finite coordinates.`);
  }
  if (b.w <= 0 || b.h <= 0) {
    throw new AppError(
      "INVALID_BOX",
      `Box at ${ref} has non-positive size (w=${b.w}, h=${b.h}); clipping is not permitted.`,
    );
  }
  if (b.x < 0 || b.y < 0) {
    throw new AppError(
      "BOX_OUT_OF_BOUNDS",
      `Box at ${ref} starts outside the image (x=${b.x}, y=${b.y}).`,
    );
  }
  if (boxRight(b) > imgW + 1e-9 || boxBottom(b) > imgH + 1e-9) {
    throw new AppError(
      "BOX_OUT_OF_BOUNDS",
      `Box at ${ref} exceeds image bounds (right=${boxRight(b)} > ${imgW} or bottom=${boxBottom(b)} > ${imgH}).`,
    );
  }
}
