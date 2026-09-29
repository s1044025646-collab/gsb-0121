import { AppError } from './errors.js';
import type { Box, GtBox, ImageInput, PredictionInput, PredBox } from './types.js';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate one box and check it against the image dimensions.
 * Out-of-range boxes are rejected (OUT_OF_BOUNDS); coordinates are never
 * silently clipped. Zero/negative-area boxes are rejected too.
 */
export function validateBox(
  box: Partial<Box>,
  width: number,
  height: number,
  context: string,
): Box {
  const left = box.left;
  const top = box.top;
  const right = box.right;
  const bottom = box.bottom;
  if (
    left === undefined ||
    top === undefined ||
    right === undefined ||
    bottom === undefined ||
    ![left, top, right, bottom].every(isFiniteNumber)
  ) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${context}: coordinates left/top/right/bottom must all be finite numbers`,
      box,
    );
  }
  if (right <= left || bottom <= top) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${context}: box must have strictly positive area (left<right, top<bottom)`,
      box,
    );
  }
  if (
    left < 0 ||
    top < 0 ||
    right > width ||
    bottom > height
  ) {
    throw new AppError(
      'OUT_OF_BOUNDS',
      `${context}: box [${left},${top},${right},${bottom}] is outside image ${width}x${height}`,
      { box, width, height },
    );
  }
  return { left, top, right, bottom };
}

export function validateDimension(width: unknown, height: unknown, context: string) {
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) {
    throw new AppError('INVALID_DIMENSION', `${context}: width/height must be finite numbers`, {
      width,
      height,
    });
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new AppError(
      'INVALID_DIMENSION',
      `${context}: width/height must be positive integers`,
      { width, height },
    );
  }
  return { width, height };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function validateImages(input: unknown): ImageInput[] {
  if (!Array.isArray(input)) {
    throw new AppError('VALIDATION_ERROR', 'images must be an array');
  }
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const ctx = `images[${i}]`;
    if (!raw || typeof raw !== 'object') {
      throw new AppError('VALIDATION_ERROR', `${ctx} must be an object`);
    }
    const r = raw as Record<string, unknown>;
    if (!isNonEmptyString(r.externalId)) {
      throw new AppError('VALIDATION_ERROR', `${ctx}.externalId must be a non-empty string`);
    }
    if (seen.has(r.externalId)) {
      throw new AppError('CONFLICT', `duplicate image externalId: ${r.externalId}`);
    }
    seen.add(r.externalId);
    const { width, height } = validateDimension(r.width, r.height, ctx);
    if (!Array.isArray(r.gt)) {
      throw new AppError('VALIDATION_ERROR', `${ctx}.gt must be an array (use [] for an empty image)`);
    }
    const gt: GtBox[] = r.gt.map((g, j) => {
      if (!g || typeof g !== 'object') {
        throw new AppError('VALIDATION_ERROR', `${ctx}.gt[${j}] must be an object`);
      }
      const gr = g as Record<string, unknown>;
      if (!isNonEmptyString(gr.category)) {
        throw new AppError('VALIDATION_ERROR', `${ctx}.gt[${j}].category must be a non-empty string`);
      }
      return { ...validateBox(gr as Partial<Box>, width, height, `${ctx}.gt[${j}]`), category: gr.category as string };
    });
    return { externalId: r.externalId as string, width, height, gt };
  });
}

export function validatePredictions(
  input: unknown,
  imageLookup: Map<string, { width: number; height: number }>,
): PredictionInput[] {
  if (!Array.isArray(input)) {
    throw new AppError('VALIDATION_ERROR', 'predictions must be an array');
  }
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const ctx = `predictions[${i}]`;
    if (!raw || typeof raw !== 'object') {
      throw new AppError('VALIDATION_ERROR', `${ctx} must be an object`);
    }
    const r = raw as Record<string, unknown>;
    if (!isNonEmptyString(r.externalId)) {
      throw new AppError('VALIDATION_ERROR', `${ctx}.externalId must be a non-empty string`);
    }
    if (seen.has(r.externalId)) {
      throw new AppError('CONFLICT', `duplicate prediction externalId: ${r.externalId}`);
    }
    seen.add(r.externalId);
    const image = imageLookup.get(r.externalId as string);
    if (!image) {
      throw new AppError('NOT_FOUND', `${ctx}: unknown image externalId ${r.externalId}`);
    }
    if (!Array.isArray(r.boxes)) {
      throw new AppError('VALIDATION_ERROR', `${ctx}.boxes must be an array (use [] for no detections)`);
    }
    const boxes: PredBox[] = r.boxes.map((b, j) => {
      if (!b || typeof b !== 'object') {
        throw new AppError('VALIDATION_ERROR', `${ctx}.boxes[${j}] must be an object`);
      }
      const br = b as Record<string, unknown>;
      if (!isNonEmptyString(br.category)) {
        throw new AppError('VALIDATION_ERROR', `${ctx}.boxes[${j}].category must be a non-empty string`);
      }
      if (!isFiniteNumber(br.confidence) || br.confidence < 0 || br.confidence > 1) {
        throw new AppError(
          'VALIDATION_ERROR',
          `${ctx}.boxes[${j}].confidence must be a number in [0,1]`,
        );
      }
      return {
        ...validateBox(br as Partial<Box>, image.width, image.height, `${ctx}.boxes[${j}]`),
        category: br.category as string,
        confidence: br.confidence,
      };
    });
    return { externalId: r.externalId as string, boxes };
  });
}
