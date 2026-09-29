export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const ERROR_STATUS: Record<string, number> = {
  VALIDATION: 400,
  INVALID_BOX: 422,
  BOX_OUT_OF_BOUNDS: 422,
  INVALID_DIMENSION: 422,
  INVALID_SCORE: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RULE_MISMATCH: 409,
  FROZEN: 409,
  INVALID_PAGINATION: 400,
  INVALID_JSON: 400,
};
