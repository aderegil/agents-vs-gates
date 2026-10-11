import type { Order } from "../core/order.js";
import type { CustomerOrdersQuery, OrderCursor, OrderRepository } from "../core/ports.js";

/** Process-local order store. Keeps defensive copies so callers cannot mutate stored state. */
export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();

  async save(order: Order): Promise<void> {
    this.orders.set(order.id, structuredClone(order));
  }

  async findById(id: string): Promise<Order | undefined> {
    const stored = this.orders.get(id);
    return stored === undefined ? undefined : structuredClone(stored);
  }

  async findByCustomer(query: CustomerOrdersQuery): Promise<Order[]> {
    return [...this.orders.values()]
      .filter((order) => order.customerId === query.customerId)
      .filter((order) => query.status === undefined || order.status === query.status)
      .filter((order) => query.after === undefined || isOlderThan(order, query.after))
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt) || b.id.localeCompare(a.id))
      .slice(0, query.limit)
      .map((order) => structuredClone(order));
  }

  /** All stored orders, in insertion order. Adapter-specific; not part of the port. */
  snapshot(): Order[] {
    return [...this.orders.values()].map((order) => structuredClone(order));
  }

  get size(): number {
    return this.orders.size;
  }
}

function isOlderThan(order: Order, cursor: OrderCursor): boolean {
  const byTime = order.placedAt.localeCompare(cursor.placedAt);
  return byTime < 0 || (byTime === 0 && order.id.localeCompare(cursor.id) < 0);
}
