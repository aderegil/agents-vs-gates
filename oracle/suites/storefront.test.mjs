// CANARY-f383584d82151f6c
import { test } from "node:test";
import assert from "node:assert/strict";
import { consumerStep, fixtures, loadStorefront } from "./_common.mjs";

/** Maps the storefront client's HTTP call onto the in-process orders-service. */
function transportFor(app) {
  return async (url, init) => {
    const { pathname, search } = new URL(url);
    const result = await app.handle((init?.method ?? "GET").toUpperCase(), pathname + search);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
    };
  };
}

async function summaryFor(order, app) {
  const { createOrdersClient, buildOrderSummary } = await loadStorefront();
  const client = createOrdersClient({ baseUrl: "https://orders.checkout.internal", transport: transportFor(app) });
  const label = order.fixture.label;
  const fetched = await consumerStep(`storefront could not fetch order ${label}`, () => client.getOrder(order.id));
  const summary = await consumerStep(`storefront could not summarize order ${label}`, async () =>
    buildOrderSummary(fetched),
  );
  return { fetched, summary };
}

test("storefront lists the lines of order A and shows $24.97", async () => {
  const f = await fixtures();
  const { summary } = await summaryFor(f.a, f.app);
  assert.equal(summary.lines.length, 2, `storefront lists ${summary.lines.length} lines for order A, expected 2`);
  assert.deepEqual(
    summary.lines.map((l) => [l.sku, l.name, l.quantity, l.unitPrice, l.lineTotal]),
    [
      ["SKU-TEE", "Logo T-Shirt", 3, "$4.99", "$14.97"],
      ["SKU-MUG", "Ceramic Mug", 1, "$10.00", "$10.00"],
    ],
    "storefront does not list the lines of order A as 3 x $4.99 and 1 x $10.00",
  );
  assert.equal(summary.itemCount, 4, `storefront counts ${summary.itemCount} items for order A, expected 4`);
  assert.equal(summary.total, "$24.97", `storefront shows ${summary.total} as the total of order A, expected $24.97`);
});

test("storefront lists the line of order B and shows €19.90", async () => {
  const f = await fixtures();
  const { summary } = await summaryFor(f.b, f.app);
  assert.equal(summary.lines.length, 1, `storefront lists ${summary.lines.length} lines for order B, expected 1`);
  assert.deepEqual(
    summary.lines.map((l) => [l.sku, l.name, l.quantity, l.unitPrice]),
    [["SKU-BOOK", "Architecture Handbook", 1, "€19.90"]],
    "storefront does not list the line of order B as 1 x €19.90",
  );
  assert.equal(
    summary.total,
    "€19.90",
    `storefront shows ${summary.total} as the total of order B, expected €19.90`,
  );
});

test("storefront receipt for each order shows its lines and total", async () => {
  const f = await fixtures();
  const { renderReceipt } = await loadStorefront();
  for (const order of [f.a, f.b]) {
    const label = order.fixture.label;
    const { summary } = await summaryFor(order, f.app);
    const receipt = await consumerStep(`storefront could not render the receipt of order ${label}`, async () =>
      renderReceipt(summary),
    );
    for (const line of order.fixture.lines) {
      assert.ok(receipt.includes(line.name), `storefront receipt of order ${label} does not list "${line.name}"`);
    }
    assert.ok(
      receipt.includes(order.fixture.expectedTotalDisplay),
      `storefront receipt of order ${label} does not show ${order.fixture.expectedTotalDisplay}`,
    );
  }
});

test("storefront facade (createStorefront) shows both totals through the same transport", async () => {
  const f = await fixtures();
  const { createStorefront } = await loadStorefront();
  const store = createStorefront({ transport: transportFor(f.app) });
  for (const order of [f.a, f.b]) {
    const label = order.fixture.label;
    const summary = await consumerStep(`storefront could not load the summary of order ${label}`, () =>
      store.getOrderSummary(order.id),
    );
    assert.equal(
      summary.total,
      order.fixture.expectedTotalDisplay,
      `storefront shows ${summary.total} for order ${label}, expected ${order.fixture.expectedTotalDisplay}`,
    );
  }
});
