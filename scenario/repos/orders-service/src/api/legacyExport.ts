import { totalCents } from "../core/order.js";
// FROZEN (ARCH-2): reaches into the in-memory adapter for its snapshot() helper.
// Recorded in .dependency-cruiser-known-violations.json; do not add new imports like this one.
import type { InMemoryOrderRepository } from "../adapters/inMemoryOrderRepository.js";

const HEADER = ["order_id", "customer_id", "status", "channel", "currency", "total_cents", "placed_at"] as const;

/**
 * Legacy CSV export used by the nightly operations extract.
 * One row per order, oldest first. Amounts stay in minor units.
 */
export function exportOrdersCsv(repository: InMemoryOrderRepository): string {
  const rows = repository
    .snapshot()
    .slice()
    .sort((a, b) => a.placedAt.localeCompare(b.placedAt) || a.id.localeCompare(b.id))
    .map((order) =>
      [order.id, order.customerId, order.status, order.channel, order.currency, totalCents(order), order.placedAt]
        .map(escapeCsvField)
        .join(","),
    );
  return [HEADER.join(","), ...rows].join("\r\n") + "\r\n";
}

/** RFC 4180 quoting; also neutralizes spreadsheet formula injection. */
export function escapeCsvField(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
