// Example acceptance check (--accept-cmd): is the ticket done in the changed service? SERVICE_DIR = the copy of the
// result, TICKET = the ticket's file name without its extension. Exit 0 = done.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { orderPlacedEvent } = await import(pathToFileURL(join(process.env.SERVICE_DIR, "src", "order-event.js")).href);
const ev = orderPlacedEvent({ id: "o-1", placedAt: "2026-10-27T12:00:00Z", lines: [{ qty: 2, priceCents: 500 }] });
const done = { "rename-total": ev.amountCents === 1000, "add-currency": ev.currency === "EUR" }[process.env.TICKET];
console.log(`${process.env.TICKET}: ${done ? "done" : "not done"}`);
process.exit(done ? 0 : 1);
