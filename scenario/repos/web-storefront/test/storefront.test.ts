// build: CANARY-bab633003b4a7775
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ContractViolationError,
  OrderNotFoundError,
  buildOrderSummary,
  createOrdersClient,
  createStorefront,
  describeOrder,
  formatMoney,
  renderReceipt,
  withCache,
} from "../src/index.js";
import { OrdersApiError, OrdersApiUnavailableError } from "../src/core/errors.js";
import { reply, sampleBody, scriptedTransport, without } from "./helpers.js";

describe("orders client", () => {
  it("fetches and decodes an order from orders-api", async () => {
    const { transport, urls } = scriptedTransport(reply(200, sampleBody()));
    const order = await createOrdersClient({ transport }).getOrder("ord-1");
    assert.deepEqual(urls, ["https://orders.checkout.internal/orders/ord-1"]);
    assert.equal(order.id, "ord-1");
    assert.equal(order.totalCents, 2497);
    assert.deepEqual(order.lines[0], { sku: "CAB-1", name: "USB cable", qty: 3, unitPriceCents: 499 });
  });

  it("honours the base URL and encodes the id", async () => {
    const { transport, urls } = scriptedTransport(reply(200, sampleBody()));
    await createOrdersClient({ baseUrl: "http://localhost:9000/", transport }).getOrder("a/b c");
    assert.deepEqual(urls, ["http://localhost:9000/orders/a%2Fb%20c"]);
  });

  it("maps 404 to OrderNotFoundError and other statuses to OrdersApiError", async () => {
    const missing = createOrdersClient({ transport: scriptedTransport(reply(404, {})).transport });
    await assert.rejects(missing.getOrder("x"), OrderNotFoundError);
    const forbidden = createOrdersClient({ transport: scriptedTransport(reply(403, {})).transport });
    await assert.rejects(forbidden.getOrder("x"), (error: unknown) => error instanceof OrdersApiError && error.status === 403);
  });

  it("retries a 5xx or a network error once, then gives up", async () => {
    const recovers = scriptedTransport(reply(503, {}), reply(200, sampleBody()));
    assert.equal((await createOrdersClient({ transport: recovers.transport }).getOrder("ord-1")).id, "ord-1");
    assert.equal(recovers.urls.length, 2);

    const down = scriptedTransport(new TypeError("fetch failed"));
    await assert.rejects(createOrdersClient({ transport: down.transport }).getOrder("ord-1"), OrdersApiUnavailableError);
    assert.equal(down.urls.length, 2);

    const broken = scriptedTransport(reply(500, {}));
    await assert.rejects(createOrdersClient({ transport: broken.transport }).getOrder("ord-1"), OrdersApiError);
  });

  it("rejects an empty id without calling the API", async () => {
    const { transport, urls } = scriptedTransport(reply(200, sampleBody()));
    await assert.rejects(createOrdersClient({ transport }).getOrder(" "), RangeError);
    assert.equal(urls.length, 0);
  });
});

describe("contract checks (fail loudly)", () => {
  async function violations(body: unknown): Promise<string> {
    const client = createOrdersClient({ transport: scriptedTransport(reply(200, body)).transport });
    try {
      await client.getOrder("ord-1");
    } catch (error) {
      assert.ok(error instanceof ContractViolationError, String(error));
      return error.issues.join("\n");
    }
    assert.fail("expected a ContractViolationError");
  }

  it("rejects a response without lines (for example renamed to items)", async () => {
    const renamed = { ...without(sampleBody(), "lines"), items: sampleBody().lines };
    assert.match(await violations(renamed), /lines: expected an array, got missing/);
  });

  it("rejects lines that are not an array of well-formed objects", async () => {
    assert.match(await violations(sampleBody({ lines: "none" })), /lines: expected an array/);
    assert.match(await violations(sampleBody({ lines: [null] })), /lines\[0\]: expected an object/);
    assert.match(await violations(sampleBody({ lines: [{ sku: "A", name: "n", qty: 0, unitPriceCents: 1 }] })), /lines\[0\]\.qty/);
    assert.match(await violations(sampleBody({ lines: [{ sku: "A", qty: 1, unitPriceCents: 1 }] })), /lines\[0\]\.name/);
    assert.match(await violations(sampleBody({ lines: [{ sku: "A", name: "n", qty: 1, unitPriceCents: 4.99 }] })), /unitPriceCents/);
  });

  it("rejects totals that are missing, fractional (dollars) or negative", async () => {
    assert.match(await violations(without(sampleBody(), "totalCents")), /totalCents: expected an integer number of minor units, got missing/);
    assert.match(await violations(sampleBody({ totalCents: 24.97 })), /totalCents/);
    assert.match(await violations(sampleBody({ totalCents: -1 })), /totalCents/);
    assert.match(await violations(sampleBody({ totalCents: "2497" })), /totalCents/);
  });

  it("rejects missing id, status and currency, and non-object bodies", async () => {
    const issues = await violations(without(without(without(sampleBody(), "id"), "status"), "currency"));
    assert.equal(issues.split("\n").length, 3);
    await violations(null);
    await violations([sampleBody()]);
  });

  it("rejects a body that is not JSON", async () => {
    assert.match(await violations(new SyntaxError("Unexpected token")), /not valid JSON/);
  });

  it("ignores fields it does not use", async () => {
    const order = await createOrdersClient({
      transport: scriptedTransport(reply(200, sampleBody({ placedAt: undefined, extra: true }))).transport,
    }).getOrder("ord-1");
    assert.equal(order.status, "placed");
  });
});

