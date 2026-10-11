// build: CANARY-d61e78f017ccf353
import { isOverdue, markPaid, markReminded, type Invoice } from "./invoice.js";
import { reminderEmail } from "./invoiceEmail.js";
import { InvoiceNotFoundError } from "./errors.js";
import type { Clock, EmailSender, InvoiceRepository } from "./ports.js";

export interface FinanceDeps {
  readonly invoices: InvoiceRepository;
  readonly emails: EmailSender;
  readonly clock: Clock;
}

export interface ReminderReport {
  /** Ids of the invoices a reminder was delivered for. */
  readonly sent: readonly string[];
  /** Invoices whose reminder could not be delivered; they are retried on the next run. */
  readonly failed: ReadonlyArray<{ readonly invoiceId: string; readonly reason: string }>;
}

/**
 * Sends one reminder for every overdue invoice that has not had one.
 * A failing delivery does not stop the run: it is reported and retried next time.
 */
export async function sendOverdueReminders(deps: FinanceDeps): Promise<ReminderReport> {
  const now = deps.clock.now();
  const sent: string[] = [];
  const failed: Array<{ invoiceId: string; reason: string }> = [];

  for (const invoice of await deps.invoices.list()) {
    if (!isOverdue(invoice, now) || invoice.reminderSentAt !== undefined) {
      continue;
    }
    try {
      await deps.emails.send(reminderEmail(invoice, now));
      await deps.invoices.save(markReminded(invoice, now));
      sent.push(invoice.id);
    } catch (error) {
      failed.push({ invoiceId: invoice.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { sent, failed };
}

/** Records that an invoice was paid. */
export async function recordPayment(deps: Pick<FinanceDeps, "invoices" | "clock">, invoiceId: string): Promise<Invoice> {
  const invoice = await deps.invoices.findById(invoiceId);
  if (invoice === undefined) {
    throw new InvoiceNotFoundError(invoiceId);
  }
  const paid = markPaid(invoice, deps.clock.now());
  await deps.invoices.save(paid);
  return paid;
}
