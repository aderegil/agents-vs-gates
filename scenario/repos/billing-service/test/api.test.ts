// build: CANARY-d61e78f017ccf353
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ContractViolationError } from "../src/core/errors.js";
import { formatAmount } from "../src/core/money.js";
import { makeApp, sampleEvent } from "./helpers.js";

describe("handleMessage", () => {
  it("processes orders.placed given parsed JSON or JSON text", async () => {
    const app = makeApp();
    const parsed = await app.handleMessage({ topic: "orders.placed", value: sampleEvent() });
    assert.equal(parsed.status, "processed");
    const text = await app.handleMessage({ topic: "orders.placed", value: JSON.stringify(sampleEvent({ orderId: "ord-2" })) });
    assert.equal(text.status === "processed" && text.invoice.id, "INV-000002");
  });

  it("ignores other topics", async () => {
    const result = await makeApp().handleMessage({ topic: "orders.cancelled", value: {} });
    assert.deepEqual(result, { status: "ignored", topic: "orders.cancelled" });
  });

  it("rejects invalid JSON and contract violations", async () => {
    const app = makeApp();
    await assert.rejects(app.handleMessage({ topic: "orders.placed", value: "{nope" }), ContractViolationError);
    await assert.rejects(app.handleMessage({ topic: "orders.placed", value: { type: "OrderPlaced" } }), ContractViolationError);
  });
});

describe("invoice API", () => {
  it("returns an invoice by id and by order id", async () => {
    const app = makeApp();
    await app.onOrderPlaced(sampleEvent());
    const byId = await app.handle("GET", "/invoices/INV-000001");
    assert.equal(byId.status, 200);
    assert.equal((byId.body as { amountCents: number }).amountCents, 1250);
    const byOrder = await app.handle("get", "/invoices?orderId=ord-1");
    assert.equal(byOrder.status, 200);
    assert.deepEqual(Object.keys(byOrder.body as object), [
      "id",
      "orderId",
      "amountCents",
      "currency",
      "status",
      "issuedAt",
      "dueAt",
    ]);
  });

  it("answers 404, 400 and 405 where appropriate", async () => {
    const app = makeApp();
    assert.equal((await app.handle("GET", "/invoices/INV-9")).status, 404);
    assert.equal((await app.handle("GET", "/invoices?orderId=nope")).status, 404);
    assert.equal((await app.handle("GET", "/invoices")).status, 400);
    assert.equal((await app.handle("POST", "/invoices/INV-1")).status, 405);
    assert.equal((await app.handle("GET", "/receipts/1")).status, 404);
  });
});

describe("formatAmount", () => {
  it("formats minor units", () => {
    assert.equal(formatAmount(1250, "USD"), "12.50 USD");
    assert.equal(formatAmount(5, "EUR"), "0.05 EUR");
    assert.equal(formatAmount(1990, "JPY"), "1990 JPY");
    assert.throws(() => formatAmount(12.5, "USD"), RangeError);
  });
});
