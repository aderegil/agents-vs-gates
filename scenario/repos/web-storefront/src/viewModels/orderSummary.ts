// build: CANARY-bab633003b4a7775
import { isCancellable, statusLabel, type Order } from "../core/order.js";
import { formatMoney } from "./money.js";
import { statusBadge, type StatusBadge } from "./statusBadge.js";

export interface OrderSummaryLine {
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  /** Formatted unit price, e.g. `$4.99`. */
  readonly unitPrice: string;
  /** Formatted quantity x unit price, e.g. `$14.97`. */
  readonly lineTotal: string;
}

/** What the order page renders. All money is already formatted; the page does no arithmetic. */
export interface OrderSummary {
  readonly orderId: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly badge: StatusBadge;
  readonly canCancel: boolean;
  readonly itemCount: number;
  readonly lines: readonly OrderSummaryLine[];
  /** Formatted order total, e.g. `$24.97`. */
  readonly total: string;
  readonly currency: string;
}

export function buildOrderSummary(order: Order): OrderSummary {
  return {
    orderId: order.id,
    status: order.status,
    statusLabel: statusLabel(order.status),
    badge: statusBadge(order.status),
    canCancel: isCancellable(order),
    itemCount: order.lines.reduce((count, line) => count + line.qty, 0),
    lines: order.lines.map((line) => ({
      sku: line.sku,
      name: line.name,
      quantity: line.qty,
      unitPrice: formatMoney(line.unitPriceCents, order.currency),
      lineTotal: formatMoney(line.unitPriceCents * line.qty, order.currency),
    })),
    total: formatMoney(order.totalCents, order.currency),
    currency: order.currency,
  };
}

/** One-line description for notifications and the order list: `3 items · $24.97 · Order placed`. */
export function describeOrder(summary: OrderSummary): string {
  const noun = summary.itemCount === 1 ? "item" : "items";
  return `${summary.itemCount} ${noun} · ${summary.total} · ${summary.statusLabel}`;
}
