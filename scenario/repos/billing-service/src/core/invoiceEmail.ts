// build: CANARY-d61e78f017ccf353
import type { Invoice } from "./invoice.js";
import { formatAmount } from "./money.js";
import type { EmailMessage } from "./ports.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Builds the email that delivers an invoice to the customer. */
export function invoiceEmail(invoice: Invoice): EmailMessage {
  return {
    to: invoice.customerEmail,
    subject: `Invoice ${invoice.id} for order ${invoice.orderId}`,
    body: [
      "Thank you for your order with Meridian Retail.",
      "",
      `Invoice: ${invoice.id}`,
      `Order: ${invoice.orderId}`,
      `Amount due: ${formatAmount(invoice.amountCents, invoice.currency)}`,
      `Due date: ${invoice.dueAt.slice(0, 10)}`,
    ].join("\n"),
  };
}

/** Builds the reminder sent once an invoice is past its due date. */
export function reminderEmail(invoice: Invoice, now: Date): EmailMessage {
  const daysLate = Math.max(1, Math.floor((now.getTime() - Date.parse(invoice.dueAt)) / DAY_MS));
  return {
    to: invoice.customerEmail,
    subject: `Reminder: invoice ${invoice.id} is overdue`,
    body: [
      `Invoice ${invoice.id} for order ${invoice.orderId} was due on ${invoice.dueAt.slice(0, 10)} (${daysLate} day(s) ago).`,
      `Amount due: ${formatAmount(invoice.amountCents, invoice.currency)}`,
      "",
      "If you have already paid, please ignore this message.",
    ].join("\n"),
  };
}
