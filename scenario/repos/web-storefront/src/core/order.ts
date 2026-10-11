// build: CANARY-bab633003b4a7775
/** An order line as the storefront needs it. */
export interface OrderLine {
  readonly sku: string;
  readonly name: string;
  readonly qty: number;
  /** Integer, minor units. */
  readonly unitPriceCents: number;
}

/** An order as the storefront needs it: the fields it reads from `GET /orders/{id}`. */
export interface Order {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  /** Integer, minor units. */
  readonly totalCents: number;
  readonly lines: readonly OrderLine[];
}

export function isCancellable(order: Pick<Order, "status">): boolean {
  return order.status === "placed";
}

/** Shopper-facing label for an order status; unknown statuses are shown capitalized as-is. */
export function statusLabel(status: string): string {
  switch (status) {
    case "placed":
      return "Order placed";
    case "cancelled":
      return "Cancelled";
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}
