import { OrderNotFoundError, PaymentDeclinedError, ValidationError } from "./errors.js";
import { orderCancelled, orderPlaced } from "./events.js";
import { cancel, createOrder, totalCents, type NewOrder, type Order } from "./order.js";
import type {
  Clock,
  CustomerOrdersQuery,
  EventPublisher,
  IdGenerator,
  OrderCursor,
  OrderRepository,
  PaymentGateway,
} from "./ports.js";

export const MAX_LIST_LIMIT = 100;

export interface OrderPage {
  readonly orders: Order[];
  /** Present when more orders exist after this page. */
  readonly next?: OrderCursor;
}

export interface OrderServiceDeps {
  readonly orders: OrderRepository;
  readonly events: EventPublisher;
  readonly payments: PaymentGateway;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface CancelOrderOptions {
  readonly reason?: string;
}

/**
 * Application service: orchestrates the order use cases over the ports.
 * It owns the order of side effects: authorize, persist, then publish.
 */
export class OrderService {
  constructor(private readonly deps: OrderServiceDeps) {}

  async placeOrder(command: NewOrder): Promise<Order> {
    const { orders, events, payments, clock, ids } = this.deps;

    const order = createOrder(command, {
      id: ids.nextId(),
      placedAt: clock.now().toISOString(),
    });

    const authorization = await payments.authorize({
      orderId: order.id,
      customerId: order.customerId,
      amountMinor: totalCents(order),
      currency: order.currency,
    });
    if (!authorization.authorized) {
      throw new PaymentDeclinedError(order.id, authorization.declineReason ?? "declined by provider");
    }

    await orders.save(order);
    await events.publish(orderPlaced(order));
    return order;
  }

  async getOrder(id: string): Promise<Order> {
    const order = await this.deps.orders.findById(id);
    if (order === undefined) {
      throw new OrderNotFoundError(id);
    }
    return order;
  }

  /** Lists one customer's orders, newest first, one page at a time. */
  async listOrders(query: CustomerOrdersQuery): Promise<OrderPage> {
    if (query.customerId.trim() === "") {
      throw new ValidationError([{ path: "customerId", message: "is required" }]);
    }
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIST_LIMIT) {
      throw new ValidationError([{ path: "limit", message: `must be an integer between 1 and ${MAX_LIST_LIMIT}` }]);
    }
    // Ask for one extra row to learn whether another page exists.
    const rows = await this.deps.orders.findByCustomer({ ...query, limit: query.limit + 1 });
    const orders = rows.slice(0, query.limit);
    const last = orders.at(-1);
    return rows.length > query.limit && last !== undefined
      ? { orders, next: { placedAt: last.placedAt, id: last.id } }
      : { orders };
  }

  async cancelOrder(id: string, options: CancelOrderOptions = {}): Promise<Order> {
    const { orders, events, clock } = this.deps;

    const existing = await this.getOrder(id);
    const cancelledAt = clock.now().toISOString();
    const cancelled = cancel(existing, cancelledAt);

    await orders.save(cancelled);
    await events.publish(orderCancelled(cancelled, cancelledAt, options.reason));
    return cancelled;
  }
}
