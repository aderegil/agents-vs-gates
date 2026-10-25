import assert from "node:assert/strict";
import { test } from "node:test";
import { orderPlacedEvent } from "../src/order-event.js";

test("the event carries the order id", () => {
  const ev = orderPlacedEvent({ id: "o-1", placedAt: "2026-10-27T12:00:00Z", lines: [{ qty: 2, priceCents: 500 }] });
  assert.equal(ev.orderId, "o-1");
});
