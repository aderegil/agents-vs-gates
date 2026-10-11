import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidStateError, ValidationError } from "../src/core/errors.js";
import { canCancel, cancel, createOrder, totalCents, type NewOrder } from "../src/core/order.js";

const META = { id: "ord-1", placedAt: "2026-10-10T12:00:00.000Z" };

function newOrder(overrides: Partial<NewOrder> = {}): NewOrder {
  return {
    customerId: "cust-1",
    customerEmail: "jane@example.com",
    channel: "web",
    currency: "USD",
    lines: [{ sku: "SKU-1", name: "Desk lamp", qty: 2, unitPriceCents: 625 }],
    ...overrides,
  };
}

function issuePaths(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    return error.issues.map((issue) => issue.path);
  }
  assert.fail("expected a ValidationError");
}

describe("createOrder", () => {
  it("builds a placed order and computes the total in cents", () => {
    const order = createOrder(
      newOrder({
        lines: [
          { sku: "A", name: "Cable", qty: 3, unitPriceCents: 499 },
          { sku: "B", name: "Adapter", qty: 1, unitPriceCents: 1000 },
        ],
      }),
      META,
    );
    assert.equal(order.status, "placed");
    assert.equal(order.placedAt, META.placedAt);
    assert.equal(totalCents(order), 2497);
  });

  it("requires at least one line", () => {
    assert.deepEqual(issuePaths(() => createOrder(newOrder({ lines: [] }), META)), ["lines"]);
  });

  it("rejects non-positive and fractional quantities and non-integer prices", () => {
    const bad = newOrder({
      lines: [
        { sku: "A", name: "x", qty: 0, unitPriceCents: 100 },
        { sku: "B", name: "x", qty: 1.5, unitPriceCents: 100 },
        { sku: "C", name: "x", qty: 1, unitPriceCents: 9.99 },
      ],
    });
    assert.deepEqual(issuePaths(() => createOrder(bad, META)), [
      "lines[0].qty",
      "lines[1].qty",
      "lines[2].unitPriceCents",
    ]);
  });

  it("reports every problem at once", () => {
    const paths = issuePaths(() =>
      createOrder(newOrder({ customerId: " ", customerEmail: "nope", currency: "ZZZ", channel: "fax" as never }), META),
    );
    assert.deepEqual(paths, ["customerId", "customerEmail", "channel", "currency"]);
  });

  it("bounds the order total", () => {
    const huge = newOrder({ lines: [{ sku: "A", name: "x", qty: 1000, unitPriceCents: 999_999 }] });
    assert.deepEqual(issuePaths(() => createOrder(huge, META)), ["lines"]);
  });
});

describe("cancel", () => {
  it("moves a placed order to cancelled once", () => {
    const placed = createOrder(newOrder(), META);
    const cancelled = cancel(placed, "2026-10-11T08:00:00.000Z");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelledAt, "2026-10-11T08:00:00.000Z");
    assert.equal(placed.status, "placed");
    assert.throws(() => cancel(cancelled, "2026-10-12T08:00:00.000Z"), InvalidStateError);
  });

  it("refuses to cancel after the cancellation window", () => {
    const placed = createOrder(newOrder(), META);
    assert.equal(canCancel(placed, "2026-11-09T12:00:00.000Z"), true);
    assert.throws(() => cancel(placed, "2026-11-10T12:00:01.000Z"), /cancellation window/);
  });
});
