// build: CANARY-d61e78f017ccf353
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SimulatedEmailSender } from "../src/adapters/simulatedEmailSender.js";
import { ContractViolationError, EmailDeliveryError } from "../src/core/errors.js";
import { handleOrderPlaced } from "../src/index.js";
import { NOW, fixedClock, makeApp, sampleEvent, withoutField } from "./helpers.js";

describe("onOrderPlaced", () => {
  it("issues an invoice of 1250 cents for a $12.50 order and emails the customer", async () => {
    const sender = new SimulatedEmailSender();
    const app = makeApp(sender);
    const invoice = await app.onOrderPlaced(sampleEvent());

    assert.equal(invoice.amountCents, 1250);
    assert.equal(invoice.currency, "USD");
    assert.equal(invoice.orderId, "ord-1");
    assert.equal(invoice.id, "INV-000001");
    assert.equal(invoice.issuedAt, NOW.toISOString());
    assert.equal(invoice.dueAt, "2026-11-09T12:00:00.000Z");
    assert.equal(invoice.emailedAt, NOW.toISOString());

    assert.equal(sender.outbox.length, 1);
    assert.equal(sender.outbox[0]?.to, "jane@example.com");
    assert.match(sender.outbox[0]?.body ?? "", /Amount due: 12\.50 USD/);
  });

  it("keeps whole units for zero-decimal currencies", async () => {
    const sender = new SimulatedEmailSender();
    await makeApp(sender).onOrderPlaced(sampleEvent({ currency: "JPY", totalCents: 1980 }));
    assert.match(sender.outbox[0]?.body ?? "", /Amount due: 1980 JPY/);
  });

  it("is idempotent per order: a repeated event does not issue or send twice", async () => {
    const sender = new SimulatedEmailSender();
    const app = makeApp(sender);
    const first = await app.onOrderPlaced(sampleEvent());
    const second = await app.onOrderPlaced(sampleEvent());
    assert.equal(second.id, first.id);
    assert.equal((await app.invoices()).length, 1);
    assert.equal(sender.outbox.length, 1);
  });

  it("keeps the invoice when the email fails and retries the email on redelivery", async () => {
    const sender = new SimulatedEmailSender({ failFirst: 1 });
    const app = makeApp(sender);
    await assert.rejects(app.onOrderPlaced(sampleEvent()), EmailDeliveryError);
    assert.equal((await app.invoices()).length, 1);
    assert.equal(sender.outbox.length, 0);

    const retried = await app.onOrderPlaced(sampleEvent());
    assert.equal(retried.id, "INV-000001");
    assert.equal(sender.outbox.length, 1);
  });

  it("works through the one-shot helper with injected dependencies", async () => {
    const invoice = await handleOrderPlaced(sampleEvent({ totalCents: 2497 }), { clock: fixedClock });
    assert.equal(invoice.amountCents, 2497);
  });
});

describe("contract checks (fail loudly)", () => {
  async function violations(event: unknown): Promise<readonly string[]> {
    const sender = new SimulatedEmailSender();
    const app = makeApp(sender);
    try {
      await app.onOrderPlaced(event);
    } catch (error) {
      assert.ok(error instanceof ContractViolationError, String(error));
      assert.equal((await app.invoices()).length, 0, "nothing may be stored");
      assert.equal(sender.outbox.length, 0, "nothing may be sent");
      return error.issues;
    }
    assert.fail("expected a ContractViolationError");
  }

  it("rejects a missing totalCents", async () => {
    const issues = await violations(withoutField(sampleEvent(), "totalCents"));
    assert.match(issues.join(), /totalCents: expected an integer number of cents, got missing/);
  });

  it("rejects totalCents that is not an integer (dollars instead of cents)", async () => {
    const issues = await violations(sampleEvent({ totalCents: 12.5 }));
    assert.match(issues.join(), /totalCents/);
  });

  it("rejects totalCents of the wrong type, negative or unsafe", async () => {
    for (const bad of ["1250", null, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await violations(sampleEvent({ totalCents: bad }));
    }
  });

  it("rejects missing identity and currency fields, reporting all of them", async () => {
    const event = withoutField(withoutField(withoutField(sampleEvent(), "orderId"), "customerEmail"), "currency");
    const issues = await violations(event);
    assert.equal(issues.length, 3);
  });

  it("rejects other event types and non-object payloads", async () => {
    await violations(sampleEvent({ type: "OrderCancelled" }));
    await violations("OrderPlaced");
    await violations(null);
    await violations([sampleEvent()]);
  });

  it("ignores fields it does not use", async () => {
    const invoice = await makeApp().onOrderPlaced(sampleEvent({ channel: undefined, placedAt: undefined, lines: [] }));
    assert.equal(invoice.amountCents, 1250);
  });
});
