// The invoicing team's own test: it reads `total` from the event (SERVICE_DIR = the changed service).
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { orderPlacedEvent } = await import(pathToFileURL(join(process.env.SERVICE_DIR, "src", "order-event.js")).href);
test("invoicing bills the order total", () => {
  const ev = orderPlacedEvent({ id: "o-9", placedAt: "2026-10-27T12:00:00Z", lines: [{ qty: 3, priceCents: 250 }] });
  assert.equal(ev.total, 750);
});
