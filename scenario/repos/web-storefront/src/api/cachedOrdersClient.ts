// build: CANARY-bab633003b4a7775
import type { Order } from "../core/order.js";
import type { OrdersClient } from "./ordersClient.js";

export interface CacheOptions {
  /** How long a fetched order is served from memory, in milliseconds. */
  readonly ttlMs: number;
  /** Oldest entries are dropped beyond this many orders. Default 100. */
  readonly maxEntries?: number;
  /** Time source in milliseconds; injectable for tests. Default `Date.now`. */
  readonly now?: () => number;
}

export interface CachedOrdersClient extends OrdersClient {
  /** Forget one order (for example after the shopper cancelled it) or everything. */
  invalidate(id?: string): void;
}

interface Entry {
  readonly order: Order;
  readonly expiresAt: number;
}

/**
 * Wraps a client with a small read-through cache. Failures are never cached, and concurrent reads
 * of the same order share one request.
 */
export function withCache(inner: OrdersClient, options: CacheOptions): CachedOrdersClient {
  const now = options.now ?? Date.now;
  const maxEntries = Math.max(1, options.maxEntries ?? 100);
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<Order>>();

  async function load(id: string): Promise<Order> {
    const order = await inner.getOrder(id);
    entries.delete(id);
    entries.set(id, { order, expiresAt: now() + options.ttlMs });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      entries.delete(oldest.value);
    }
    return order;
  }

  return {
    async getOrder(id: string): Promise<Order> {
      const cached = entries.get(id);
      if (cached !== undefined && cached.expiresAt > now()) {
        return cached.order;
      }
      const pending = inFlight.get(id) ?? load(id).finally(() => inFlight.delete(id));
      inFlight.set(id, pending);
      return pending;
    },
    invalidate(id?: string): void {
      if (id === undefined) {
        entries.clear();
      } else {
        entries.delete(id);
      }
    },
  };
}
