// Simulated network for CI, the oracle, ticket_done and the mutation test (spec 7.1).
// Preload with:  node --import file:///.../ci/netstub.mjs <entry>
//
//   payments.payments.internal            -> 200 { status: "authorized", authorizationId }
//   any URL whose path contains /v1/stock/ -> 200 { sku, available }   (any host; `available` configurable)
//   anything else                          -> throws `netstub: blocked <url>`
//
// `available` comes from env NETSTUB_STOCK_AVAILABLE (default 1000) and can be changed at runtime with
// globalThis.__netstub.setStockAvailable(n). Every intercepted call is recorded in globalThis.__netstub.calls.
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";

const require = createRequire(import.meta.url);
const PAYMENTS_HOST = "payments.payments.internal";

const parsed = Number(process.env.NETSTUB_STOCK_AVAILABLE ?? "1000");
const state = {
  stockAvailable: Number.isFinite(parsed) ? parsed : 1000,
  calls: [],
};

globalThis.__netstub = {
  setStockAvailable(n) {
    state.stockAvailable = Number(n);
  },
  get stockAvailable() {
    return state.stockAvailable;
  },
  get calls() {
    return state.calls;
  },
};

/** Decides the answer for one URL: { status, body } or throws. */
function answer(method, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TypeError(`netstub: blocked ${rawUrl}`);
  }
  state.calls.push({ method, url: url.href });
  if (url.hostname === PAYMENTS_HOST) {
    return { status: 200, body: { status: "authorized", authorizationId: "auth-netstub-1" } };
  }
  const marker = "/v1/stock/";
  const at = url.pathname.indexOf(marker);
  if (at !== -1) {
    const rest = url.pathname.slice(at + marker.length).split("/")[0] ?? "";
    let sku = rest;
    try {
      sku = decodeURIComponent(rest);
    } catch {
      /* keep raw */
    }
    return { status: 200, body: { sku, available: state.stockAvailable } };
  }
  throw new TypeError(`netstub: blocked ${url.href}`);
}

// ---- fetch ------------------------------------------------------------------------------------------------
globalThis.fetch = async function netstubFetch(input, init = {}) {
  let rawUrl;
  let method = init.method ?? "GET";
  if (typeof input === "string") {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.href;
  } else if (input && typeof input === "object" && "url" in input) {
    rawUrl = input.url;
    method = init.method ?? input.method ?? "GET";
  } else {
    rawUrl = String(input);
  }
  const { status, body } = answer(String(method).toUpperCase(), rawUrl);
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};

// ---- node:http / node:https -----------------------------------------------------------------------------------
function urlFromArgs(defaultProtocol, args) {
  let url;
  let options = {};
  let callback;
  for (const a of args) {
    if (typeof a === "function") callback = a;
    else if (typeof a === "string") url = new URL(a);
    else if (a instanceof URL) url = a;
    else if (a && typeof a === "object") options = a;
  }
  if (!url) {
    const protocol = options.protocol ?? defaultProtocol;
    const host = options.hostname ?? options.host ?? "localhost";
    const port = options.port ? `:${options.port}` : "";
    url = new URL(`${protocol}//${host}${port}${options.path ?? "/"}`);
  }
  return { url, method: String(options.method ?? "GET").toUpperCase(), callback };
}

function fakeRequest(defaultProtocol, args) {
  const { url, method, callback } = urlFromArgs(defaultProtocol, args);
  const req = new EventEmitter();
  let ended = false;
  req.write = () => true;
  req.setHeader = () => req;
  req.getHeader = () => undefined;
  req.removeHeader = () => undefined;
  req.setTimeout = () => req;
  req.setNoDelay = () => undefined;
  req.setSocketKeepAlive = () => undefined;
  req.abort = () => undefined;
  req.destroy = (err) => {
    if (err) queueMicrotask(() => req.emit("error", err));
    return req;
  };
  req.end = (...endArgs) => {
    if (ended) return req;
    ended = true;
    const cb = endArgs.find((a) => typeof a === "function");
    queueMicrotask(() => {
      let result;
      try {
        result = answer(method, url.href);
      } catch (error) {
        req.emit("error", error);
        return;
      }
      const res = new PassThrough();
      res.statusCode = result.status;
      res.statusMessage = "OK";
      res.headers = { "content-type": "application/json" };
      if (callback) callback(res);
      req.emit("response", res);
      res.end(JSON.stringify(result.body));
      if (cb) cb();
    });
    return req;
  };
  return req;
}

for (const [name, protocol] of [
  ["node:http", "http:"],
  ["node:https", "https:"],
]) {
  const mod = require(name);
  mod.request = (...args) => fakeRequest(protocol, args);
  mod.get = (...args) => {
    const req = fakeRequest(protocol, args);
    req.end();
    return req;
  };
}
syncBuiltinESMExports();
