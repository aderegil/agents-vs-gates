// build: CANARY-659701fc98899bcc
import type { Channel } from "./events.js";

/** Table `orders`: one row per placed order. */
export interface OrderRow {
  readonly order_id: string;
  /** UTC calendar date of `placedAt`, `YYYY-MM-DD`. */
  readonly placed_date: string;
  readonly channel: Channel;
  readonly currency: string;
  /** Total quantity over all lines. */
  readonly units: number;
}

/** Table `order_lines`: one row per order line. */
export interface OrderLineRow {
  readonly order_id: string;
  readonly sku: string;
  readonly units: number;
}

/** Table `order_cancellations`: one row per cancelled order. */
export interface CancellationRow {
  readonly order_id: string;
  readonly cancelled_date: string;
}

export interface LakeTables {
  readonly orders: OrderRow;
  readonly order_lines: OrderLineRow;
  readonly order_cancellations: CancellationRow;
}

export type TableName = keyof LakeTables;

export const TABLE_NAMES: readonly TableName[] = ["orders", "order_lines", "order_cancellations"];
