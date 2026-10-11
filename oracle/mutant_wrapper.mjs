// Mutation-test wrapper (spec 8.4): re-exports createApp of the canonical orders-service, but passes every published
// event and every GET /orders/{id} response through one mutation. The service code is not touched.
//   env AVG_MUTANT_TARGET  file URL of the compiled canonical dist/src/main.js
//   env AVG_MUTANT         JSON { target: "event"|"rest"|"none", event?: "OrderPlaced"|"OrderCancelled", ops: [...] }
// ops: { op: "rename", path, to } | { op: "remove", path } | { op: "set", path, value } | { op: "map", path, fn }
//      | { op: "array", path, fn: "empty"|"duplicate"|"reverse" }.   Paths: "a.b", "lines[].sku".
const target = process.env.AVG_MUTANT_TARGET;
const spec = JSON.parse(process.env.AVG_MUTANT ?? '{"target":"none","ops":[]}');
const real = await import(target);
const kafka = await import(new URL("./adapters/kafkaEventPublisher.js", target).href);

const FNS = {
  string: (v) => String(v),
  number: (v) => Number(v),
  x100: (v) => v * 100,
  div100: (v) => v / 100,
  round_div100: (v) => Math.round(v / 100),
  floor_div100: (v) => Math.floor(v / 100),
  date_only: (v) => String(v).slice(0, 10),
  epoch_ms: (v) => Date.parse(v),
  epoch_s: (v) => Math.floor(Date.parse(v) / 1000),
  utc_string: (v) => new Date(v).toUTCString(),
  no_zone: (v) => String(v).replace(/(\.\d+)?Z$/, ""),
  us_date: (v) => {
    const d = new Date(v);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
  },
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  wrap_object: (v) => ({ value: v }),
  wrap_array: (v) => [v],
  boolean: (v) => Boolean(v),
};

function apply(root, op) {
  const segments = op.path.split(".");
  const visit = (node, i) => {
    if (node === null || typeof node !== "object") return;
    const raw = segments[i];
    const isArray = raw.endsWith("[]");
    const key = isArray ? raw.slice(0, -2) : raw;
    const last = i === segments.length - 1;
    if (isArray && !last) {
      const arr = node[key];
      if (Array.isArray(arr)) arr.forEach((el) => visit(el, i + 1));
      return;
    }
    if (!last) {
      visit(node[key], i + 1);
      return;
    }
    if (!(key in node) && op.op !== "set") return;
    switch (op.op) {
      case "rename": {
        const v = node[key];
        delete node[key];
        node[op.to] = v;
        break;
      }
      case "remove":
        delete node[key];
        break;
      case "set":
        node[key] = structuredClone(op.value);
        break;
      case "map":
        node[key] = FNS[op.fn](node[key]);
        break;
      case "array": {
        const arr = node[key];
        if (!Array.isArray(arr)) break;
        if (op.fn === "empty") node[key] = [];
        else if (op.fn === "duplicate") node[key] = [...arr, ...structuredClone(arr)];
        else if (op.fn === "reverse") node[key] = [...arr].reverse();
        break;
      }
      default:
        throw new Error(`unknown mutation op ${op.op}`);
    }
  };
  visit(root, 0);
}

function mutate(value) {
  const copy = structuredClone(value);
  for (const op of spec.ops ?? []) apply(copy, op);
  return copy;
}

function mutateEvent(event) {
  if (spec.target !== "event") return event;
  if (event && event.type === (spec.event ?? "OrderPlaced")) return mutate(event);
  return event;
}

const GET_ORDER = /^\/orders\/[^/?]+\/?(\?.*)?$/;

export function createApp(deps = {}) {
  const inner = deps.eventPublisher ?? new kafka.KafkaEventPublisher();
  const publisher = { publish: (event) => inner.publish(mutateEvent(event)) };
  const app = real.createApp({ ...deps, eventPublisher: publisher });
  return {
    async handle(method, path, body) {
      const res = await app.handle(method, path, body);
      if (spec.target === "rest" && String(method).toUpperCase() === "GET" && GET_ORDER.test(path) && res?.status === 200) {
        return { ...res, body: mutate(res.body) };
      }
      return res;
    },
    events: inner,
  };
}
