import { createApp, type App } from "../src/main.js";
import type { DomainEvent } from "../src/core/events.js";
import type {
  Clock,
  EventPublisher,
  IdGenerator,
  PaymentAuthorization,
  PaymentAuthorizationRequest,
  PaymentGateway,
} from "../src/core/ports.js";

export const FIXED_NOW = "2026-10-10T12:00:00.000Z";

export class CapturingPublisher implements EventPublisher {
  readonly events: DomainEvent[] = [];

  async publish(event: DomainEvent): Promise<void> {
    this.events.push(event);
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date = new Date(FIXED_NOW)) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequenceIds implements IdGenerator {
  private n = 0;

  nextId(): string {
    this.n += 1;
    return `ord-${this.n}`;
  }
}

export class FakePayments implements PaymentGateway {
  readonly requests: PaymentAuthorizationRequest[] = [];

  constructor(private readonly answer: PaymentAuthorization = { authorized: true, reference: "auth-1" }) {}

  async authorize(request: PaymentAuthorizationRequest): Promise<PaymentAuthorization> {
    this.requests.push(request);
    return this.answer;
  }
}

export interface TestApp {
  app: App;
  publisher: CapturingPublisher;
  payments: FakePayments;
  clock: FixedClock;
}

export function makeApp(payments: FakePayments = new FakePayments()): TestApp {
  const publisher = new CapturingPublisher();
  const clock = new FixedClock();
  const app = createApp({
    eventPublisher: publisher,
    clock,
    idGenerator: new SequenceIds(),
    paymentGateway: payments,
  });
  return { app, publisher, payments, clock };
}

export function placeOrderBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerId: "cust-1",
    customerEmail: "jane@example.com",
    channel: "web",
    currency: "USD",
    lines: [{ sku: "SKU-1", name: "Desk lamp", qty: 2, unitPriceCents: 625 }],
    ...overrides,
  };
}
