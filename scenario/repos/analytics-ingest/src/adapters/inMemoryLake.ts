// build: CANARY-659701fc98899bcc
import type { DataLake } from "../core/ports.js";
import type { CancellationRow, LakeTables, OrderLineRow, OrderRow, TableName } from "../core/rows.js";

/** The "lake": three keyed in-memory tables. Upserts replace rows with the same key. */
export class InMemoryLake implements DataLake {
  private readonly orders = new Map<string, OrderRow>();
  private readonly orderLines = new Map<string, OrderLineRow>();
  private readonly cancellations = new Map<string, CancellationRow>();

  async upsertOrder(row: OrderRow, lines: readonly OrderLineRow[]): Promise<void> {
    this.orders.set(row.order_id, { ...row });
    for (const key of [...this.orderLines.keys()]) {
      if (key.startsWith(`${row.order_id}\u0000`)) {
        this.orderLines.delete(key);
      }
    }
    for (const line of lines) {
      this.orderLines.set(`${line.order_id}\u0000${line.sku}`, { ...line });
    }
  }

  async upsertCancellation(row: CancellationRow): Promise<void> {
    this.cancellations.set(row.order_id, { ...row });
  }

  async rows<T extends TableName>(table: T): Promise<ReadonlyArray<LakeTables[T]>> {
    const source: ReadonlyMap<string, unknown> =
      table === "orders" ? this.orders : table === "order_lines" ? this.orderLines : this.cancellations;
    return [...source.values()].map((row) => ({ ...(row as object) }) as LakeTables[T]);
  }
}