describe("order summary view model", () => {
  it("formats money from cents", async () => {
    const storefront = createStorefront({ transport: scriptedTransport(reply(200, sampleBody())).transport });
    const summary = await storefront.getOrderSummary("ord-1");
    assert.equal(summary.total, "$24.97");
    assert.equal(summary.itemCount, 4);
    assert.equal(summary.statusLabel, "Order placed");
    assert.equal(summary.canCancel, true);
    assert.deepEqual(summary.lines[0], {
      sku: "CAB-1",
      name: "USB cable",
      quantity: 3,
      unitPrice: "$4.99",
      lineTotal: "$14.97",
    });
    assert.equal(describeOrder(summary), "4 items · $24.97 · Order placed");
  });

  it("formats euros and cancelled orders", async () => {
    const storefront = createStorefront({
      transport: scriptedTransport(
        reply(200, sampleBody({ currency: "EUR", status: "cancelled", totalCents: 1990, lines: [{ sku: "M", name: "Mug", qty: 1, unitPriceCents: 1990 }] })),
      ).transport,
    });
    const summary = await storefront.getOrderSummary("ord-1");
    assert.equal(summary.total, "€19.90");
    assert.equal(summary.statusLabel, "Cancelled");
    assert.equal(summary.canCancel, false);
    assert.equal(describeOrder(summary), "1 item · €19.90 · Cancelled");
  });

  it("shows unknown statuses capitalized", () => {
    const summary = buildOrderSummary({ id: "o", status: "shipped", currency: "USD", totalCents: 0, lines: [] });
    assert.equal(summary.statusLabel, "Shipped");
    assert.deepEqual(summary.badge, { label: "Shipped", tone: "success", ariaLabel: "Order status: shipped" });
    assert.equal(buildOrderSummary({ id: "o", status: "mystery", currency: "USD", totalCents: 0, lines: [] }).badge.tone, "neutral");
    assert.equal(buildOrderSummary({ id: "o", status: "toString", currency: "USD", totalCents: 0, lines: [] }).badge.tone, "neutral");
    assert.equal(summary.total, "$0.00");
  });
});

describe("formatMoney", () => {
  it("handles grouping, zero-decimal currencies and unknown currencies", () => {
    assert.equal(formatMoney(2497, "USD"), "$24.97");
    assert.equal(formatMoney(5, "USD"), "$0.05");
    assert.equal(formatMoney(123456789, "USD"), "$1,234,567.89");
    assert.equal(formatMoney(1980, "JPY"), "¥1,980");
    assert.equal(formatMoney(1050, "XYZ"), "10.50 XYZ");
    assert.equal(formatMoney(1990, "GBP"), "£19.90");
  });

  it("refuses non-integer or negative amounts", () => {
    assert.throws(() => formatMoney(24.97, "USD"), RangeError);
    assert.throws(() => formatMoney(-1, "USD"), RangeError);
  });
});

describe("cached client", () => {
  it("serves repeated reads from memory until the ttl expires", async () => {
    const { transport, urls } = scriptedTransport(reply(200, sampleBody()));
    let clock = 1_000;
    const client = withCache(createOrdersClient({ transport }), { ttlMs: 500, now: () => clock });
    await client.getOrder("ord-1");
    clock += 400;
    await client.getOrder("ord-1");
    assert.equal(urls.length, 1);
    clock += 200;
    await client.getOrder("ord-1");
    assert.equal(urls.length, 2);
    client.invalidate("ord-1");
    await client.getOrder("ord-1");
    assert.equal(urls.length, 3);
  });

  it("shares concurrent reads, never caches failures and evicts the oldest entry", async () => {
    const shared = scriptedTransport(reply(200, sampleBody()));
    const client = withCache(createOrdersClient({ transport: shared.transport }), { ttlMs: 1000, maxEntries: 1 });
    await Promise.all([client.getOrder("a"), client.getOrder("a")]);
    assert.equal(shared.urls.length, 1);
    await client.getOrder("b");
    await client.getOrder("a");
    assert.equal(shared.urls.length, 3);

    const failing = scriptedTransport(reply(404, {}), reply(200, sampleBody()));
    const retrying = withCache(createOrdersClient({ transport: failing.transport }), { ttlMs: 1000 });
    await assert.rejects(retrying.getOrder("ord-1"), OrderNotFoundError);
    assert.equal((await retrying.getOrder("ord-1")).id, "ord-1");
  });

  it("is used by createStorefront when cacheTtlMs is set", async () => {
    const { transport, urls } = scriptedTransport(reply(200, sampleBody()));
    const storefront = createStorefront({ transport, cacheTtlMs: 10_000 });
    await storefront.getOrderSummary("ord-1");
    await storefront.getOrder("ord-1");
    assert.equal(urls.length, 1);
  });
});

describe("receipt", () => {
  it("renders the formatted view model as plain text", async () => {
    const storefront = createStorefront({ transport: scriptedTransport(reply(200, sampleBody())).transport });
    const lines = renderReceipt(await storefront.getOrderSummary("ord-1")).split(/\r?\n/);
    assert.equal(lines[0], "Meridian Retail");
    assert.equal(lines[1], "Order ord-1");
    assert.ok(lines.includes("USB cable"));
    assert.equal(lines.at(-1)?.startsWith("Total (4 items)"), true);
    assert.equal(lines.at(-1)?.endsWith("$24.97"), true);
    assert.equal(lines.at(-1)?.length, 44);
  });
});
