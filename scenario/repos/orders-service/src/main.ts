import { InMemoryOrderRepository } from "./adapters/inMemoryOrderRepository.js";
import { KafkaEventPublisher } from "./adapters/kafkaEventPublisher.js";
import { HttpPaymentGateway } from "./adapters/httpPaymentGateway.js";
import { RandomIdGenerator } from "./adapters/randomIdGenerator.js";
import { SystemClock } from "./adapters/systemClock.js";
import { createOrdersController } from "./api/ordersController.js";
import { OrderService } from "./core/orderService.js";
import type { Clock, EventPublisher, IdGenerator, OrderRepository, PaymentGateway } from "./core/ports.js";

/** Every dependency is optional; omitted ones fall back to the production adapters. */
export interface AppDeps {
  readonly orderRepository?: OrderRepository;
  readonly eventPublisher?: EventPublisher;
  readonly paymentGateway?: PaymentGateway;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
}

export interface App {
  /** Handles one request. Never rejects: failures become 4xx/5xx responses. */
  handle(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  /** The publisher the app writes to (the injected one, or the default buffering publisher). */
  events: EventPublisher;
}

/** Composition root: wires adapters into the core and exposes the REST handlers. */
export function createApp(deps: AppDeps = {}): App {
  const eventPublisher = deps.eventPublisher ?? new KafkaEventPublisher();
  const service = new OrderService({
    orders: deps.orderRepository ?? new InMemoryOrderRepository(),
    events: eventPublisher,
    payments: deps.paymentGateway ?? new HttpPaymentGateway(),
    clock: deps.clock ?? new SystemClock(),
    ids: deps.idGenerator ?? new RandomIdGenerator(),
  });
  const controller = createOrdersController(service);

  return {
    handle: (method, path, body) => controller.handle({ method, path, body }),
    events: eventPublisher,
  };
}
