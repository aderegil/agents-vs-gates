#!/usr/bin/env node
// Consumer-contract checker (ARCH-4 for events, ARCH-8 for REST).
//
// Loads the compiled service, exercises it through createApp with a fixed sample order
// (1 line, 2 x $6.25 USD, channel web), then cancels it, and checks every consumer contract:
// each `requires` entry must be present with the declared type.
//
//   node scripts/verify-contracts.mjs                       (in a workspace: run `npm run build` first)
//   node verify-contracts.mjs --main <dist/src/main.js> --contracts <dir> [--contract-file <f>]... [--json]
//
// Types: string, integer, number, boolean, array, object, iso-datetime, enum:a|b|c.
// A path segment `x[]` means "every element of array x" (the array must not be empty).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FIXED_NOW = "2026-10-10T12:00:00.000Z";
const SAMPLE_ORDER = {
  customerId: "cust-contract-1",
  customerEmail: "contract.check@example.com",
  channel: "web",
  currency: "USD",
  lines: [{ sku: "SKU-CHK-1", name: "Contract check lamp", qty: 2, unitPriceCents: 625 }],
};

function parseArgs(argv) {
  const out = { main: "dist/src/main.js", contracts: null, files: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--main") out.main = argv[++i];
    else if (a === "--contracts") out.contracts = argv[++i];
    else if (a === "--contract-file") out.files.push(argv[++i]);
    else if (a === "--json") out.json = true;
  }
  if (out.contracts === null && out.files.length === 0) out.contracts = "contracts/consumers";
  return out;
}

function loadContracts(args) {
  const files = [...args.files];
  if (args.contracts !== null) {
    if (existsSync(args.contracts)) {
      for (const name of readdirSync(args.contracts).sort()) {
        if (name.endsWith(".json")) files.push(join(args.contracts, name));
      }
    }
  }
  return files.map((file) => {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      return { file, data };
    } catch (error) {
      return { file, data: null, error: `cannot read contract: ${error.message}` };
    }
  });
}

// ---- exercising the service ---------------------------------------------------------------------------------
async function exercise(mainPath) {
  const result = { ok: false, error: null, placed: [], cancelled: [], getOrder: null, postStatus: null, notes: [] };
  let mod;
  try {
    mod = await import(pathToFileURL(resolve(mainPath)).href);
  } catch (error) {
    result.error = `cannot load ${mainPath}: ${error.message}`;
    return result;
  }
  if (typeof mod.createApp !== "function") {
    result.error = `createApp is not exported by ${mainPath}`;
    return result;
  }
  const published = [];
  let phase = "place";
  const publisher = {
    async publish(event) {
      published.push({ phase, event: JSON.parse(JSON.stringify(event)) });
    },
  };
  let now = Date.parse(FIXED_NOW);
  const clock = { now: () => new Date(now) };
  let n = 0;
  const idGenerator = { nextId: () => `ord-chk-${(n += 1)}` };
  const paymentGateway = { authorize: async () => ({ authorized: true, reference: "auth-chk-1" }) };
  let app;
  try {
    app = mod.createApp({ eventPublisher: publisher, clock, idGenerator, paymentGateway });
  } catch (error) {
    result.error = `createApp threw: ${error.message}`;
    return result;
  }
  if (!app || typeof app.handle !== "function") {
    result.error = "createApp did not return an app with handle()";
    return result;
  }
  try {
    const placed = await app.handle("POST", "/orders", structuredClone(SAMPLE_ORDER));
    result.postStatus = placed?.status ?? null;
    const id = placed?.body && typeof placed.body === "object" ? placed.body.id : undefined;
    if (placed?.status !== 201 && placed?.status !== 200) {
      result.notes.push(`POST /orders answered ${placed?.status}: ${JSON.stringify(placed?.body).slice(0, 300)}`);
    }
    if (typeof id === "string") {
      const got = await app.handle("GET", `/orders/${encodeURIComponent(id)}`);
      result.getOrder = { status: got?.status ?? null, body: got?.body === undefined ? undefined : JSON.parse(JSON.stringify(got.body)) };
      now += 60_000;
      phase = "cancel";
      const cancelled = await app.handle("POST", `/orders/${encodeURIComponent(id)}/cancel`, { reason: "contract check" });
      if (cancelled?.status !== 200) {
        result.notes.push(`POST /orders/{id}/cancel answered ${cancelled?.status}`);
      }
    } else {
      result.notes.push("POST /orders returned no order id");
    }
  } catch (error) {
    result.error = `exercising the service threw: ${error.message}`;
    return result;
  }
  // Fallback: an app that ignores the injected publisher but buffers serialized records on app.events.
  if (published.length === 0 && app.events && Array.isArray(app.events.records)) {
    for (const record of app.events.records) {
      try {
        published.push({ phase: "unknown", event: JSON.parse(record.value) });
      } catch {
        /* ignore */
      }
    }
  }
  result.events = published;
  result.ok = true;
  return result;
}

/** Events whose `type` is the contract name (consumers select events by type). */
function eventsFor(run, contract) {
  return (run.events ?? []).filter((e) => e.event && e.event.type === contract).map((e) => e.event);
}

function publishedTypes(run) {
  const types = [...new Set((run.events ?? []).map((e) => JSON.stringify(e.event?.type)))];
  return types.length ? types.join(", ") : "none";
}

