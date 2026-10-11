// build: CANARY-d61e78f017ccf353
import type { Invoice } from "./invoice.js";

export interface InvoiceRepository {
  save(invoice: Invoice): Promise<void>;
  findById(id: string): Promise<Invoice | undefined>;
  findByOrderId(orderId: string): Promise<Invoice | undefined>;
  list(): Promise<Invoice[]>;
}

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** Sends an email. Throws `EmailDeliveryError` when the message could not be delivered. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface Clock {
  now(): Date;
}

/** Produces invoice numbers, e.g. `INV-000042`. */
export interface InvoiceNumbers {
  next(): string;
}
