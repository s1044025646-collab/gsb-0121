export type PositiveInt = number;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GtBoxRow extends Box {
  id: number;
  imageId: number;
  categoryId: number;
}

export interface PredBoxRow extends Box {
  id: number;
  imageId: number;
  categoryId: number;
  score: number;
}

export interface ClassMappingEntry {
  id: number;
  name: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  ref?: string;
}

export type ErrorKind =
  | "missed"
  | "duplicate"
  | "localization"
  | "wrong_class"
  | "background_fp";

export interface MatchRecord {
  imageId: number;
  categoryId: number;
  gtId: number | null;
  predId: number | null;
  iou: number;
  tp: boolean;
  errorKind: ErrorKind | null;
  score: number | null;
  detail: string;
}

export interface PrPoint {
  threshold: number;
  precision: number;
  recall: number;
  tp: number;
  fp: number;
  fn: number;
}

export interface ClassApResult {
  categoryId: number;
  name: string | null;
  numGt: number;
  ap: number;
  pr: PrPoint[];
  interpolatedPrecision: number[];
}

export interface EvalSummary {
  reportId: number;
  datasetVersionId: number;
  modelVersionId: number;
  protocolId: number;
  iouThreshold: number;
  map: number;
  evaluatedClasses: number;
  classesWithGt: number;
  totalTp: number;
  totalFp: number;
  totalFn: number;
  perClass: ClassApResult[];
}

export interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
