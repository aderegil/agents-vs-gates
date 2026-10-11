// CANARY-216c8b7177c4c660
import { test } from "node:test";
import assert from "node:assert/strict";
import { consumerStep, fixtures, FIXED_NOW, loadBilling } from "./_common.mjs";

async function invoiceFor(order) {
  const { createBillingApp } = await loadBilling();
  const billing = createBillingApp({ clock: { now: () => new Date(FIXED_NOW) } });
  const invoice = await consumerStep(`billing could not invoice order ${order.fixture.label}`, () =>
    billing.onOrderPlaced(order.placedEvent),
  );
  return { billing, invoice };
}

for (const key of ["a", "b"]) {
  test(`billing invoices order ${key.toUpperCase()} for the order total, in its currency`, async () => {
    const f = await fixtures();
    const order = f[key];
    const { invoice } = await invoiceFor(order);
    const label = order.fixture.label;
    assert.equal(
      invoice.amountCents,
      order.fixture.expectedTotalCents,
      `billing invoiced order ${label} for ${invoice.amountCents} cents, expected ${order.fixture.expectedTotalCents}`,
    );
    assert.equal(
      invoice.currency,
      order.fixture.currency,
      `billing invoiced order ${label} in ${invoice.currency}, expected ${order.fixture.currency}`,
    );
    assert.equal(
      invoice.orderId,
      order.id,
      `billing invoice refers to order ${invoice.orderId}, expected the placed order ${order.id}`,
    );
  });

  test(`billing emails the order ${key.toUpperCase()} invoice to the customerEmail`, async () => {
    const f = await fixtures();
    const order = f[key];
    const { billing, invoice } = await invoiceFor(order);
    const label = order.fixture.label;
    assert.equal(
      invoice.customerEmail,
      order.fixture.customerEmail,
      `billing recorded ${invoice.customerEmail} as the recipient of order ${label}, expected ${order.fixture.customerEmail}`,
    );
    const sent = billing.sentEmails;
    assert.equal(sent.length, 1, `billing sent ${sent.length} emails for order ${label}, expected exactly 1`);
    assert.equal(
      sent[0].to,
      order.fixture.customerEmail,
      `billing sent the invoice for order ${label} to ${sent[0].to}, expected ${order.fixture.customerEmail}`,
    );
  });
}

test("billing invoices A and B side by side in one app without mixing them up", async () => {
  const { createBillingApp } = await loadBilling();
  const f = await fixtures();
  const billing = createBillingApp();
  const invoiceA = await consumerStep("billing could not invoice order A", () => billing.onOrderPlaced(f.a.placedEvent));
  const invoiceB = await consumerStep("billing could not invoice order B", () => billing.onOrderPlaced(f.b.placedEvent));
  assert.deepEqual(
    [invoiceA.amountCents, invoiceA.currency, invoiceB.amountCents, invoiceB.currency],
    [2497, "USD", 1990, "EUR"],
    "billing produced wrong amounts or currencies for orders A and B",
  );
  assert.deepEqual(
    billing.sentEmails.map((email) => email.to).sort(),
    [f.a.fixture.customerEmail, f.b.fixture.customerEmail].sort(),
    "billing did not email each customer exactly once",
  );
});
