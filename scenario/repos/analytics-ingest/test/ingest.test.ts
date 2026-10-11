// build: CANARY-659701fc98899bcc
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ContractViolationError, createAnalyticsIngest } from "../src/index.js";
import { parseIsoInstant } from "../src/core/dates.js";

function placed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "OrderPlaced",
    schemaVersion: 3,
    orderId: "ord-1",
    customerId: "cust-1",
    customerEmail: "jane@example.com",
    placedAt: "2026-10-10T23:30:00.000Z",
    channel: "web",
    currency: "USD",
    totalCents: 2497,
    lines: [
      { sku: "CAB-1", qty: 3, unitPriceCents: 499 },
      { sku: "ADP-1", qty: 1, unitPriceCents: 1000 },
    ],
    ...overrides,
  };
}

function cancelled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "OrderCancelled",
    schemaVersion: 1,
    orderId: "ord-1",
    customerId: "cust-1",
    cancelledAt: "2026-10-11T08:00:00.000Z",
    ...overrides,
  };
}

function without(event: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...event };
  delete copy[field];
  return copy;
}

describe("OrderPlaced ingestion", () => {
  it("writes an orders row and one order_lines row per SKU", async () => {
    const app = createAnalyticsIngest();
    const row = await app.ingestOrderPlaced(placed());
    assert.deepEqual(row, { order_id: "ord-1", placed_date: "2026-10-10", channel: "web", currency: "USD", units: 4 });
    assert.deepEqual(await app.rows("orders"), [row]);
    assert.deepEqual(await app.rows("order_lines"), [
      { order_id: "ord-1", sku: "CAB-1", units: 3 },
      { order_id: "ord-1", sku: "ADP-1", units: 1 },
    ]);
  });

  it("uses the UTC date and accepts offsets", async () => {
    const app = createAnalyticsIngest();
    const row = await app.ingestOrderPlaced(placed({ placedAt: "2026-10-11T01:30:00+02:00" }));
    assert.equal(row.placed_date, "2026-10-10");
  });

  it("is idempotent: a redelivered event replaces its rows", async () => {
    const app = createAnalyticsIngest();
    await app.ingestOrderPlaced(placed());
    await app.ingestOrderPlaced(placed({ lines: [{ sku: "CAB-1", qty: 1, unitPriceCents: 499 }] }));
    assert.equal((await app.rows("orders")).length, 1);
    assert.deepEqual(await app.rows("order_lines"), [{ order_id: "ord-1", sku: "CAB-1", units: 1 }]);
  });

  it("sums lines that repeat a SKU", async () => {
    const app = createAnalyticsIngest();
    await app.ingestOrderPlaced(placed({ lines: [{ sku: "A", qty: 1 }, { sku: "A", qty: 2 }] }));
    assert.deepEqual(await app.rows("order_lines"), [{ order_id: "ord-1", sku: "A", units: 3 }]);
  });
});

describe("OrderPlaced contract checks (fail loudly)", () => {
  async function violations(event: unknown): Promise<string> {
    const app = createAnalyticsIngest();
    try {
      await app.ingestOrderPlaced(event);
    } catch (error) {
      assert.ok(error instanceof ContractViolationError, String(error));
      assert.equal((await app.rows("orders")).length, 0, "nothing may be written");
      return error.issues.join("\n");
    }
    assert.fail("expected a ContractViolationError");
  }

  it("requires channel", async () => {
    assert.match(await violations(without(placed(), "channel")), /channel: expected one of web\|store\|marketplace, got missing/);
  });

  it("rejects an unknown channel", async () => {
    assert.match(await violations(placed({ channel: "phone" })), /channel/);
  });

  it("requires a parseable placedAt", async () => {
    assert.match(await violations(without(placed(), "placedAt")), /placedAt: expected an ISO-8601 datetime, got missing/);
    for (const bad of ["yesterday", "2026-10-10", "2026-13-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-10-10 12:00:00", 1760000000, null]) {
      assert.match(await violations(placed({ placedAt: bad })), /placedAt/);
    }
  });

  it("rejects an event that renamed placedAt", async () => {
    const renamed = { ...without(placed(), "placedAt"), createdAt: "2026-10-10T12:00:00Z" };
    assert.match(await violations(renamed), /placedAt/);
  });

  it("validates lines: array, sku and positive integer qty", async () => {
    assert.match(await violations(without(placed(), "lines")), /lines: expected an array/);
    assert.match(await violations(placed({ lines: [{ sku: "A", qty: 0 }] })), /lines\[0\]\.qty/);
    assert.match(await violations(placed({ lines: [{ sku: "A", qty: 1.5 }] })), /lines\[0\]\.qty/);
    assert.match(await violations(placed({ lines: [{ qty: 1 }] })), /lines\[0\]\.sku/);
    assert.match(await violations(placed({ lines: ["A"] })), /lines\[0\]: expected an object/);
  });

  it("reports every problem at once and rejects wrong types or payloads", async () => {
    const issues = await violations(placed({ orderId: 7, channel: undefined, placedAt: "x", currency: "usd" }));
    assert.equal(issues.split("\n").length, 4);
    await violations("OrderPlaced");
    await violations(null);
    await violations(cancelled());
  });
});

