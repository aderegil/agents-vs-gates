import { totalCents, type Channel, type Order } from "./order.js";

export const ORDER_PLACED_TOPIC = "orders.placed";
export const ORDER_CANCELLED_TOPIC = "orders.cancelled";

/** Published when an order has been accepted and its payment authorized. */
export interface OrderPlaced {
  readonly type: "OrderPlaced";
  readonly schemaVersion: 3;
  readonly orderId: string;
  readonly customerId: string;
  /** Legacy field; a known ARCH-6 exception tracked in the PII baseline. */
  readonly customerEmail: string;
  /** ISO-8601 instant. */
  readonly placedAt: string;
  readonly channel: Channel;
  /** ISO-4217 code. */
  readonly currency: string;
  /** Integer, minor units. */
  readonly totalCents: number;
  readonly lines: ReadonlyArray<{
    readonly sku: string;
    readonly qty: number;
    readonly unitPriceCents: number;
  }>;
}

/** Published when a placed order is cancelled. */
export interface OrderCancelled {
  readonly type: "OrderCancelled";
  readonly schemaVersion: 1;
  readonly orderId: string;
  readonly customerId: string;
  /** ISO-8601 instant. */
  readonly cancelledAt: string;
  readonly reason?: string;
}

export type DomainEvent = OrderPlaced | OrderCancelled;

/** The single place where an `OrderPlaced` event is built. */
export function orderPlaced(order: Order): OrderPlaced {
  return {
    type: "OrderPlaced",
    schemaVersion: 3,
    orderId: order.id,
    customerId: order.customerId,
    customerEmail: order.customerEmail,
    placedAt: order.placedAt,
    channel: order.channel,
    currency: order.currency,
    totalCents: totalCents(order),
    lines: order.lines.map((line) => ({
      sku: line.sku,
      qty: line.qty,
      unitPriceCents: line.unitPriceCents,
    })),
  };
}

/** The single place where an `OrderCancelled` event is built. */
export function orderCancelled(order: Order, cancelledAt: string, reason?: string): OrderCancelled {
  return {
    type: "OrderCancelled",
    schemaVersion: 1,
    orderId: order.id,
    customerId: order.customerId,
    cancelledAt,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function topicFor(event: DomainEvent): string {
  switch (event.type) {
    case "OrderPlaced":
      return ORDER_PLACED_TOPIC;
    case "OrderCancelled":
      return ORDER_CANCELLED_TOPIC;
  }
}

/** Partition key: all events of one order are ordered relative to each other. */
export function partitionKeyFor(event: DomainEvent): string {
  return event.orderId;
}
