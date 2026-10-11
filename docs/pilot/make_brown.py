"""Brownfield variant: same service, plus two legacy violations frozen in a baseline
(dependency-cruiser --ignore-known, the equivalent of ArchUnit's FreezingArchRule).
New violations still fail the check."""
import json, shutil, subprocess
from pathlib import Path

ROOT = Path(__file__).parent
SRC, DST = ROOT / "template", ROOT / "template-brown"
NPM = shutil.which("npm") or "npm"

if DST.exists():
    shutil.rmtree(DST)
shutil.copytree(SRC, DST)

(DST / "src/adapters/auditLogger.ts").write_text('''/** Writes audit events to the compliance log service. */
export async function audit(event: string, data: Record<string, unknown>): Promise<void> {
  await fetch("https://audit.internal.example.com/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, data, at: new Date().toISOString() }),
  });
}
''', encoding="utf-8", newline="\n")

svc = DST / "src/core/orderService.ts"
t = svc.read_text(encoding="utf-8")
t = t.replace('import type { OrderRepository, PaymentPort } from "./ports.js";',
              'import type { OrderRepository, PaymentPort } from "./ports.js";\n'
              '// TODO(legacy): audit should go through a port. Kept for the compliance deadline.\n'
              'import { audit } from "../adapters/auditLogger.js";')
t = t.replace('    await this.repo.save(placed);\n    return placed;',
              '    await this.repo.save(placed);\n    await audit("order.placed", { id: placed.id });\n    return placed;')
svc.write_text(t, encoding="utf-8", newline="\n")

ctl = DST / "src/api/ordersController.ts"
t = ctl.read_text(encoding="utf-8")
t = t.replace('import type { OrderService } from "../core/orderService.js";',
              'import type { OrderService } from "../core/orderService.js";\n'
              'import { HttpPaymentGateway } from "../adapters/httpPaymentGateway.js";')
t = t.replace('  /** POST /orders/:id/pay */',
              '  /** GET /health — pings the payment provider directly (legacy). */\n'
              '  async health(): Promise<HttpResponse> {\n'
              '    const gw = new HttpPaymentGateway();\n'
              '    return { status: 200, body: { payments: typeof gw.charge === "function" ? "up" : "down" } };\n'
              '  }\n\n'
              '  /** POST /orders/:id/pay */')
ctl.write_text(t, encoding="utf-8", newline="\n")

pkg = json.loads((DST / "package.json").read_text(encoding="utf-8"))
pkg["scripts"]["arch"] = ("depcruise src --config .dependency-cruiser.cjs --ignore-known "
                          "&& node scripts/no-network-outside-adapters.mjs")
(DST / "package.json").write_text(json.dumps(pkg, indent=2) + "\n", encoding="utf-8", newline="\n")

# Freeze today's violations as the known baseline.
r = subprocess.run([NPM, "exec", "--", "depcruise", "src", "--config", ".dependency-cruiser.cjs",
                    "--output-type", "baseline", "--output-to", ".dependency-cruiser-known-violations.json"],
                   cwd=DST, capture_output=True, text=True)
print("baseline rc", r.returncode, r.stderr[-500:])
print((DST / ".dependency-cruiser-known-violations.json").read_text(encoding="utf-8")[:800])
# CANARY-24ad572afb0dcd7d
