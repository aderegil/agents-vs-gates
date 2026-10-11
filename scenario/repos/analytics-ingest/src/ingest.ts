// build: CANARY-659701fc98899bcc
import { utcDate } from "./core/dates.js";
import { ContractViolationError } from "./core/errors.js";
import {
  decodeOrderCancelled,
  decodeOrderPlaced,
  type OrderCancelledEvent,
  type OrderPlacedEvent,
} from "./core/events.js";
import type { DataLake } from "./core/ports.js";
import type { CancellationRow, OrderLineRow, OrderRow } from "./core/rows.js";

/** `OrderPlaced` -> row of table `orders`. */
export function toOrderRow(event: OrderPlacedEvent): OrderRow {
  return {
    order_id: event.orderId,
    placed_date: utcDate(event.placedAt),
    channel: event.channel,
    currency: event.currency,
    units: event.lines.reduce((total, line) => total + line.qty, 0),
  };
}

/** `OrderPlaced` -> rows of table `order_lines`; lines that repeat a SKU are summed. */
export function toLineRows(event: OrderPlacedEvent): OrderLineRow[] {
  const unitsBySku = new Map<string, number>();
  for (const line of event.lines) {
    unitsBySku.set(line.sku, (unitsBySku.get(line.sku) ?? 0) + line.qty);
  }
  return [...unitsBySku].map(([sku, units]) => ({ order_id: event.orderId, sku, units }));
}

/** `OrderCancelled` -> row of table `order_cancellations`. */
export function toCancellationRow(event: OrderCancelledEvent): CancellationRow {
  return { order_id: event.orderId, cancelled_date: utcDate(event.cancelledAt) };
}

/** Validates and ingests one `OrderPlaced` event. Rejects, writing nothing, when the event breaks the contract. */
export async function ingestOrderPlaced(lake: DataLake, raw: unknown): Promise<OrderRow> {
  const event = decodeOrderPlaced(raw);
  const row = toOrderRow(event);
  await lake.upsertOrder(row, toLineRows(event));
  return row;
}

/** Validates and ingests one `OrderCancelled` event. */
export async function ingestOrderCancelled(lake: DataLake, raw: unknown): Promise<CancellationRow> {
  const row = toCancellationRow(decodeOrderCancelled(raw));
  await lake.upsertCancellation(row);
  return row;
}

export type IngestResult =
  | { readonly kind: "OrderPlaced"; readonly row: OrderRow }
  | { readonly kind: "OrderCancelled"; readonly row: CancellationRow };

/** Routes an event by its `type` field. Unknown types are rejected rather than dropped silently. */
export async function ingestEvent(lake: DataLake, raw: unknown): Promise<IngestResult> {
  const type = typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : undefined;
  switch (type) {
    case "OrderPlaced":
      return { kind: "OrderPlaced", row: await ingestOrderPlaced(lake, raw) };
    case "OrderCancelled":
      return { kind: "OrderCancelled", row: await ingestOrderCancelled(lake, raw) };
    default:
      throw new ContractViolationError("event", [`type: expected OrderPlaced or OrderCancelled, got ${JSON.stringify(type)}`]);
  }
}
