"""Generates the sample 'orders-service' repo used by the drift experiment."""
from pathlib import Path

ROOT = Path(__file__).parent
T = ROOT / "template"

FILES = {
"package.json": """{
  "name": "orders-service",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit -p .",
    "arch": "depcruise src --config .dependency-cruiser.cjs && node scripts/no-network-outside-adapters.mjs"
  }
}
""",
"tsconfig.json": """{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "noEmit": true, "types": ["node"], "lib": ["ES2022", "DOM"] }, "include": ["src"] }
""",
".dependency-cruiser.cjs": """/** Architecture rules. Each rule name starts with its ID in the spec. */
module.exports = {
  forbidden: [
    {
      name: "ARCH-1-core-is-independent",
      comment: "ARCH-1: core/ never depends on api/ or adapters/.",
      severity: "error",
      from: { path: "^src/core" },
      to: { path: "^src/(api|adapters)" }
    },
    {
      name: "ARCH-2-api-goes-through-core",
      comment: "ARCH-2: api/ never imports adapters/ directly; it goes through core/.",
      severity: "error",
      from: { path: "^src/api" },
      to: { path: "^src/adapters" }
    },
    {
      name: "ARCH-3-only-adapters-do-io",
      comment: "ARCH-3: only adapters/ talk to external systems.",
      severity: "error",
      from: { path: "^src/(core|api)" },
      to: { path: "^(node:)?(http|https|net|tls|dgram)$" }
    }
  ],
  options: { doNotFollow: { path: "node_modules" }, tsPreCompilationDeps: true }
};
""",
"scripts/no-network-outside-adapters.mjs": """// ARCH-3 (part 2): the global fetch() is also I/O. Only adapters/ may call it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const offenders = [];
function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\\.ts$/.test(f)) {
      readFileSync(p, "utf8").split(/\\r?\\n/).forEach((line, i) => {
        if (/\\bfetch\\s*\\(/.test(line)) offenders.push(`${p.replace(/\\\\/g, "/")}:${i + 1}: ${line.trim()}`);
      });
    }
  }
}
for (const d of ["src/core", "src/api"]) { try { walk(d); } catch {} }
if (offenders.length) {
  console.error("ARCH-3-only-adapters-do-io violated: fetch() outside src/adapters");
  offenders.forEach(o => console.error("  " + o));
  process.exit(1);
}
console.log("ARCH-3 fetch check: ok");
""",
"src/core/order.ts": """export interface OrderLine {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export type OrderStatus = "NEW" | "PLACED" | "PAID" | "REJECTED";

export interface Order {
  id: string;
  customerEmail: string;
  lines: OrderLine[];
  status: OrderStatus;
}

export function totalCents(order: Order): number {
  return order.lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
}
""",
"src/core/ports.ts": """import type { Order } from "./order.js";

export interface OrderRepository {
  save(order: Order): Promise<void>;
  findById(id: string): Promise<Order | undefined>;
}

export interface PaymentPort {
  charge(orderId: string, amountCents: number): Promise<{ ok: boolean; reference: string }>;
}
""",
"src/core/orderService.ts": """import { type Order, totalCents } from "./order.js";
import type { OrderRepository, PaymentPort } from "./ports.js";

export class OrderService {
  constructor(
    private readonly repo: OrderRepository,
    private readonly payments: PaymentPort,
  ) {}

  async placeOrder(order: Order): Promise<Order> {
    if (order.lines.length === 0) throw new Error("Order has no lines");
    const placed: Order = { ...order, status: "PLACED" };
    await this.repo.save(placed);
    return placed;
  }

  async pay(orderId: string): Promise<Order> {
    const order = await this.repo.findById(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    const result = await this.payments.charge(order.id, totalCents(order));
    const paid: Order = { ...order, status: result.ok ? "PAID" : order.status };
    await this.repo.save(paid);
    return paid;
  }
}
""",
"src/adapters/inMemoryOrderRepository.ts": """import type { Order } from "../core/order.js";
import type { OrderRepository } from "../core/ports.js";

export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, Order>();
  async save(order: Order): Promise<void> {
    this.orders.set(order.id, order);
  }
  async findById(id: string): Promise<Order | undefined> {
    return this.orders.get(id);
  }
}
""",
"src/adapters/httpPaymentGateway.ts": """import type { PaymentPort } from "../core/ports.js";

export class HttpPaymentGateway implements PaymentPort {
  constructor(private readonly baseUrl = "https://payments.example.com") {}
  async charge(orderId: string, amountCents: number) {
    const res = await fetch(`${this.baseUrl}/charges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId, amountCents }),
    });
    const body = (await res.json()) as { reference: string };
    return { ok: res.ok, reference: body.reference };
  }
}
""",
"src/adapters/smtpEmailClient.ts": """import * as net from "node:net";

/** Minimal SMTP client used by the ops team. */
export class SmtpEmailClient {
  constructor(private readonly host = "smtp.internal.example.com", private readonly port = 25) {}

  async send(to: string, subject: string, body: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.port, this.host, () => {
        socket.write(`MAIL FROM:<orders@example.com>\\r\\nRCPT TO:<${to}>\\r\\nDATA\\r\\nSubject: ${subject}\\r\\n\\r\\n${body}\\r\\n.\\r\\nQUIT\\r\\n`);
        socket.end();
        resolve();
      });
      socket.on("error", reject);
    });
  }
}
""",
"src/adapters/fxRatesClient.ts": """/** Reads FX rates from the treasury service. */
export async function getRate(from: string, to: string): Promise<number> {
  const res = await fetch(`https://fx.treasury.example.com/rates?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`FX service error ${res.status}`);
  const body = (await res.json()) as { rate: number };
  return body.rate;
}
""",
"src/api/ordersController.ts": """import type { Order } from "../core/order.js";
import { totalCents } from "../core/order.js";
import type { OrderService } from "../core/orderService.js";

export interface HttpRequest { body: unknown; params: Record<string, string> }
export interface HttpResponse { status: number; body: unknown }

export class OrdersController {
  constructor(private readonly service: OrderService) {}

  /** POST /orders */
  async create(req: HttpRequest): Promise<HttpResponse> {
    const order = req.body as Order;
    try {
      const placed = await this.service.placeOrder({ ...order, status: "NEW" });
      return { status: 201, body: { id: placed.id, status: placed.status, totalCents: totalCents(placed) } };
    } catch (e) {
      return { status: 400, body: { error: (e as Error).message } };
    }
  }

  /** POST /orders/:id/pay */
  async pay(req: HttpRequest): Promise<HttpResponse> {
    const paid = await this.service.pay(req.params.id);
    return { status: 200, body: { id: paid.id, status: paid.status } };
  }
}
""",
"src/main.ts": """// Composition root: the only place that wires adapters into core and api.
import { InMemoryOrderRepository } from "./adapters/inMemoryOrderRepository.js";
import { HttpPaymentGateway } from "./adapters/httpPaymentGateway.js";
import { OrderService } from "./core/orderService.js";
import { OrdersController } from "./api/ordersController.js";

export function buildApp() {
  const service = new OrderService(new InMemoryOrderRepository(), new HttpPaymentGateway());
  return { orders: new OrdersController(service) };
}
""",
}

if __name__ == "__main__":
    for rel, content in FILES.items():
        p = T / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8", newline="\n")
    (ROOT / "package.json").write_text(
        '{ "name": "exp-root", "private": true, "type": "module", "devDependencies": '
        '{ "dependency-cruiser": "^16.0.0", "typescript": "^5.6.0", "@types/node": "^22.0.0" } }\n',
        encoding="utf-8")
    print("template written:", len(FILES), "files")
# CANARY-24ad572afb0dcd7d
