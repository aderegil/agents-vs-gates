"""Cross-repo variant: orders-service publishes an OrderPlaced event that services in OTHER
repositories consume. Their expectations live in a 'broker' folder outside the repo (as a Pact
Broker would hold them). CI verifies every deployed consumer's contract (ARCH-4)."""
import json, shutil
from pathlib import Path

ROOT = Path(__file__).parent
SRC, DST = ROOT / "template", ROOT / "template-xrepo"
BROKER = ROOT / "broker"

if DST.exists():
    shutil.rmtree(DST)
shutil.copytree(SRC, DST)

(DST / "src/core/events.ts").write_text('''import { type Order, totalCents } from "./order.js";

/** Published to the orders.placed topic when an order is placed. */
export interface OrderPlaced {
  type: "OrderPlaced";
  orderId: string;
  customerEmail: string;
  totalCents: number;
  placedAt: string;
}

export function toOrderPlaced(order: Order, now: Date): OrderPlaced {
  return {
    type: "OrderPlaced",
    orderId: order.id,
    customerEmail: order.customerEmail,
    totalCents: totalCents(order),
    placedAt: now.toISOString(),
  };
}
''', encoding="utf-8", newline="\n")

ports = DST / "src/core/ports.ts"
ports.write_text(ports.read_text(encoding="utf-8").replace(
    'import type { Order } from "./order.js";',
    'import type { Order } from "./order.js";\nimport type { OrderPlaced } from "./events.js";') + '''
export interface EventPublisher {
  publish(topic: string, event: OrderPlaced): Promise<void>;
}
''', encoding="utf-8", newline="\n")

svc = DST / "src/core/orderService.ts"
t = svc.read_text(encoding="utf-8")
t = t.replace('import type { OrderRepository, PaymentPort } from "./ports.js";',
              'import type { EventPublisher, OrderRepository, PaymentPort } from "./ports.js";\n'
              'import { toOrderPlaced } from "./events.js";')
t = t.replace('    private readonly payments: PaymentPort,\n  ) {}',
              '    private readonly payments: PaymentPort,\n    private readonly events: EventPublisher,\n  ) {}')
t = t.replace('    await this.repo.save(placed);\n    return placed;',
              '    await this.repo.save(placed);\n'
              '    await this.events.publish("orders.placed", toOrderPlaced(placed, new Date()));\n'
              '    return placed;')
svc.write_text(t, encoding="utf-8", newline="\n")

(DST / "src/adapters/kafkaEventPublisher.ts").write_text('''import type { OrderPlaced } from "../core/events.js";
import type { EventPublisher } from "../core/ports.js";

export class KafkaEventPublisher implements EventPublisher {
  constructor(private readonly brokerUrl = "https://kafka-rest.internal.example.com") {}
  async publish(topic: string, event: OrderPlaced): Promise<void> {
    await fetch(`${this.brokerUrl}/topics/${topic}`, {
      method: "POST",
      headers: { "content-type": "application/vnd.kafka.json.v2+json" },
      body: JSON.stringify({ records: [{ key: event.orderId, value: event }] }),
    });
  }
}
''', encoding="utf-8", newline="\n")

main = DST / "src/main.ts"
t = main.read_text(encoding="utf-8")
t = t.replace('import { HttpPaymentGateway } from "./adapters/httpPaymentGateway.js";',
              'import { HttpPaymentGateway } from "./adapters/httpPaymentGateway.js";\n'
              'import { KafkaEventPublisher } from "./adapters/kafkaEventPublisher.js";')
t = t.replace('new OrderService(new InMemoryOrderRepository(), new HttpPaymentGateway())',
              'new OrderService(new InMemoryOrderRepository(), new HttpPaymentGateway(), new KafkaEventPublisher())')
main.write_text(t, encoding="utf-8", newline="\n")

(DST / "scripts/verify-consumer-contracts.mjs").write_text(r'''// ARCH-4: no change may break a deployed consumer of OrderPlaced.
// Consumer expectations are published by the consumers' own pipelines to the broker
// (outside this repository), the way a Pact Broker holds pacts.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const broker = resolve(process.env.CONTRACT_BROKER || "../../broker");
const out = ".ci-build";
rmSync(out, { recursive: true, force: true });
execSync(`npx tsc -p . --noEmit false --outDir ${out}`, { stdio: "inherit" });
const events = await import(pathToFileURL(resolve(out, "core/events.js")).href);
rmSync(out, { recursive: true, force: true });
if (typeof events.toOrderPlaced !== "function") {
  console.error("ARCH-4 check: src/core/events.ts no longer exports toOrderPlaced(order, now)");
  process.exit(1);
}
const sample = { id: "o-1", customerEmail: "a@example.com", status: "PLACED",
  lines: [{ sku: "SKU-1", quantity: 2, unitPriceCents: 1250 }] };
const event = events.toOrderPlaced(sample, new Date("2026-10-27T18:00:00Z"));
const rows = [];
for (const f of readdirSync(broker).filter(f => f.endsWith(".json"))) {
  const c = JSON.parse(readFileSync(join(broker, f), "utf8"));
  for (const [field, type] of Object.entries(c.requires)) {
    const actual = event[field] === undefined ? "missing" : typeof event[field];
    if (actual !== type) rows.push([c.consumer, c.version, field, type, actual]);
  }
}
if (rows.length) {
  console.error("ARCH-4-no-breaking-change-for-deployed-consumers violated: OrderPlaced");
  console.error("CONSUMER          | DEPLOYED | FIELD          | EXPECTS | GOT");
  for (const r of rows) console.error(r.map((v, i) => String(v).padEnd([17, 8, 14, 7, 7][i])).join(" | "));
  process.exit(1);
}
console.log("ARCH-4 consumer contracts: ok");
''', encoding="utf-8", newline="\n")

pkg = json.loads((DST / "package.json").read_text(encoding="utf-8"))
pkg["scripts"]["contracts"] = "node scripts/verify-consumer-contracts.mjs"
(DST / "package.json").write_text(json.dumps(pkg, indent=2) + "\n", encoding="utf-8", newline="\n")

BROKER.mkdir(exist_ok=True)
(BROKER / "billing-service.json").write_text(json.dumps({
    "consumer": "billing-service", "version": "4f1c2a", "event": "OrderPlaced",
    "requires": {"orderId": "string", "customerEmail": "string", "totalCents": "number"}}, indent=2), encoding="utf-8")
(BROKER / "analytics-service.json").write_text(json.dumps({
    "consumer": "analytics-service", "version": "9b20e7", "event": "OrderPlaced",
    "requires": {"orderId": "string", "totalCents": "number", "placedAt": "string"}}, indent=2), encoding="utf-8")
print("xrepo template + broker written")

# CI-only variant: the contract check is NOT in the repository. It lives in the CI system
# (ROOT/ci), so nothing inside the repo points the agent to the consumers.
CI = ROOT / "ci"
CI.mkdir(exist_ok=True)
shutil.copy(DST / "scripts/verify-consumer-contracts.mjs", CI / "verify-consumer-contracts.mjs")
HID = ROOT / "template-xrepo-ci"
if HID.exists():
    shutil.rmtree(HID)
shutil.copytree(DST, HID)
(HID / "scripts/verify-consumer-contracts.mjs").unlink()
pkg = json.loads((HID / "package.json").read_text(encoding="utf-8"))
pkg["scripts"].pop("contracts")
(HID / "package.json").write_text(json.dumps(pkg, indent=2) + "\n", encoding="utf-8", newline="\n")
print("CI-only variant written")
# CANARY-24ad572afb0dcd7d