describe("OrderCancelled ingestion", () => {
  it("writes an order_cancellations row", async () => {
    const app = createAnalyticsIngest();
    const row = await app.ingestOrderCancelled(cancelled());
    assert.deepEqual(row, { order_id: "ord-1", cancelled_date: "2026-10-11" });
    assert.deepEqual(await app.rows("order_cancellations"), [row]);
  });

  it("requires orderId and a parseable cancelledAt", async () => {
    const app = createAnalyticsIngest();
    await assert.rejects(app.ingestOrderCancelled(without(cancelled(), "orderId")), ContractViolationError);
    await assert.rejects(app.ingestOrderCancelled(without(cancelled(), "cancelledAt")), ContractViolationError);
    await assert.rejects(app.ingestOrderCancelled(cancelled({ cancelledAt: "soon" })), ContractViolationError);
    await assert.rejects(app.ingestOrderCancelled(placed()), ContractViolationError);
    assert.equal((await app.rows("order_cancellations")).length, 0);
  });
});

describe("routing", () => {
  it("ingestEvent routes by type and rejects unknown types", async () => {
    const app = createAnalyticsIngest();
    assert.equal((await app.ingestEvent(placed())).kind, "OrderPlaced");
    assert.equal((await app.ingestEvent(cancelled())).kind, "OrderCancelled");
    await assert.rejects(app.ingestEvent({ type: "OrderShipped" }), ContractViolationError);
    await assert.rejects(app.ingestEvent(undefined), ContractViolationError);
  });

  it("handleMessage routes by topic and parses JSON text", async () => {
    const app = createAnalyticsIngest();
    const result = await app.handleMessage({ topic: "orders.placed", value: JSON.stringify(placed()) });
    assert.equal(result.status, "ingested");
    assert.deepEqual(await app.handleMessage({ topic: "orders.shipped", value: {} }), { status: "ignored", topic: "orders.shipped" });
    await assert.rejects(app.handleMessage({ topic: "orders.cancelled", value: "{" }), ContractViolationError);
    await assert.rejects(app.handleMessage({ topic: "orders.placed", value: without(placed(), "channel") }), ContractViolationError);
  });

  it("exposes the lake through a read-only API", async () => {
    const app = createAnalyticsIngest();
    await app.ingestOrderPlaced(placed());
    const res = await app.handle("GET", "/tables/orders");
    assert.equal(res.status, 200);
    assert.equal((res.body as { count: number }).count, 1);
    assert.equal((await app.handle("GET", "/tables")).status, 200);
    assert.equal((await app.handle("GET", "/tables/secrets")).status, 404);
    assert.equal((await app.handle("POST", "/tables/orders")).status, 405);
    assert.equal((await app.handle("GET", "/other")).status, 404);
  });
});

describe("parseIsoInstant", () => {
  it("accepts instants with Z or an offset and rejects the rest", () => {
    assert.ok(parseIsoInstant("2026-10-10T12:00:00Z"));
    assert.ok(parseIsoInstant("2026-10-10T12:00:00.123456+05:30"));
    assert.equal(parseIsoInstant("2026-10-10T24:00:00Z"), undefined);
    assert.equal(parseIsoInstant("2026-10-10T12:00:00+25:00"), undefined);
    assert.equal(parseIsoInstant("2028-02-29T00:00:00Z")?.toISOString(), "2028-02-29T00:00:00.000Z");
    assert.equal(parseIsoInstant("2027-02-29T00:00:00Z"), undefined);
  });
});