// ---- validation -----------------------------------------------------------------------------------------------
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function typeOk(type, value) {
  if (type === "string") return typeof value === "string";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (type === "iso-datetime") return typeof value === "string" && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
  if (type.startsWith("enum:")) return type.slice(5).split("|").includes(value);
  return false;
}

function show(value) {
  if (value === undefined) return "undefined";
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Returns a list of problems for one required path. */
function checkPath(root, path, type, label) {
  const problems = [];
  const segments = path.split(".");
  const walk = (value, index, shown) => {
    if (index === segments.length) {
      if (value === undefined) problems.push(`${label}.${shown} missing (required ${type})`);
      else if (value === null) problems.push(`${label}.${shown} is null (required ${type})`);
      else if (!typeOk(type, value)) problems.push(`${label}.${shown} is ${show(value)} (required ${type})`);
      return;
    }
    const raw = segments[index];
    const isArray = raw.endsWith("[]");
    const key = isArray ? raw.slice(0, -2) : raw;
    const here = shown === "" ? key : `${shown}.${key}`;
    const container = value;
    if (container === null || typeof container !== "object" || Array.isArray(container)) {
      problems.push(`${label}.${shown || "(root)"} is ${show(container)} (required object containing ${path})`);
      return;
    }
    const next = container[key];
    if (!isArray) {
      if (index < segments.length - 1 && (next === undefined || next === null)) {
        problems.push(`${label}.${here} ${next === null ? "is null" : "missing"} (required object containing ${path})`);
        return;
      }
      walk(next, index + 1, here);
      return;
    }
    if (next === undefined) {
      problems.push(`${label}.${here} missing (required array for ${path})`);
      return;
    }
    if (!Array.isArray(next)) {
      problems.push(`${label}.${here} is ${show(next)} (required array for ${path})`);
      return;
    }
    if (next.length === 0) {
      problems.push(`${label}.${here} is empty (cannot satisfy ${path})`);
      return;
    }
    next.forEach((element, i) => walk(element, index + 1, `${here}[${i}]`));
  };
  walk(root, 0, "");
  return problems;
}

function checkContract(run, contract) {
  const c = contract.data ?? {};
  const name = String(c.contract ?? "");
  const consumer = String(c.consumer ?? "?");
  const isRest = /^(GET|POST|PUT|PATCH|DELETE)\s/.test(name);
  const rule = isRest ? "ARCH-8" : "ARCH-4";
  const base = { file: contract.file, consumer, contract: name, rule };
  if (contract.error || typeof c.requires !== "object" || c.requires === null) {
    return { ...base, status: "error", problems: [contract.error ?? "contract has no `requires` object"] };
  }
  if (!run.ok) {
    return { ...base, status: "error", problems: [run.error] };
  }
  const problems = [];
  const requires = Object.entries(c.requires);
  if (isRest) {
    const got = run.getOrder;
    if (!got) {
      problems.push(`${name} not exercised: ${run.notes.join("; ") || "no order to read"}`);
    } else if (got.status !== 200) {
      problems.push(`${name} answered ${got.status} (expected 200)`);
    } else {
      for (const [path, type] of requires) problems.push(...checkPath(got.body, path, String(type), name));
    }
  } else {
    const events = eventsFor(run, name);
    if (events.length === 0) {
      problems.push(
        `${name} not published by the sample order (event types published: ${publishedTypes(run)})` +
          (run.notes.length ? `; ${run.notes.join("; ")}` : ""),
      );
    }
    for (const event of events) {
      for (const [path, type] of requires) problems.push(...checkPath(event, path, String(type), name));
    }
  }
  return { ...base, status: problems.length === 0 ? "pass" : "fail", problems: [...new Set(problems)], fields: requires.length };
}

function formatLines(results) {
  const lines = [];
  for (const r of results) {
    if (r.status === "pass") {
      lines.push(`${r.rule} PASS ${r.consumer}: ${r.contract} (${r.fields} required fields present)`);
    } else {
      const word = r.status === "error" ? "ERROR" : "FAIL";
      for (const p of r.problems) lines.push(`${r.rule} ${word} ${r.consumer}: ${p}`);
    }
  }
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const contracts = loadContracts(args);
  if (!args.json && !existsSync(args.main)) {
    console.error(`verify-contracts: ${args.main} not found. Run \`npm run build\` first.`);
    process.exit(2);
  }
  const run = await exercise(args.main);
  const results = contracts.map((c) => checkContract(run, c));
  if (args.json) {
    process.stdout.write(
      JSON.stringify({
        probe: { ok: run.ok, error: run.error, notes: run.notes, postStatus: run.postStatus },
        captures: { events: run.events ?? [], getOrder: run.getOrder },
        results,
        lines: formatLines(results),
      }),
    );
    return;
  }
  const lines = formatLines(results);
  if (results.length === 0) lines.push("No consumer contracts found.");
  if (!run.ok) lines.unshift(`verify-contracts: ${run.error}`);
  console.log(lines.join("\n"));
  process.exitCode = results.every((r) => r.status === "pass") && run.ok ? 0 : 1;
}

main().catch((error) => {
  console.error(`verify-contracts: ${error.stack ?? error}`);
  process.exit(2);
});
