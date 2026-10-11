// build: CANARY-bab633003b4a7775
export abstract class StorefrontError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The orders API answered with a body the storefront cannot render safely.
 * Raised instead of showing a blank or wrong total to a shopper.
 */
export class ContractViolationError extends StorefrontError {
  readonly code = "contract_violation";

  constructor(
    readonly contract: string,
    readonly issues: readonly string[],
  ) {
    super(`${contract} contract violated: ${issues.join("; ")}`);
  }
}

export class OrderNotFoundError extends StorefrontError {
  readonly code = "order_not_found";

  constructor(readonly orderId: string) {
    super(`Order ${orderId} was not found`);
  }
}

/** The orders API answered with an unexpected HTTP status. */
export class OrdersApiError extends StorefrontError {
  readonly code = "orders_api_error";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The request never completed (network failure, timeout). */
export class OrdersApiUnavailableError extends StorefrontError {
  readonly code = "orders_api_unavailable";
}
