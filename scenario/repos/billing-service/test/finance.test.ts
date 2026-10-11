// build: CANARY-d61e78f017ccf353
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SimulatedEmailSender } from "../src/adapters/simulatedEmailSender.js";
import { EmailDeliveryError } from "../src/core/errors.js";
import type { EmailSender } from "../src/core/ports.js";
import { isOverdue, markPaid, type Invoice } from "../src/core/invoice.js";
import { createBillingApp } from "../src/index.js";
import { NOW, sampleEvent } from "./helpers.js";

function appWithClock(sender: EmailSender = new SimulatedEmailSender()) {
  let current = new Date(NOW);
  const app = createBillingApp({ emailSender: sender, clock: { now: () => new Date(current) } });
  return { app, sender: sender as SimulatedEmailSender, travel: (days: number) => (current = new Date(NOW.getTime() + days * 86_400_000)) };
}

describe("overdue reminders", () => {
  it("does not remind before the due date and reminds once after it", async () => {
    const { app, sender, travel } = appWithClock();
    await app.onOrderPlaced(sampleEvent());

    travel(29);
    assert.deepEqual(await app.sendOverdueReminders(), { sent: [], failed: [] });

    travel(35);
    assert.deepEqual(await app.sendOverdueReminders(), { sent: ["INV-000001"], failed: [] });
    assert.equal(sender.outbox.length, 2);
    assert.match(sender.outbox[1]?.subject ?? "", /overdue/);
    assert.match(sender.outbox[1]?.body ?? "", /12\.50 USD/);

    assert.deepEqual(await app.sendOverdueReminders(), { sent: [], failed: [] });
    assert.equal(sender.outbox.length, 2);
  });

  it("reports a failed reminder, keeps going and retries it on the next run", async () => {
    const delivered: string[] = [];
    let sends = 0;
    const flaky: EmailSender = {
      async send(message) {
        sends += 1;
        if (sends === 3) {
          throw new EmailDeliveryError("provider timeout");
        }
        delivered.push(message.subject);
      },
    };
    const { app, travel } = appWithClock(flaky);
    await app.onOrderPlaced(sampleEvent());
    await app.onOrderPlaced(sampleEvent({ orderId: "ord-2" }));

    travel(40);
    const first = await app.sendOverdueReminders();
    assert.deepEqual(first.sent, ["INV-000002"]);
    assert.deepEqual(first.failed, [{ invoiceId: "INV-000001", reason: "provider timeout" }]);

    const second = await app.sendOverdueReminders();
    assert.deepEqual(second, { sent: ["INV-000001"], failed: [] });
    assert.equal(delivered.filter((subject) => /overdue/.test(subject)).length, 2);
  });
});

describe("recording payments", () => {
  it("marks an invoice as paid once and stops reminders", async () => {
    const { app, sender, travel } = appWithClock();
    await app.onOrderPlaced(sampleEvent());

    const paid = await app.handle("POST", "/invoices/INV-000001/paid");
    assert.equal(paid.status, 200);
    assert.equal((paid.body as { status: string }).status, "paid");
    assert.equal((await app.handle("POST", "/invoices/INV-000001/paid")).status, 409);
    assert.equal((await app.handle("POST", "/invoices/INV-404/paid")).status, 404);
    assert.equal((await app.handle("GET", "/invoices/INV-000001/paid")).status, 405);

    travel(60);
    assert.deepEqual(await app.sendOverdueReminders(), { sent: [], failed: [] });
    assert.equal(sender.outbox.length, 1);
  });

  it("derives overdue from status and due date", () => {
    const invoice: Invoice = {
      id: "INV-1",
      orderId: "o",
      customerId: "c",
      customerEmail: "a@b.co",
      amountCents: 100,
      currency: "USD",
      status: "issued",
      issuedAt: "2026-01-01T00:00:00.000Z",
      dueAt: "2026-01-31T00:00:00.000Z",
    };
    assert.equal(isOverdue(invoice, new Date("2026-01-30T00:00:00.000Z")), false);
    assert.equal(isOverdue(invoice, new Date("2026-02-01T00:00:00.000Z")), true);
    assert.equal(isOverdue(markPaid(invoice, new Date("2026-01-15T00:00:00.000Z")), new Date("2026-02-01T00:00:00.000Z")), false);
  });
});
