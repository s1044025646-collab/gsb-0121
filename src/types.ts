export interface Box {
  /** Left coordinate in pixels, 0-based, must satisfy left < right. */
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GtBox extends Box {
  category: string;
}

export interface PredBox extends Box {
  category: string;
  confidence: number;
}

export interface ImageInput {
  externalId: string;
  width: number;
  height: number;
  gt: GtBox[];
}

export interface PredictionInput {
  externalId: string;
  boxes: PredBox[];
}

export interface ParsedReport {
  iouThresholds: number[];
  apPerClass: Record<string, number>[];
  mAPPerThreshold: number[];
  mAP: number;
  perClass: {
    category: string;
    numGt: number;
    apByThreshold: Record<string, number>;
    prCurves: Record<string, PrPoint[]>;
  }[];
  errors: ErrorSample[];
  totals: { images: number; gt: number; predictions: number };
  generatedAt: string;
}

export interface PrPoint {
  confidence: number;
  tp: number;
  fp: number;
  precision: number;
  recall: number;
}

export type ErrorType =
  | 'missed_gt'
  | 'duplicate'
  | 'localization'
  | 'wrong_class'
  | 'background_fp';

export interface ErrorSample {
  type: ErrorType;
  imageExternalId: string;
  iouThreshold: number;
  category: string;
  expectedCategory?: string;
  confidence?: number;
  iou?: number;
  gtBox?: Box;
  predBox?: Box;
  detail: string;
}
