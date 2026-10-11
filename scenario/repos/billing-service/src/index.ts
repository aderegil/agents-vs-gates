// build: CANARY-d61e78f017ccf353
import { InMemoryInvoiceRepository } from "./adapters/inMemoryInvoiceRepository.js";
import { SequentialInvoiceNumbers } from "./adapters/sequentialInvoiceNumbers.js";
import { SimulatedEmailSender } from "./adapters/simulatedEmailSender.js";
import { SystemClock } from "./adapters/systemClock.js";
import { createInvoicesController, type HttpResult } from "./api/invoicesController.js";
import { sendOverdueReminders, type ReminderReport } from "./core/reminders.js";
import { handleMessage, type BusMessage, type MessageResult } from "./api/messageHandler.js";
import type { Invoice } from "./core/invoice.js";
import { onOrderPlaced } from "./core/onOrderPlaced.js";
import type { Clock, EmailMessage, EmailSender, InvoiceNumbers, InvoiceRepository } from "./core/ports.js";

export type { BusMessage, Invoice, EmailMessage, MessageResult, ReminderReport };
export { ContractViolationError } from "./core/errors.js";

/** Every dependency is optional; omitted ones fall back to in-memory/simulated adapters. */
export interface BillingDeps {
  readonly invoiceRepository?: InvoiceRepository;
  readonly emailSender?: EmailSender;
  readonly clock?: Clock;
  readonly invoiceNumbers?: InvoiceNumbers;
}

export interface BillingApp {
  /** Issues and emails the invoice for an `OrderPlaced` event. Rejects when the event breaks the contract. */
  onOrderPlaced(event: unknown): Promise<Invoice>;
  /** Bus entry point: routes by topic; `orders.placed` is processed, other topics are ignored. */
  handleMessage(message: BusMessage): Promise<MessageResult>;
  /** Invoice API (`GET /invoices/{id}`, `GET /invoices?orderId=`, `POST /invoices/{id}/paid`). */
  handle(method: string, path: string): Promise<HttpResult>;
  /** Sends one reminder per overdue invoice that has none yet. */
  sendOverdueReminders(): Promise<ReminderReport>;
  /** Invoices issued so far. */
  invoices(): Promise<Invoice[]>;
  /** Emails delivered by the simulated sender (empty when a custom `emailSender` is injected). */
  readonly sentEmails: readonly EmailMessage[];
}

export function createBillingApp(deps: BillingDeps = {}): BillingApp {
  const invoiceRepository = deps.invoiceRepository ?? new InMemoryInvoiceRepository();
  const emailSender = deps.emailSender ?? new SimulatedEmailSender();
  const handlerDeps = {
    invoices: invoiceRepository,
    emails: emailSender,
    clock: deps.clock ?? new SystemClock(),
    numbers: deps.invoiceNumbers ?? new SequentialInvoiceNumbers(),
  };
  const controller = createInvoicesController({ invoices: invoiceRepository, clock: handlerDeps.clock });

  return {
    onOrderPlaced: (event) => onOrderPlaced(handlerDeps, event),
    handleMessage: (message) => handleMessage(handlerDeps, message),
    handle: (method, path) => controller.handle(method, path),
    sendOverdueReminders: () => sendOverdueReminders(handlerDeps),
    invoices: () => invoiceRepository.list(),
    get sentEmails() {
      return emailSender instanceof SimulatedEmailSender ? emailSender.outbox : [];
    },
  };
}

/** One-shot helper: processes a single `OrderPlaced` event with fresh in-memory dependencies. */
export function handleOrderPlaced(event: unknown, deps: BillingDeps = {}): Promise<Invoice> {
  return createBillingApp(deps).onOrderPlaced(event);
}
