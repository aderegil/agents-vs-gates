import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryOrderRepository } from "../src/adapters/inMemoryOrderRepository.js";
import { HttpPaymentGateway } from "../src/adapters/httpPaymentGateway.js";
import { BufferOverflowError, KafkaEventPublisher } from "../src/adapters/kafkaEventPublisher.js";
import { exportOrdersCsv, escapeCsvField } from "../src/api/legacyExport.js";
import { PaymentUnavailableError } from "../src/core/errors.js";
import { orderCancelled, orderPlaced } from "../src/core/events.js";
import { createOrder } from "../src/core/order.js";

const REQUEST = { orderId: "ord-1", customerId: "cust-1", amountMinor: 1250, currency: "USD" };

function sampleOrder(id: string, placedAt: string) {
  return createOrder(
    {
      customerId: "cust-1",
      customerEmail: "jane@example.com",
      channel: "store",
      currency: "USD",
      lines: [{ sku: "SKU-1", name: "Desk lamp", qty: 2, unitPriceCents: 625 }],
    },
    { id, placedAt },
  );
}

describe("InMemoryOrderRepository", () => {
  it("stores copies, not references", async () => {
    const repo = new InMemoryOrderRepository();
    const order = sampleOrder("ord-1", "2026-10-10T12:00:00.000Z");
    await repo.save(order);
    const found = await repo.findById("ord-1");
    assert.deepEqual(found, order);
    assert.notEqual(found, order);
    assert.equal(await repo.findById("missing"), undefined);
    assert.equal(repo.size, 1);
  });
});

describe("KafkaEventPublisher", () => {
  it("buffers records with topic, key and headers", async () => {
    const publisher = new KafkaEventPublisher();
    const order = sampleOrder("ord-1", "2026-10-10T12:00:00.000Z");
    await publisher.publish(orderPlaced(order));
    await publisher.publish(orderCancelled(order, "2026-10-11T00:00:00.000Z"));

    const [placed, cancelled] = publisher.records;
    assert.equal(placed?.topic, "orders.placed");
    assert.equal(placed?.key, "ord-1");
    assert.equal(placed?.headers["schema-version"], "3");
    assert.equal(JSON.parse(placed?.value ?? "{}").totalCents, 1250);
    assert.equal(cancelled?.topic, "orders.cancelled");
    assert.equal(publisher.drain().length, 2);
    assert.equal(publisher.records.length, 0);
  });

  it("fails when the buffer limit is reached", async () => {
    const publisher = new KafkaEventPublisher({ maxBuffered: 1 });
    const event = orderPlaced(sampleOrder("ord-1", "2026-10-10T12:00:00.000Z"));
    await publisher.publish(event);
    await assert.rejects(publisher.publish(event), BufferOverflowError);
  });
});

describe("HttpPaymentGateway", () => {
  function gateway(respond: () => Response | Promise<Response>, seen: string[] = []) {
    return new HttpPaymentGateway({
      retryDelayMs: 0,
      fetchFunction: async (url) => {
        seen.push(url);
        return respond();
      },
    });
  }

  it("calls the payments host and maps 200 to authorized", async () => {
    const seen: string[] = [];
    const result = await gateway(() => Response.json({ status: "authorized", authorizationId: "auth-9" }), seen).authorize(
      REQUEST,
    );
    assert.deepEqual(result, { authorized: true, reference: "auth-9" });
    assert.equal(seen[0], "https://payments.payments.internal/v1/authorizations");
  });

  it("treats an empty 204 as authorized", async () => {
    const result = await gateway(() => new Response(null, { status: 204 })).authorize(REQUEST);
    assert.deepEqual(result, { authorized: true });
  });

  it("maps 402 and an explicit declined status to declined", async () => {
    const refused = await gateway(() => Response.json({ reason: "insufficient_funds" }, { status: 402 })).authorize(REQUEST);
    assert.deepEqual(refused, { authorized: false, declineReason: "insufficient_funds" });
    const declined = await gateway(() => Response.json({ status: "declined" })).authorize(REQUEST);
    assert.equal(declined.authorized, false);
  });

  it("raises PaymentUnavailableError on 5xx and on transport failures", async () => {
    await assert.rejects(gateway(() => new Response("boom", { status: 503 })).authorize(REQUEST), PaymentUnavailableError);
    const broken = new HttpPaymentGateway({
      retryDelayMs: 0,
      fetchFunction: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await assert.rejects(broken.authorize(REQUEST), PaymentUnavailableError);
  });
});

describe("HttpPaymentGateway retries", () => {
  it("retries a 5xx once and succeeds on the second answer", async () => {
    const answers = [new Response("boom", { status: 502 }), Response.json({ status: "authorized" })];
    const gateway = new HttpPaymentGateway({ retryDelayMs: 0, fetchFunction: async () => answers.shift() as Response });
    assert.deepEqual(await gateway.authorize(REQUEST), { authorized: true });
    assert.equal(answers.length, 0);
  });

  it("does not retry a refusal", async () => {
    let calls = 0;
    const gateway = new HttpPaymentGateway({
      retryDelayMs: 0,
      maxAttempts: 3,
      fetchFunction: async () => {
        calls += 1;
        return new Response(null, { status: 402 });
      },
    });
    assert.equal((await gateway.authorize(REQUEST)).authorized, false);
    assert.equal(calls, 1);
  });
});

describe("legacy CSV export", () => {
  it("exports one row per order, oldest first, in minor units", async () => {
    const repo = new InMemoryOrderRepository();
    await repo.save(sampleOrder("ord-2", "2026-10-10T13:00:00.000Z"));
    await repo.save(sampleOrder("ord-1", "2026-10-10T12:00:00.000Z"));
    const lines = exportOrdersCsv(repo).trimEnd().split("\r\n");
    assert.equal(lines[0], "order_id,customer_id,status,currency,total_cents,placed_at");
    assert.equal(lines[1], "ord-1,cust-1,placed,USD,1250,2026-10-10T12:00:00.000Z");
    assert.equal(lines.length, 3);
  });

  it("quotes separators and neutralizes formulas", () => {
    assert.equal(escapeCsvField('a,"b"'), '"a,""b"""');
    assert.equal(escapeCsvField("=SUM(A1)"), "'=SUM(A1)");
    assert.equal(escapeCsvField(42), "42");
  });
});
