// build: CANARY-659701fc98899bcc
import { InMemoryLake } from "./adapters/inMemoryLake.js";
import { handleMessage, type BusMessage, type MessageResult } from "./api/busHandler.js";
import { queryLake, type QueryResponse } from "./api/lakeQuery.js";
import type { DataLake } from "./core/ports.js";
import type { CancellationRow, LakeTables, OrderLineRow, OrderRow, TableName } from "./core/rows.js";
import { ingestEvent, ingestOrderCancelled, ingestOrderPlaced, type IngestResult } from "./ingest.js";

export type { BusMessage, CancellationRow, IngestResult, MessageResult, OrderLineRow, OrderRow };
export { ContractViolationError } from "./core/errors.js";
export { toLineRows, toOrderRow } from "./ingest.js";

/** All dependencies are optional; the lake defaults to an in-memory one. */
export interface AnalyticsDeps {
  readonly lake?: DataLake;
}

export interface AnalyticsIngest {
  /** Validates and ingests an `OrderPlaced` event; resolves to the `orders` row. Rejects on a broken contract. */
  ingestOrderPlaced(event: unknown): Promise<OrderRow>;
  /** Validates and ingests an `OrderCancelled` event; resolves to the `order_cancellations` row. */
  ingestOrderCancelled(event: unknown): Promise<CancellationRow>;
  /** Routes by the event `type` (`OrderPlaced` or `OrderCancelled`); rejects for anything else. */
  ingestEvent(event: unknown): Promise<IngestResult>;
  /** Bus entry point: routes by topic (`orders.placed`, `orders.cancelled`); other topics are ignored. */
  handleMessage(message: BusMessage): Promise<MessageResult>;
  /** Read-only inspection API (`GET /tables`, `GET /tables/{name}`). */
  handle(method: string, path: string): Promise<QueryResponse>;
  /** Rows currently in one table of the lake. */
  rows<T extends TableName>(table: T): Promise<ReadonlyArray<LakeTables[T]>>;
}

export function createAnalyticsIngest(deps: AnalyticsDeps = {}): AnalyticsIngest {
  const lake = deps.lake ?? new InMemoryLake();
  return {
    ingestOrderPlaced: (event) => ingestOrderPlaced(lake, event),
    ingestOrderCancelled: (event) => ingestOrderCancelled(lake, event),
    ingestEvent: (event) => ingestEvent(lake, event),
    handleMessage: (message) => handleMessage(lake, message),
    handle: (method, path) => queryLake(lake, method, path),
    rows: (table) => lake.rows(table),
  };
}
