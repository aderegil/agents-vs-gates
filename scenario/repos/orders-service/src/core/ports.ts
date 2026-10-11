import type { DomainEvent } from "./events.js";
import type { Order, OrderStatus } from "./order.js";

/** Position in the newest-first ordering of one customer's orders. */
export interface OrderCursor {
  readonly placedAt: string;
  readonly id: string;
}

export interface CustomerOrdersQuery {
  readonly customerId: string;
  readonly status?: OrderStatus;
  readonly limit: number;
  /** Return only orders strictly older than this position. */
  readonly after?: OrderCursor;
}

/** Persistence of orders. Implementations must return copies, never shared mutable state. */
export interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | undefined>;
  /** Orders of one customer, newest first (by `placedAt`, then id), at most `limit`, starting after `after`. */
  findByCustomer(query: CustomerOrdersQuery): Promise<Order[]>;
}

/** Publishes domain events to the event bus. Resolves once the bus has accepted the event. */
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export interface PaymentAuthorizationRequest {
  readonly orderId: string;
  readonly customerId: string;
  readonly amountMinor: number;
  readonly currency: string;
}

export interface PaymentAuthorization {
  readonly authorized: boolean;
  /** Provider reference, present when authorized. */
  readonly reference?: string;
  /** Provider reason, present when declined. */
  readonly declineReason?: string;
}

/**
 * Asks the payment provider to authorize an amount.
 * Implementations throw `PaymentUnavailableError` when the provider cannot be reached;
 * a refusal is a normal result (`authorized: false`), not an error.
 */
export interface PaymentGateway {
  authorize(request: PaymentAuthorizationRequest): Promise<PaymentAuthorization>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  nextId(): string;
}
