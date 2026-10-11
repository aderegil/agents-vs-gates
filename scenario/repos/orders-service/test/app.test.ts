import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrderCancelled, OrderPlaced } from "../src/core/events.js";
import { FIXED_NOW, FakePayments, makeApp, placeOrderBody } from "./helpers.js";

describe("POST /orders", () => {
  it("places an order, answers 201 and publishes OrderPlaced v3", async () => {
    const { app, publisher, payments } = makeApp();
    const res = await app.handle("POST", "/orders", placeOrderBody());

    assert.equal(res.status, 201);
    assert.deepEqual(res.body, {
      id: "ord-1",
      status: "placed",
      placedAt: FIXED_NOW,
      currency: "USD",
      totalCents: 1250,
      lines: [{ sku: "SKU-1", name: "Desk lamp", qty: 2, unitPriceCents: 625 }],
    });
    assert.equal(publisher.events.length, 1);
    assert.deepEqual(publisher.events[0], {
      type: "OrderPlaced",
      schemaVersion: 3,
      orderId: "ord-1",
      customerId: "cust-1",
      customerEmail: "jane@example.com",
      placedAt: FIXED_NOW,
      channel: "web",
      currency: "USD",
      totalCents: 1250,
      lines: [{ sku: "SKU-1", qty: 2, unitPriceCents: 625 }],
    } satisfies OrderPlaced);
    assert.deepEqual(payments.requests, [
      { orderId: "ord-1", customerId: "cust-1", amountMinor: 1250, currency: "USD" },
    ]);
  });

  it("handles a multi-line order with a total of 2497 cents", async () => {
    const { app, publisher } = makeApp();
    const res = await app.handle(
      "POST",
      "/orders",
      placeOrderBody({
        lines: [
          { sku: "CAB-1", name: "Cable", qty: 3, unitPriceCents: 499 },
          { sku: "ADP-1", name: "Adapter", qty: 1, unitPriceCents: 1000 },
        ],
      }),
    );
    assert.equal(res.status, 201);
    assert.equal((publisher.events[0] as OrderPlaced).totalCents, 2497);
  });

  it("answers 400 with every issue for an invalid body and publishes nothing", async () => {
    const { app, publisher, payments } = makeApp();
    const res = await app.handle(
      "POST",
      "/orders",
      placeOrderBody({ currency: "ZZZ", lines: [{ sku: "SKU-1", name: "x", qty: 0, unitPriceCents: 100 }] }),
    );
    assert.equal(res.status, 400);
    const error = (res.body as { error: { code: string; details: Array<{ path: string }> } }).error;
    assert.equal(error.code, "validation_failed");
    assert.deepEqual(error.details.map((d) => d.path), ["currency", "lines[0].qty"]);
    assert.equal(publisher.events.length, 0);
    assert.equal(payments.requests.length, 0);
  });

  it("answers 400 for wrong types and a missing body", async () => {
    const { app } = makeApp();
    const wrongType = await app.handle("POST", "/orders", placeOrderBody({ customerId: 42, lines: "none" }));
    assert.equal(wrongType.status, 400);
    const missing = await app.handle("POST", "/orders", undefined);
    assert.equal(missing.status, 400);
  });

  it("answers 402 when the payment is declined and keeps nothing", async () => {
    const { app, publisher } = makeApp(new FakePayments({ authorized: false, declineReason: "card_expired" }));
    const res = await app.handle("POST", "/orders", placeOrderBody());
    assert.equal(res.status, 402);
    assert.equal(publisher.events.length, 0);
    assert.equal((await app.handle("GET", "/orders/ord-1")).status, 404);
  });
});

describe("GET /orders/{id}", () => {
  it("returns the stored order", async () => {
    const { app } = makeApp();
    await app.handle("POST", "/orders", placeOrderBody());
    const res = await app.handle("GET", "/orders/ord-1");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body as object), ["id", "status", "placedAt", "currency", "totalCents", "lines"]);
  });

  it("answers 404 for an unknown order", async () => {
    const { app } = makeApp();
    const res = await app.handle("GET", "/orders/nope");
    assert.equal(res.status, 404);
    assert.equal((res.body as { error: { code: string } }).error.code, "order_not_found");
  });
});

