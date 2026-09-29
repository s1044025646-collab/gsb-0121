export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_DIMENSION'
  | 'OUT_OF_BOUNDS'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_REPLAY'
  | 'RULE_MISMATCH'
  | 'BAD_REQUEST';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}
