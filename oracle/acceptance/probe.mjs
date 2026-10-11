// CANARY-1c424176afe20444
// ticket_done probe (spec 6.4): exercises the compiled orders-service through createApp and prints what it exposes.
// Fixture: 1 line, 2 x $6.25 USD, channel web (total 1250 cents = $12.50). Loaded with ci/netstub.mjs preloaded.
//   node --import <netstub> probe.mjs <file URL of dist/src/main.js>
const mainUrl = process.argv[2];
const FIXED_NOW = "2026-10-10T12:00:00.000Z";
const BODY = {
  customerId: "cust-accept-1",
  customerEmail: "acceptance@example.com",
  channel: "web",
  currency: "USD",
  lines: [{ sku: "SKU-ACC-1", name: "Acceptance lamp", qty: 2, unitPriceCents: 625 }],
};
const COUPON = "SPRING-10";

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function makeApp(mod) {
  const events = [];
  const publisher = { publish: async (e) => void events.push(clone(e)) };
  let n = 0;
  const app = mod.createApp({
    eventPublisher: publisher,
    clock: { now: () => new Date(FIXED_NOW) },
    idGenerator: { nextId: () => `ord-acc-${(n += 1)}` },
    paymentGateway: { authorize: async () => ({ authorized: true, reference: "auth-acc-1" }) },
  });
  const all = () => {
    if (events.length === 0 && app.events && Array.isArray(app.events.records)) {
      return app.events.records.map((r) => {
        try {
          return JSON.parse(r.value);
        } catch {
          return null;
        }
      });
    }
    return events;
  };
  return { app, events: all };
}

async function step(fn) {
  try {
    return await fn();
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

const out = { ok: false, error: null };
try {
  const mod = await import(mainUrl);
  if (typeof mod.createApp !== "function") throw new Error("createApp is not exported");

  // 1. base order: OrderPlaced + POST and GET responses
  out.base = await step(async () => {
    const { app, events } = makeApp(mod);
    const post = await app.handle("POST", "/orders", clone(BODY));
    const id = post?.body?.id;
    const get = typeof id === "string" ? await app.handle("GET", `/orders/${encodeURIComponent(id)}`) : null;
    const placed = events().filter((e) => e && (e.type === "OrderPlaced" || e.type === undefined));
    return { post: clone(post), get: clone(get), events: clone(events()), orderPlaced: placed[0] ?? null };
  });

  // 2. coupon (X-add)
  out.coupon = await step(async () => {
    const { app, events } = makeApp(mod);
    const post = await app.handle("POST", "/orders", { ...clone(BODY), couponCode: COUPON });
    return { status: post?.status ?? null, events: clone(events()) };
  });

  // 3. stock (X-dep): insufficient, then sufficient, through the simulated Stock API
  out.stock = await step(async () => {
    const stub = globalThis.__netstub;
    stub.setStockAvailable(1);
    const a = makeApp(mod);
    const short = await a.app.handle("POST", "/orders", clone(BODY));
    stub.setStockAvailable(1000);
    const b = makeApp(mod);
    const enough = await b.app.handle("POST", "/orders", clone(BODY));
    const stockCalls = stub.calls.filter((c) => c.url.includes("/v1/stock/")).length;
    return { insufficient: short?.status ?? null, sufficient: enough?.status ?? null, stockCalls };
  });
  out.ok = true;
} catch (error) {
  out.error = String(error?.message ?? error);
}
process.stdout.write(JSON.stringify(out));
