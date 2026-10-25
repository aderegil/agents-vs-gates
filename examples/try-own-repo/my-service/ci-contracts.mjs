// Example CI check: every field another team reads (contracts/consumers.json) is still in the event.
import { readFileSync } from "node:fs";
import { orderPlacedEvent } from "./src/order-event.js";

const contracts = JSON.parse(readFileSync(new URL("./contracts/consumers.json", import.meta.url), "utf8"));
const ev = orderPlacedEvent({ id: "o-1", placedAt: "2026-10-27T12:00:00Z", lines: [{ qty: 1, priceCents: 100 }] });
const missing = Object.entries(contracts).flatMap(([team, fields]) => fields.filter((f) => !(f in ev)).map((f) => `${team} needs ${f}`));
if (missing.length) {
  console.error("CONTRACT FAIL: " + missing.join("; "));
  process.exit(1);
}
console.log("CONTRACT PASS: every consumer field is present");
