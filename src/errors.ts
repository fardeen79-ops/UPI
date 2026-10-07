export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VPA_NOT_FOUND"
  | "VPA_TAKEN"
  | "PIN_NOT_SET"
  | "PIN_ALREADY_SET"
  | "INVALID_PIN"
  | "PIN_LOCKED"
  | "INSUFFICIENT_FUNDS"
  | "LIMIT_EXCEEDED"
  | "SAME_ACCOUNT"
  | "COLLECT_NOT_PENDING"
  | "COLLECT_EXPIRED"
  | "IDEMPOTENCY_MISMATCH";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VPA_NOT_FOUND: 404,
  VPA_TAKEN: 409,
  PIN_NOT_SET: 409,
  PIN_ALREADY_SET: 409,
  INVALID_PIN: 401,
  PIN_LOCKED: 423,
  INSUFFICIENT_FUNDS: 422,
  LIMIT_EXCEEDED: 422,
  SAME_ACCOUNT: 422,
  COLLECT_NOT_PENDING: 409,
  COLLECT_EXPIRED: 410,
  IDEMPOTENCY_MISMATCH: 409,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}
