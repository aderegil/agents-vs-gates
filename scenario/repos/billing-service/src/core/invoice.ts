// build: CANARY-d61e78f017ccf353
import { InvalidInvoiceStateError } from "./errors.js";
import type { OrderPlacedEvent } from "./orderPlacedEvent.js";

export type InvoiceStatus = "issued" | "paid";

export interface Invoice {
  readonly id: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly customerEmail: string;
  /** Equal to the order total (`totalCents` of the event), integer minor units. */
  readonly amountCents: number;
  readonly currency: string;
  readonly status: InvoiceStatus;
  readonly issuedAt: string;
  readonly dueAt: string;
  /** Set once the invoice email has been delivered. */
  readonly emailedAt?: string;
  /** Set once an overdue reminder has been sent (at most one per invoice). */
  readonly reminderSentAt?: string;
  readonly paidAt?: string;
}

export const PAYMENT_TERMS_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function issueInvoice(event: OrderPlacedEvent, meta: { id: string; issuedAt: Date }): Invoice {
  return {
    id: meta.id,
    orderId: event.orderId,
    customerId: event.customerId,
    customerEmail: event.customerEmail,
    amountCents: event.totalCents,
    currency: event.currency,
    status: "issued",
    issuedAt: meta.issuedAt.toISOString(),
    dueAt: new Date(meta.issuedAt.getTime() + PAYMENT_TERMS_DAYS * DAY_MS).toISOString(),
  };
}

export function markEmailed(invoice: Invoice, at: Date): Invoice {
  return { ...invoice, emailedAt: at.toISOString() };
}

export function markReminded(invoice: Invoice, at: Date): Invoice {
  return { ...invoice, reminderSentAt: at.toISOString() };
}

/** Records the payment of an issued invoice. A paid invoice cannot be paid again. */
export function markPaid(invoice: Invoice, at: Date): Invoice {
  if (invoice.status !== "issued") {
    throw new InvalidInvoiceStateError(invoice.id, invoice.status, "paid");
  }
  return { ...invoice, status: "paid", paidAt: at.toISOString() };
}

/** An issued invoice is overdue once its due date has passed. */
export function isOverdue(invoice: Invoice, now: Date): boolean {
  return invoice.status === "issued" && Date.parse(invoice.dueAt) < now.getTime();
}
