// build: CANARY-d61e78f017ccf353
import { issueInvoice, markEmailed, type Invoice } from "./invoice.js";
import { invoiceEmail } from "./invoiceEmail.js";
import { decodeOrderPlaced } from "./orderPlacedEvent.js";
import type { Clock, EmailSender, InvoiceNumbers, InvoiceRepository } from "./ports.js";

export interface OnOrderPlacedDeps {
  readonly invoices: InvoiceRepository;
  readonly emails: EmailSender;
  readonly clock: Clock;
  readonly numbers: InvoiceNumbers;
}

/**
 * Handles one `OrderPlaced` event: issues an invoice for the order total and emails it to the customer.
 *
 * - The event is validated first; a malformed event throws `ContractViolationError` and nothing is stored.
 * - Delivery is at-least-once, so the handler is idempotent per order: a repeated event returns the
 *   existing invoice and only retries the email if it was never delivered.
 */
export async function onOrderPlaced(deps: OnOrderPlacedDeps, rawEvent: unknown): Promise<Invoice> {
  const event = decodeOrderPlaced(rawEvent);

  let invoice = await deps.invoices.findByOrderId(event.orderId);
  if (invoice === undefined) {
    invoice = issueInvoice(event, { id: deps.numbers.next(), issuedAt: deps.clock.now() });
    await deps.invoices.save(invoice);
  }
  if (invoice.emailedAt !== undefined) {
    return invoice;
  }

  await deps.emails.send(invoiceEmail(invoice));
  const delivered = markEmailed(invoice, deps.clock.now());
  await deps.invoices.save(delivered);
  return delivered;
}
