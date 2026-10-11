/**
 * Domain errors. The API layer maps them to HTTP statuses (see api/errorMapper.ts);
 * the core never knows about HTTP.
 */

export interface ValidationIssue {
  /** Dotted path of the offending input, e.g. `lines[1].qty`. */
  readonly path: string;
  readonly message: string;
}

export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The input does not describe a valid order. Carries every issue found, not just the first. */
export class ValidationError extends DomainError {
  readonly code = "validation_failed";

  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      `Validation failed: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
}

export class OrderNotFoundError extends DomainError {
  readonly code = "order_not_found";

  constructor(readonly orderId: string) {
    super(`Order ${orderId} was not found`);
  }
}

/** The requested transition is not allowed from the order's current status. */
export class InvalidStateError extends DomainError {
  readonly code = "invalid_state";

  constructor(
    readonly orderId: string,
    readonly status: string,
    readonly attempted: string,
  ) {
    super(`Order ${orderId} is ${status} and cannot be ${attempted}`);
  }
}

/** The payment provider answered and refused the authorization. */
export class PaymentDeclinedError extends DomainError {
  readonly code = "payment_declined";

  constructor(
    readonly orderId: string,
    readonly reason: string,
  ) {
    super(`Payment for order ${orderId} was declined: ${reason}`);
  }
}

/** The payment provider could not be reached or answered with a server error. */
export class PaymentUnavailableError extends DomainError {
  readonly code = "payment_unavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
