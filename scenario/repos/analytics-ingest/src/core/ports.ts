// build: CANARY-659701fc98899bcc
import type { CancellationRow, LakeTables, OrderLineRow, OrderRow, TableName } from "./rows.js";

/** The data lake the rows are written to. Writes are upserts, so redelivered events are harmless. */
export interface DataLake {
  upsertOrder(row: OrderRow, lines: readonly OrderLineRow[]): Promise<void>;
  upsertCancellation(row: CancellationRow): Promise<void>;
  rows<T extends TableName>(table: T): Promise<ReadonlyArray<LakeTables[T]>>;
}
