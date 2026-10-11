// CANARY-e09fd4f6874fc540
import { test } from "node:test";
import assert from "node:assert/strict";
import { consumerStep, fixtures, loadAnalytics } from "./_common.mjs";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function assertParseableDate(value, what) {
  assert.equal(typeof value, "string", `${what} is not a string: ${JSON.stringify(value)}`);
  assert.ok(DATE_ONLY.test(value), `${what} is not a YYYY-MM-DD date: ${JSON.stringify(value)}`);
  assert.ok(!Number.isNaN(Date.parse(value)), `${what} cannot be parsed as a date: ${JSON.stringify(value)}`);
}

async function ingestPlaced(order) {
  const { createAnalyticsIngest } = await loadAnalytics();
  const analytics = createAnalyticsIngest();
  const row = await consumerStep(`analytics could not ingest order ${order.fixture.label}`, () =>
    analytics.ingestOrderPlaced(order.placedEvent),
  );
  return { analytics, row };
}

for (const key of ["a", "b"]) {
  test(`analytics records order ${key.toUpperCase()} with the right channel, date and units`, async () => {
    const f = await fixtures();
    const order = f[key];
    const label = order.fixture.label;
    const { analytics, row } = await ingestPlaced(order);

    assert.equal(row.order_id, order.id, `analytics recorded order ${row.order_id}, expected ${order.id}`);
    assert.equal(
      row.channel,
      order.fixture.channel,
      `analytics recorded channel ${row.channel} for order ${label}, expected ${order.fixture.channel}`,
    );
    assertParseableDate(row.placed_date, `analytics placed_date for order ${label}`);
    assert.equal(
      row.units,
      order.fixture.expectedUnits,
      `analytics counted ${row.units} units for order ${label}, expected ${order.fixture.expectedUnits}`,
    );
    assert.equal(row.currency, order.fixture.currency, `analytics recorded currency ${row.currency} for order ${label}`);

    const stored = (await analytics.rows("orders")).filter((r) => r.order_id === order.id);
    assert.equal(stored.length, 1, `analytics lake holds ${stored.length} rows for order ${label}, expected 1`);
    assert.deepEqual(stored[0], row, `analytics lake row for order ${label} differs from the returned row`);
  });
}

test("analytics records the per-SKU units of order A", async () => {
  const f = await fixtures();
  const { analytics } = await ingestPlaced(f.a);
  const lines = (await analytics.rows("order_lines")).filter((r) => r.order_id === f.a.id);
  const unitsBySku = Object.fromEntries(lines.map((r) => [r.sku, r.units]));
  assert.deepEqual(
    unitsBySku,
    { "SKU-TEE": 3, "SKU-MUG": 1 },
    "analytics did not record order A's lines as 3 x SKU-TEE and 1 x SKU-MUG",
  );
});

test("analytics records the cancellation of order B", async () => {
  const f = await fixtures();
  const { createAnalyticsIngest } = await loadAnalytics();
  const analytics = createAnalyticsIngest();
  await consumerStep("analytics could not ingest order B", () => analytics.ingestOrderPlaced(f.b.placedEvent));
  const cancellation = await consumerStep("analytics could not ingest the cancellation of order B", () =>
    analytics.ingestOrderCancelled(f.b.cancelledEvent),
  );
  assert.equal(
    cancellation.order_id,
    f.b.id,
    `analytics recorded the cancellation for ${cancellation.order_id}, expected ${f.b.id}`,
  );
  assertParseableDate(cancellation.cancelled_date, "analytics cancelled_date for order B");

  const stored = await analytics.rows("order_cancellations");
  assert.deepEqual(
    stored.map((r) => r.order_id),
    [f.b.id],
    "analytics did not record exactly the cancellation of order B",
  );
});

test("analytics routes the emitted events by type (ingestEvent) and does not flag A as cancelled", async () => {
  const f = await fixtures();
  const { createAnalyticsIngest } = await loadAnalytics();
  const analytics = createAnalyticsIngest();
  for (const [what, event] of [
    ["order A placement", f.a.placedEvent],
    ["order B placement", f.b.placedEvent],
    ["order B cancellation", f.b.cancelledEvent],
  ]) {
    await consumerStep(`analytics could not route the ${what}`, () => analytics.ingestEvent(event));
  }
  const orders = await analytics.rows("orders");
  assert.equal(orders.length, 2, `analytics holds ${orders.length} orders, expected 2`);
  const cancelledIds = (await analytics.rows("order_cancellations")).map((r) => r.order_id);
  assert.ok(!cancelledIds.includes(f.a.id), "analytics recorded order A as cancelled, but only B was cancelled");
  assert.ok(cancelledIds.includes(f.b.id), "analytics did not record order B as cancelled");
});
