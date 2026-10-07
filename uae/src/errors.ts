export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RECIPIENT_NOT_FOUND"
  | "PROXY_TAKEN"
  | "PASSCODE_NOT_SET"
  | "PASSCODE_ALREADY_SET"
  | "INVALID_PASSCODE"
  | "PASSCODE_LOCKED"
  | "INSUFFICIENT_FUNDS"
  | "LIMIT_EXCEEDED"
  | "SAME_ACCOUNT"
  | "REQUEST_NOT_PENDING"
  | "REQUEST_EXPIRED"
  | "IDEMPOTENCY_MISMATCH";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RECIPIENT_NOT_FOUND: 404,
  PROXY_TAKEN: 409,
  PASSCODE_NOT_SET: 409,
  PASSCODE_ALREADY_SET: 409,
  INVALID_PASSCODE: 401,
  PASSCODE_LOCKED: 423,
  INSUFFICIENT_FUNDS: 422,
  LIMIT_EXCEEDED: 422,
  SAME_ACCOUNT: 422,
  REQUEST_NOT_PENDING: 409,
  REQUEST_EXPIRED: 410,
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
