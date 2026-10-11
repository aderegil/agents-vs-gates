// build: CANARY-659701fc98899bcc
import { asObject, FieldReader } from "./fieldReader.js";

export const CHANNELS = ["web", "store", "marketplace"] as const;
export type Channel = (typeof CHANNELS)[number];

/** The part of `OrderPlaced` that analytics-ingest relies on. Other fields are ignored. */
export interface OrderPlacedEvent {
  readonly orderId: string;
  readonly placedAt: Date;
  readonly channel: Channel;
  readonly currency: string;
  readonly lines: ReadonlyArray<{ readonly sku: string; readonly qty: number }>;
}

/** The part of `OrderCancelled` that analytics-ingest relies on. */
export interface OrderCancelledEvent {
  readonly orderId: string;
  readonly cancelledAt: Date;
}

/**
 * Validates an untrusted `OrderPlaced` event. Every problem is collected;
 * any problem throws `ContractViolationError` (missing or unknown `channel`, unparseable `placedAt`, ...).
 */
export function decodeOrderPlaced(raw: unknown): OrderPlacedEvent {
  const event = asObject("OrderPlaced", raw);
  const reader = new FieldReader(event);

  if (event.type !== "OrderPlaced") {
    reader.issues.push(`type: expected "OrderPlaced", got ${JSON.stringify(event.type)}`);
  }
  const orderId = reader.string("orderId");
  const placedAt = reader.isoInstant("placedAt");
  const channel = reader.oneOf("channel", CHANNELS);
  const currency = reader.currency("currency");

  const lines = reader.array("lines").map((rawLine, index) => {
    const line = reader.child(`lines[${index}]`, rawLine);
    const decoded = { sku: line.string("sku"), qty: line.positiveInteger("qty") };
    reader.adopt(line);
    return decoded;
  });

  reader.assertValid("OrderPlaced");
  return { orderId, placedAt, channel, currency, lines };
}

export function decodeOrderCancelled(raw: unknown): OrderCancelledEvent {
  const event = asObject("OrderCancelled", raw);
  const reader = new FieldReader(event);

  if (event.type !== "OrderCancelled") {
    reader.issues.push(`type: expected "OrderCancelled", got ${JSON.stringify(event.type)}`);
  }
  const orderId = reader.string("orderId");
  const cancelledAt = reader.isoInstant("cancelledAt");

  reader.assertValid("OrderCancelled");
  return { orderId, cancelledAt };
}
