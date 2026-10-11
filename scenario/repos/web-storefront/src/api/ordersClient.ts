// build: CANARY-bab633003b4a7775
import {
  ContractViolationError,
  OrderNotFoundError,
  OrdersApiError,
  OrdersApiUnavailableError,
} from "../core/errors.js";
import type { Order } from "../core/order.js";
import type { HttpTransport, TransportResponse } from "../core/ports.js";
import { decodeOrder } from "./orderDecoder.js";

/** Host of orders-api as declared in the architecture catalog. */
export const DEFAULT_ORDERS_API_URL = "https://orders.checkout.internal";

export interface OrdersClientOptions {
  readonly baseUrl?: string;
  readonly transport: HttpTransport;
  /** Total tries for a read that fails with a network error or a 5xx answer. Default 2. */
  readonly maxAttempts?: number;
}

/** Typed client of orders-api (the parts the storefront uses). */
export interface OrdersClient {
  /**
   * `GET /orders/{id}`. Resolves to the order, rejects with `OrderNotFoundError` on 404,
   * `OrdersApiError` on other non-2xx answers, `OrdersApiUnavailableError` when the call never completed and
   * `ContractViolationError` when the body is not what the storefront needs.
   */
  getOrder(id: string): Promise<Order>;
}

export function createOrdersClient(options: OrdersClientOptions): OrdersClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_ORDERS_API_URL).replace(/\/+$/, "");
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);

  return {
    async getOrder(id: string): Promise<Order> {
      if (id.trim() === "") {
        throw new RangeError("Order id must not be empty");
      }
      const url = `${baseUrl}/orders/${encodeURIComponent(id)}`;
      const response = await getWithRetry(options.transport, url, maxAttempts);

      if (response.status === 404) {
        throw new OrderNotFoundError(id);
      }
      if (!response.ok) {
        throw new OrdersApiError(response.status, `GET ${url} answered ${response.status}`);
      }
      return decodeOrder(await readBody(response));
    },
  };
}

async function getWithRetry(transport: HttpTransport, url: string, maxAttempts: number): Promise<TransportResponse> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await transport(url, { method: "GET", headers: { accept: "application/json" } });
      if (response.status < 500 || attempt === maxAttempts) {
        return response;
      }
      lastFailure = new OrdersApiError(response.status, `GET ${url} answered ${response.status}`);
    } catch (cause) {
      lastFailure = cause;
    }
  }
  throw new OrdersApiUnavailableError(`GET ${url} did not complete after ${maxAttempts} attempt(s)`, {
    cause: lastFailure,
  });
}

async function readBody(response: TransportResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ContractViolationError("GET /orders/{id}", ["body: not valid JSON"]);
  }
}
