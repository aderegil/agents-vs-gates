// build: CANARY-bab633003b4a7775
import { createFetchTransport } from "./adapters/fetchTransport.js";
import { withCache } from "./api/cachedOrdersClient.js";
import { createOrdersClient, DEFAULT_ORDERS_API_URL, type OrdersClient } from "./api/ordersClient.js";
import type { Order } from "./core/order.js";
import type { HttpTransport } from "./core/ports.js";
import { buildOrderSummary, type OrderSummary } from "./viewModels/orderSummary.js";

export type { HttpTransport, Order, OrderSummary, OrdersClient };
export { ContractViolationError, OrderNotFoundError } from "./core/errors.js";
export { createOrdersClient } from "./api/ordersClient.js";
export { withCache } from "./api/cachedOrdersClient.js";
export { renderReceipt } from "./viewModels/receipt.js";
export { formatMoney } from "./viewModels/money.js";
export { buildOrderSummary, describeOrder } from "./viewModels/orderSummary.js";

export interface StorefrontOptions {
  /** Base URL of orders-api. Defaults to the catalog host. */
  readonly baseUrl?: string;
  /** `fetch`-like function. Defaults to the global `fetch` with a 5 s timeout. */
  readonly transport?: HttpTransport;
  /** Serve fetched orders from memory for this many milliseconds. Default 0 (no cache). */
  readonly cacheTtlMs?: number;
}

export interface Storefront {
  /** `GET /orders/{id}`, validated. */
  getOrder(id: string): Promise<Order>;
  /** The order page view model: formatted money, labels and counts. */
  getOrderSummary(id: string): Promise<OrderSummary>;
}

export function createStorefront(options: StorefrontOptions = {}): Storefront {
  const direct = createOrdersClient({
    baseUrl: options.baseUrl ?? DEFAULT_ORDERS_API_URL,
    transport: options.transport ?? createFetchTransport(),
  });
  const ttlMs = options.cacheTtlMs ?? 0;
  const client = ttlMs > 0 ? withCache(direct, { ttlMs }) : direct;
  return {
    getOrder: (id) => client.getOrder(id),
    getOrderSummary: async (id) => buildOrderSummary(await client.getOrder(id)),
  };
}
