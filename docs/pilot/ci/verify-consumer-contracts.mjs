// ARCH-4: no change may break a deployed consumer of OrderPlaced.
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
// CANARY-24ad572afb0dcd7d
