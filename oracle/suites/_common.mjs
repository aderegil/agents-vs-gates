// CANARY-216c8b7177c4c660
// Shared loading and fixtures for the consumer-side integration suites.
// Everything here is written from the consumers' point of view: the orders-service is a black box
// reached only through createApp(...).handle(...) and the events it publishes.
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

export function describeError(error) {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`;
  }
  return String(error);
}

/** Import a compiled ESM module whose absolute path is in the given environment variable. */
async function loadModule(envName, label) {
  const path = process.env[envName];
  if (!path) {
    assert.fail(`${label} module not found: environment variable ${envName} is not set`);
  }
  try {
    return await import(pathToFileURL(path).href);
  } catch (error) {
    assert.fail(`${label} module could not be loaded from ${path}: ${describeError(error)}`);
  }
}

export const loadOrders = () => loadModule("ORACLE_ORDERS_MODULE", "orders-service");
export const loadBilling = () => loadModule("ORACLE_BILLING_MODULE", "billing-service");
export const loadAnalytics = () => loadModule("ORACLE_ANALYTICS_MODULE", "analytics-ingest");
export const loadStorefront = () => loadModule("ORACLE_STOREFRONT_MODULE", "web-storefront");

/**
 * Run a consumer call; if it throws, fail with a plain-language message of what the consumer could not do.
 * Example: "billing could not invoice order A: ContractViolationError OrderPlaced contract violated: totalCents: ..."
 */
export async function consumerStep(what, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      throw error;
    }
    assert.fail(`${what}: ${describeError(error)}`);
  }
}

export const FIXED_NOW = "2026-10-10T12:00:00.000Z";

/** Fixture A: 3 x $4.99 + 1 x $10.00 = $24.97, USD, web. */
export const FIXTURE_A = Object.freeze({
  label: "A",
  customerId: "cust-alice-001",
  customerEmail: "alice@example.com",
  channel: "web",
  currency: "USD",
  lines: [
    { sku: "SKU-TEE", name: "Logo T-Shirt", qty: 3, unitPriceCents: 499 },
    { sku: "SKU-MUG", name: "Ceramic Mug", qty: 1, unitPriceCents: 1000 },
  ],
  expectedTotalCents: 2497,
  expectedUnits: 4,
  expectedTotalDisplay: "$24.97",
});

/** Fixture B: 1 x EUR 19.90, marketplace, cancelled after it is placed. */
export const FIXTURE_B = Object.freeze({
  label: "B",
  customerId: "cust-bruno-002",
  customerEmail: "bruno@example.com",
  channel: "marketplace",
  currency: "EUR",
  lines: [{ sku: "SKU-BOOK", name: "Architecture Handbook", qty: 1, unitPriceCents: 1990 }],
  expectedTotalCents: 1990,
  expectedUnits: 1,
  expectedTotalDisplay: "€19.90",
});

function requestBody(fixture) {
  return {
    customerId: fixture.customerId,
    customerEmail: fixture.customerEmail,
    channel: fixture.channel,
    currency: fixture.currency,
    lines: fixture.lines.map((line) => ({ ...line })),
  };
}

/**
 * Build an orders-service with fake edges, place fixtures A and B, cancel B.
 * Returns the app, the real response bodies and the real emitted events (attributed to the call that emitted them).
 */
export async function placeFixtures() {
  const { createApp } = await loadOrders();
  if (typeof createApp !== "function") {
    assert.fail("orders-service module does not export createApp");
  }

  const published = [];
  let idCounter = 0;
  const app = createApp({
    paymentGateway: { authorize: async () => ({ authorized: true, reference: "pay-ref-fixture" }) },
    eventPublisher: {
      publish: async (event) => {
        published.push(event);
      },
    },
    clock: { now: () => new Date(FIXED_NOW) },
    idGenerator: { nextId: () => `id-${String(++idCounter).padStart(4, "0")}` },
  });

  async function call(what, method, path, body, expectedStatus) {
    const before = published.length;
    const response = await app.handle(method, path, body);
    if (response.status !== expectedStatus) {
      assert.fail(
        `orders-service could not ${what}: expected status ${expectedStatus}, got ${response.status} ${JSON.stringify(response.body)}`,
      );
    }
    return { response, emitted: published.slice(before) };
  }

  async function place(fixture) {
    const { response, emitted } = await call(`place order ${fixture.label}`, "POST", "/orders", requestBody(fixture), 201);
    const id = response.body?.id ?? response.body?.orderId;
    if (typeof id !== "string" || id === "") {
      assert.fail(`orders-service response for order ${fixture.label} carries no order id: ${JSON.stringify(response.body)}`);
    }
    const placedEvent = emitted.find((e) => e?.type === "OrderPlaced");
    if (placedEvent === undefined) {
      assert.fail(
        `orders-service published no OrderPlaced event for order ${fixture.label} (emitted: ${JSON.stringify(emitted)})`,
      );
    }
    return { fixture, id, body: response.body, placedEvent };
  }

  const a = await place(FIXTURE_A);
  const b = await place(FIXTURE_B);

  const cancel = await call(
    "cancel order B",
    "POST",
    `/orders/${encodeURIComponent(b.id)}/cancel`,
    { reason: "customer request" },
    200,
  );
  const cancelledEvent = cancel.emitted.find((e) => e?.type === "OrderCancelled");
  if (cancelledEvent === undefined) {
    assert.fail(`orders-service published no OrderCancelled event for order B (emitted: ${JSON.stringify(cancel.emitted)})`);
  }
  b.cancelledEvent = cancelledEvent;

  return { app, a, b, published };
}

let cached;
/** Fixtures are placed once per test file; each test builds its own fresh consumer. */
export function fixtures() {
  cached ??= placeFixtures();
  return cached;
}
