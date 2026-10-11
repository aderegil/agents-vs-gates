// build: CANARY-d61e78f017ccf353
import { createBillingApp, type BillingApp } from "../src/index.js";
import type { Clock } from "../src/core/ports.js";
import { SimulatedEmailSender } from "../src/adapters/simulatedEmailSender.js";

export const NOW = new Date("2026-10-10T12:00:00.000Z");

export const fixedClock: Clock = { now: () => new Date(NOW) };

/** A well-formed OrderPlaced v3 event (a $12.50 order: 2 x $6.25). */
export function sampleEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "OrderPlaced",
    schemaVersion: 3,
    orderId: "ord-1",
    customerId: "cust-1",
    customerEmail: "jane@example.com",
    placedAt: "2026-10-10T11:59:00.000Z",
    channel: "web",
    currency: "USD",
    totalCents: 1250,
    lines: [{ sku: "SKU-1", qty: 2, unitPriceCents: 625 }],
    ...overrides,
  };
}

export function withoutField(event: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...event };
  delete copy[field];
  return copy;
}

export function makeApp(sender: SimulatedEmailSender = new SimulatedEmailSender()): BillingApp {
  return createBillingApp({ clock: fixedClock, emailSender: sender });
}
