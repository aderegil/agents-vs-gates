// The reporting team's own test: it reads `placedAt`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { orderPlacedEvent } = await import(pathToFileURL(join(process.env.SERVICE_DIR, "src", "order-event.js")).href);
test("reporting dates the order", () => {
  const ev = orderPlacedEvent({ id: "o-9", placedAt: "2026-10-27T12:00:00Z", lines: [] });
  assert.equal(ev.placedAt, "2026-10-27T12:00:00Z");
});
