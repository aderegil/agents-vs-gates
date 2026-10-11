import { totalCents, type Order } from "../core/order.js";
import type { OrderPage } from "../core/orderService.js";
import { encodeCursor } from "./cursor.js";

/** Body of `GET /orders/{id}` (200). Also returned by `POST /orders` and `POST /orders/{id}/cancel`. */
export interface OrderResponse {
  readonly id: string;
  readonly status: string;
  readonly placedAt: string;
  readonly currency: string;
  readonly totalCents: number;
  readonly lines: ReadonlyArray<{
    readonly sku: string;
    readonly name: string;
    readonly qty: number;
    readonly unitPriceCents: number;
  }>;
}

export interface OrderListResponse {
  readonly orders: readonly OrderResponse[];
  /** Pass as `cursor` to fetch the next page; absent on the last page. */
  readonly nextCursor?: string;
}

/** The single place where an order is mapped to its REST representation. */
export function toOrderResponse(order: Order): OrderResponse {
  return {
    id: order.id,
    status: order.status,
    placedAt: order.placedAt,
    currency: order.currency,
    totalCents: totalCents(order),
    lines: order.lines.map((line) => ({
      sku: line.sku,
      name: line.name,
      qty: line.qty,
      unitPriceCents: line.unitPriceCents,
    })),
  };
}

export function toOrderListResponse(page: OrderPage): OrderListResponse {
  const orders = page.orders.map(toOrderResponse);
  return page.next === undefined ? { orders } : { orders, nextCursor: encodeCursor(page.next) };
}
