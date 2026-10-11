// build: CANARY-bab633003b4a7775
import type { OrderSummary } from "./orderSummary.js";

const WIDTH = 44;

/**
 * Plain-text receipt for printing or sharing, built only from the view model
 * (so the formatted money is exactly what the page shows).
 */
export function renderReceipt(summary: OrderSummary): string {
  const rows = summary.lines.flatMap((line) => [
    line.name,
    twoColumns(`  ${line.quantity} x ${line.unitPrice}`, line.lineTotal),
  ]);
  return [
    "Meridian Retail",
    `Order ${summary.orderId}`,
    summary.statusLabel,
    "-".repeat(WIDTH),
    ...rows,
    "-".repeat(WIDTH),
    twoColumns(`Total (${summary.itemCount} ${summary.itemCount === 1 ? "item" : "items"})`, summary.total),
  ].join("\n");
}

function twoColumns(left: string, right: string): string {
  const gap = Math.max(1, WIDTH - left.length - right.length);
  return `${left}${" ".repeat(gap)}${right}`;
}
