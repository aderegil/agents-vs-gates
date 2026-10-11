// build: CANARY-d61e78f017ccf353
import type { InvoiceNumbers } from "../core/ports.js";

/** Gap-free, process-local numbering: INV-000001, INV-000002, ... */
export class SequentialInvoiceNumbers implements InvoiceNumbers {
  private counter: number;

  constructor(start = 0) {
    this.counter = start;
  }

  next(): string {
    this.counter += 1;
    return `INV-${String(this.counter).padStart(6, "0")}`;
  }
}
