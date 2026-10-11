// build: CANARY-d61e78f017ccf353
import type { Invoice } from "../core/invoice.js";
import type { InvoiceRepository } from "../core/ports.js";

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly byId = new Map<string, Invoice>();

  async save(invoice: Invoice): Promise<void> {
    this.byId.set(invoice.id, structuredClone(invoice));
  }

  async findById(id: string): Promise<Invoice | undefined> {
    const found = this.byId.get(id);
    return found === undefined ? undefined : structuredClone(found);
  }

  async findByOrderId(orderId: string): Promise<Invoice | undefined> {
    for (const invoice of this.byId.values()) {
      if (invoice.orderId === orderId) {
        return structuredClone(invoice);
      }
    }
    return undefined;
  }

  async list(): Promise<Invoice[]> {
    return [...this.byId.values()].map((invoice) => structuredClone(invoice));
  }
}
