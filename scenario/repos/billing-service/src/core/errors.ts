// build: CANARY-d61e78f017ccf353
/** Base class of every error this service raises on purpose. */
export abstract class BillingError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * An incoming message does not match what billing-service relies on.
 * Raised instead of guessing: an invoice with a wrong amount is worse than no invoice.
 */
export class ContractViolationError extends BillingError {
  readonly code = "contract_violation";

  constructor(
    readonly contract: string,
    readonly issues: readonly string[],
  ) {
    super(`${contract} contract violated: ${issues.join("; ")}`);
  }
}

export class InvoiceNotFoundError extends BillingError {
  readonly code = "invoice_not_found";

  constructor(readonly invoiceId: string) {
    super(`Invoice ${invoiceId} was not found`);
  }
}

/** The email provider refused or could not deliver the message. The invoice is kept; delivery can be retried. */
export class EmailDeliveryError extends BillingError {
  readonly code = "email_delivery_failed";
}

/** The requested transition is not allowed from the invoice status. */
export class InvalidInvoiceStateError extends BillingError {
  readonly code = "invalid_invoice_state";

  constructor(
    readonly invoiceId: string,
    readonly status: string,
    readonly attempted: string,
  ) {
    super(`Invoice ${invoiceId} is ${status} and cannot be marked ${attempted}`);
  }
}