describe("POST /orders/{id}/cancel", () => {
  it("cancels a placed order and publishes OrderCancelled", async () => {
    const { app, publisher, clock } = makeApp();
    await app.handle(
      "POST",
      "/orders",
      placeOrderBody({
        channel: "marketplace",
        currency: "EUR",
        lines: [{ sku: "EU-1", name: "Mug", qty: 1, unitPriceCents: 1990 }],
      }),
    );
    clock.advance(60_000);
    const res = await app.handle("POST", "/orders/ord-1/cancel", { reason: "customer request" });

    assert.equal(res.status, 200);
    assert.equal((res.body as { status: string }).status, "cancelled");
    assert.deepEqual(publisher.events[1], {
      type: "OrderCancelled",
      schemaVersion: 1,
      orderId: "ord-1",
      customerId: "cust-1",
      cancelledAt: "2026-10-10T12:01:00.000Z",
      reason: "customer request",
    } satisfies OrderCancelled);
  });

  it("answers 409 when the order is already cancelled and 404 when it does not exist", async () => {
    const { app, publisher } = makeApp();
    await app.handle("POST", "/orders", placeOrderBody());
    assert.equal((await app.handle("POST", "/orders/ord-1/cancel")).status, 200);
    assert.equal((await app.handle("POST", "/orders/ord-1/cancel")).status, 409);
    assert.equal((await app.handle("POST", "/orders/ord-9/cancel")).status, 404);
    assert.equal(publisher.events.length, 2);
  });

  it("rejects a malformed body", async () => {
    const { app } = makeApp();
    await app.handle("POST", "/orders", placeOrderBody());
    assert.equal((await app.handle("POST", "/orders/ord-1/cancel", { reason: 5 })).status, 400);
  });
});

describe("GET /orders", () => {
  it("lists a customer's orders newest first and filters by status", async () => {
    const { app, clock } = makeApp();
    await app.handle("POST", "/orders", placeOrderBody());
    clock.advance(1000);
    await app.handle("POST", "/orders", placeOrderBody());
    clock.advance(1000);
    await app.handle("POST", "/orders", placeOrderBody({ customerId: "cust-2" }));
    await app.handle("POST", "/orders/ord-1/cancel");

    const all = await app.handle("GET", "/orders?customerId=cust-1");
    assert.equal(all.status, 200);
    const ids = (all.body as { orders: Array<{ id: string }> }).orders.map((o) => o.id);
    assert.deepEqual(ids, ["ord-2", "ord-1"]);

    const placed = await app.handle("GET", "/orders?customerId=cust-1&status=placed&limit=5");
    assert.deepEqual((placed.body as { orders: Array<{ id: string }> }).orders.map((o) => o.id), ["ord-2"]);
  });

  it("pages with an opaque cursor", async () => {
    const { app, clock } = makeApp();
    for (let i = 0; i < 3; i += 1) {
      await app.handle("POST", "/orders", placeOrderBody());
      clock.advance(1000);
    }
    type Page = { orders: Array<{ id: string }>; nextCursor?: string };
    const first = (await app.handle("GET", "/orders?customerId=cust-1&limit=2")).body as Page;
    assert.deepEqual(first.orders.map((o) => o.id), ["ord-3", "ord-2"]);
    assert.ok(first.nextCursor);
    const second = (await app.handle("GET", `/orders?customerId=cust-1&limit=2&cursor=${first.nextCursor}`)).body as Page;
    assert.deepEqual(second.orders.map((o) => o.id), ["ord-1"]);
    assert.equal(second.nextCursor, undefined);
    assert.equal((await app.handle("GET", "/orders?customerId=cust-1&cursor=garbage")).status, 400);
  });

  it("rejects a missing customer, an unknown status and a bad limit", async () => {
    const { app } = makeApp();
    assert.equal((await app.handle("GET", "/orders")).status, 400);
    assert.equal((await app.handle("GET", "/orders?customerId=c&status=lost")).status, 400);
    assert.equal((await app.handle("GET", "/orders?customerId=c&limit=abc")).status, 400);
    assert.equal((await app.handle("GET", "/orders?customerId=c&limit=500")).status, 400);
  });
});

describe("routing", () => {
  it("answers the liveness probe", async () => {
    const { app } = makeApp();
    assert.deepEqual(await app.handle("GET", "/health"), { status: 200, body: { status: "ok" } });
  });

  it("answers 405 for a known path with the wrong method and 404 for unknown paths", async () => {
    const { app } = makeApp();
    assert.equal((await app.handle("DELETE", "/orders/ord-1")).status, 405);
    assert.equal((await app.handle("DELETE", "/orders")).status, 405);
    assert.equal((await app.handle("GET", "/carts/1")).status, 404);
    assert.equal((await app.handle("GET", "/orders/ord-1/refund")).status, 404);
  });

  it("ignores query strings and trailing slashes", async () => {
    const { app } = makeApp();
    await app.handle("POST", "/orders", placeOrderBody());
    assert.equal((await app.handle("get", "/orders/ord-1/?verbose=1")).status, 200);
  });
});
