// The shell (spec §21.4): first run, sign-in, icon rail, plugin header, status bar, SSE, shortcuts, plugin host.
import { icon, iconEl } from "./icons.js";
import { createApi, rawPost, rawSession } from "./lib/api.js";
import { h, fmtTime, button, field, modal, modalOpen } from "./lib/ui.js";

const S = {
  session: null,        // GET /api/session payload
  plugins: [],          // visible manifests
  ns: "mock",
  runner: { real: null, mock: null },
  current: null,        // {plugin, params, mod, unsubs, el, styleEl, frameListener}
  topics: new Map(),    // topic → Set(fn)
  es: null,
  esTopics: new Set(),
  header: null,
  gPending: null,
  mode: readMode(),     // "simple" (the story path) | "expert" (every plugin); remembered per browser
};

/** Simple shows the story path (plugins whose manifest says simple: true); Expert shows everything. */
function readMode() {
  try { return localStorage.getItem("avg.mode") === "expert" ? "expert" : "simple"; } catch { return "simple"; }
}

function railPlugins() {
  const simple = S.plugins.filter((p) => p.simple);
  return S.mode === "expert" || !simple.length ? S.plugins : simple;
}

function setMode(mode) {
  if (mode === S.mode) return;
  S.mode = mode;
  try { localStorage.setItem("avg.mode", mode); } catch { /* private window: the choice lasts this session */ }
  buildFrame();
  route(true);
}
const root = () => document.getElementById("root");

const api = createApi({
  getCsrf: () => S.session?.csrf,
  getNs: () => S.ns,
  onUnauthorized: () => sessionLost(),
});

// ------------------------------------------------------------------ toasts and dialogs (shared with plugins)

function toast(msg, kind = "info") {
  const ic = kind === "ok" ? "circle-check" : kind === "error" ? "circle-alert" : "info";
  const t = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, iconEl(ic, 16), h("div", {}, msg));
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), kind === "error" ? 8000 : 4000);
}

/** shell.confirm({title, message, confirmLabel, requireText}) → Promise<boolean> */
function confirmDialog({ title = "Confirm", message = "", confirmLabel = "Confirm", requireText = null } = {}) {
  return modal((close) => {
    const input = requireText ? h("input", { class: "input", autocomplete: "off", spellcheck: "false", "aria-label": `Type ${requireText} to confirm` }) : null;
    const ok = h("button", { type: "button", class: "btn btn-primary", disabled: !!requireText, onclick: () => close(true) }, confirmLabel);
    if (input) {
      input.addEventListener("input", () => { ok.disabled = input.value !== requireText; });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && input.value === requireText) close(true); });
    }
    const msg = message instanceof Node ? message : h("p", {}, message);
    return {
      title, cancelValue: false, focus: input || null,
      body: [msg, input ? field(h("span", {}, "Type ", h("strong", { class: "mono" }, requireText), " to confirm"), input) : null],
      footer: [h("button", { type: "button", class: "btn", onclick: () => close(false) }, "Cancel"), ok],
    };
  });
}

// ------------------------------------------------------------------ first run and sign-in

function authCard(titleText, lead, formChildren, onSubmit) {
  const err = h("div", { class: "form-error", hidden: true, role: "alert" });
  const form = h("form", { novalidate: true }, h("h1", {}, titleText), lead ? h("p", { class: "lead" }, lead) : null, formChildren, err);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await onSubmit(new FormData(form));
    } catch (ex) {
      err.replaceChildren(iconEl("circle-alert", 16), h("span", {}, ex.error || ex.message || "Something went wrong"));
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  return h("div", { class: "auth" }, h("div", {},
    h("div", { class: "auth-card" },
      h("header", {}, h("span", { class: "brand", "aria-hidden": "true" }, "AG"),
        h("div", {}, h("div", { class: "title" }, "Agents vs. Gates — Console"), h("div", { class: "sub" }, "Local console · 127.0.0.1 only"))),
      form),
    h("p", { class: "auth-foot" }, "experiment console")));
}

const input = (name, type, label, extra = {}) =>
  field(label, h("input", { class: "input", name, type, required: true, ...extra }));

function renderSetup(pre) {
  document.title = "First run — Agents vs. Gates";
  const card = authCard("Create the owner account",
    "No accounts exist yet. The owner can manage users, freeze the pre-registration and run the smoke test. This screen is served only to 127.0.0.1 and disappears once the owner exists.",
    [input("username", "text", "Username", { autocomplete: "username", autocapitalize: "off", spellcheck: "false", pattern: "[a-z0-9][a-z0-9._-]{1,31}" }),
      input("password", "password", "Password (10 characters or more)", { autocomplete: "new-password", minlength: "10" }),
      input("confirm", "password", "Repeat password", { autocomplete: "new-password", minlength: "10" }),
      h("button", { type: "submit", class: "btn btn-primary" }, "Create owner and sign in")],
    async (fd) => {
      if (fd.get("password") !== fd.get("confirm")) throw { error: "Passwords do not match" };
      S.session = await rawPost("setup", { username: String(fd.get("username")).trim().toLowerCase(), password: fd.get("password"), confirm: fd.get("confirm") }, pre.csrf);
      await startShell();
    });
  root().replaceChildren(card);
  card.querySelector("input")?.focus();
}

function renderLogin(pre, note) {
  document.title = "Sign in — Agents vs. Gates";
  const card = authCard("Sign in", note || null,
    [input("username", "text", "Username", { autocomplete: "username", autocapitalize: "off", spellcheck: "false" }),
      input("password", "password", "Password", { autocomplete: "current-password" }),
      h("button", { type: "submit", class: "btn btn-primary" }, "Sign in")],
    async (fd) => {
      S.session = await rawPost("login", { username: String(fd.get("username")).trim().toLowerCase(), password: fd.get("password") }, pre.csrf);
      await startShell();
    });
  root().replaceChildren(card);
  card.querySelector("input")?.focus();
}

let lostOnce = false;
async function sessionLost() {
  if (lostOnce) return;
  lostOnce = true;
  teardown();
  const pre = await rawSession();
  lostOnce = false;
  if (pre.authenticated) { S.session = pre; return startShell(); }
  renderLogin(pre, "Your session ended. Sign in again.");
}

function teardown() {
  unmountCurrent();
  if (S.es) { S.es.close(); S.es = null; S.esTopics.clear(); }
}

// ------------------------------------------------------------------ shell

const HELP_KEYS = [["g", "then a digit: open plugin 1–9"], ["?", "show this list"], ["Esc", "close a dialog or menu"],
  ["↑ ↓", "move between table rows"], ["Enter", "open the focused row"], ["← →", "switch tabs"]];

async function startShell() {
  const [plugins, status] = await Promise.all([api.get("plugins"), api.get("status").catch(() => null)]);
  S.plugins = plugins.plugins;
  S.ns = S.session.ns;
  if (status) S.runner = status.runner;
  document.title = "Agents vs. Gates — Console";
  buildFrame();
  connectEvents();
  if (!S.hashBound) { window.addEventListener("hashchange", () => route(true)); S.hashBound = true; }
  route();
}

function buildFrame() {
  const u = S.session.user;
  const rail = h("nav", { class: "rail", "aria-label": "Plugins" },
    h("span", { class: "brand", title: "Agents vs. Gates — Console", "aria-hidden": "true" }, "AG"),
    railPlugins().map((p) => h("a", { class: "rail-btn", href: `#/${p.id}`, "data-plugin": p.id,
      "data-tip": `${p.name}  ·  g ${p.order}`, "aria-label": p.name, html: icon(p.icon, 20) })),
    h("span", { class: "rail-spacer" }),
    h("button", { type: "button", class: "rail-btn", "data-tip": "Keyboard shortcuts  ·  ?", "aria-label": "Keyboard shortcuts",
      onclick: showShortcuts, html: icon("keyboard", 20) }),
    h("button", { type: "button", class: "rail-btn", id: "user-btn", "data-tip": `${u.username} · ${u.role}`, "aria-label": `User menu: ${u.username}`,
      "aria-haspopup": "menu", onclick: openUserMenu }, avatarEl(u.username)));
  const header = h("header", { class: "phead", id: "phead" },
    h("div", { class: "phead-titles" }, h("h1", { id: "ptitle" }, ""), h("span", { class: "subtitle", id: "psub" }, "")),
    h("div", { class: "phead-actions", id: "pactions" }));
  const body = h("main", { class: "pbody", id: "pbody", tabindex: "-1" });
  const status = h("footer", { class: "statusbar", id: "statusbar", "aria-label": "Status" });
  root().replaceChildren(h("div", { class: "app" }, rail, h("div", { class: "main" }, header, body, status)));
  paintNs();
  paintStatus();
}

function paintNs() {
  const head = document.getElementById("phead");
  if (!head) return;
  head.classList.toggle("is-mock", S.ns === "mock");
  head.querySelector(".mock-tag")?.remove();
  if (S.ns === "mock") head.querySelector(".phead-titles").append(h("span", { class: "mock-tag", title: "Mock namespace: simulated agent runs (results/mock)" }, "MOCK"));
}

function runnerText(r) {
  if (!r) return { text: "Runner idle", cls: "idle", dot: "" };
  const st = r.status || "idle";
  const at = r.stage ? `${r.stage} · ` : "";
  if (st === "running") {
    const kn = r.planned ? `${r.done ?? 0} of ${r.planned}` : `${r.done ?? 0} done`;
    return { text: `Running ${at}${kn}${r.workers > 1 ? ` · ${r.workers} workers` : ""}`, cls: "running", dot: "on" };
  }
  if (st === "stopping") return { text: `Stopping after the current run (${at}${r.done ?? 0} of ${r.planned ?? "?"})`, cls: "running", dot: "on" };
  if (st === "rate_limited") return { text: `Stopped by usage limit${r.rate_limited_until ? ` until ${fmtTime(r.rate_limited_until)}` : ""}`, cls: "rate_limited", dot: "warn" };
  if (st === "error") return { text: `Runner error${r.message ? `: ${r.message}` : ""}`, cls: "error", dot: "fail" };
  if (st === "stopped") return { text: "Runner stopped", cls: "stopped", dot: "" };
  return { text: "Runner idle", cls: "idle", dot: "" };
}

function summarizeProgress(d) {
  const r = d.runner || {};
  const b = r.batch || {};
  return { status: r.status, stage: r.stage, unit: r.unit, workers: r.workers, done: b.done, planned: b.planned,
    rate_limited_until: r.rate_limited_until, message: r.message, resume_at: d.resume_at ?? null };
}

function paintStatus() {
  const bar = document.getElementById("statusbar");
  if (!bar) return;
  const r = S.runner[S.ns];
  const t = runnerText(r);
  const canRun = S.plugins.some((p) => p.id === "run-control");
  const other = S.ns === "real" ? "mock" : "real";
  const o = S.runner[other];
  const items = [
    h(canRun ? "button" : "span", { class: `item state-${t.cls}`, type: canRun ? "button" : null, title: canRun ? "Open Run Control" : null,
      onclick: canRun ? () => navigate("run-control") : null }, h("span", { class: `dot ${t.dot}` }), t.text),
  ];
  if (r && r.resume_at) items.push(h("span", { class: "item" }, iconEl("clock", 14), `Resume at ${fmtTime(r.resume_at)}`));
  if (o && ["running", "stopping", "rate_limited"].includes(o.status)) {
    items.push(h("span", { class: "item", title: `Runner in the ${other} namespace` }, h("span", { class: `dot ${runnerText(o).dot}` }), `${other === "mock" ? "Mock" : "Real"}: ${runnerText(o).text}`));
  }
  items.push(h("span", { class: "spacer" }));
  items.push(h("span", { class: "item" }, h("span", { class: "sr-only" }, "View"),
    h("span", { class: "ns-switch mode-switch", role: "group", "aria-label": "Simple or Expert view" },
      [["simple", "Simple", "The story path: Home, Results, Replay, Runs, Scenario"], ["expert", "Expert", "Every panel, including Run Control and Readiness"]]
        .map(([m, label, tip]) => h("button", { type: "button", "aria-pressed": String(S.mode === m), title: tip,
          onclick: () => setMode(m) }, label)))));
  items.push(h("span", { class: "item" }, h("span", { class: "sr-only" }, "Namespace"),
    h("span", { class: "ns-switch", role: "group", "aria-label": "Namespace" },
      ["real", "mock"].map((ns) => h("button", { type: "button", "aria-pressed": String(S.ns === ns),
        title: ns === "real" ? "Real runs (results/real)" : "Mock runs (results/mock): simulated agent",
        onclick: () => setNs(ns) }, ns.toUpperCase())))));
  items.push(h("span", { class: "item" }, iconEl("user", 14), `${S.session.user.username} · ${S.session.user.role}`));
  bar.replaceChildren(...items);
}

async function setNs(ns) {
  if (ns === S.ns) return;
  try {
    await api.post("session/ns", { ns });
    S.ns = ns;
    S.session.ns = ns;
    paintNs();
    paintStatus();
    route(true);
  } catch (e) {
    toast(e.error || "Could not switch namespace", "error");
  }
}

/** First letter of each part of the username, up to three: jane.q.doe → JQD; one word → its first two letters. */
function initials(username) {
  const parts = String(username).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, 3).map((p) => p[0]).join("");
  return (parts[0] || "?").slice(0, 2);
}

function avatarEl(username) {
  const t = initials(username);
  return h("span", { class: ["avatar", t.length > 2 && "avatar--3"] }, t);
}

function openUserMenu(ev) {
  const btn = ev.currentTarget;
  const r = btn.getBoundingClientRect();
  const close = () => { menu.remove(); document.removeEventListener("mousedown", outside, true); btn.focus(); };
  const outside = (e) => { if (!menu.contains(e.target) && e.target !== btn) close(); };
  const u = S.session.user;
  const menu = h("div", { class: "menu", role: "menu", style: { left: `${r.right + 8}px`, bottom: `${window.innerHeight - r.bottom}px` },
    onkeydown: (e) => {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "Escape") { e.stopPropagation(); close(); }
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    } },
    h("div", { class: "menu-head" }, h("div", { class: "strong" }, u.username), h("div", { class: "small muted" }, `Role: ${u.role} · session until ${fmtTime(S.session.expires_at)}`)),
    S.plugins.some((p) => p.id === "users") ? h("button", { type: "button", role: "menuitem", onclick: () => { close(); navigate("users"); } }, iconEl("user-cog", 15), "Users & Audit") : null,
    h("button", { type: "button", role: "menuitem", onclick: () => { close(); showShortcuts(); } }, iconEl("keyboard", 15), "Keyboard shortcuts"),
    h("button", { type: "button", role: "menuitem", onclick: async () => { close(); await logout(); } }, iconEl("log-out", 15), "Sign out"));
  document.body.append(menu);
  document.addEventListener("mousedown", outside, true);
  menu.querySelector("button")?.focus();
}

async function logout() {
  try { await api.post("logout", {}); } catch { /* ignore */ }
  teardown();
  location.hash = "";
  const pre = await rawSession();
  renderLogin(pre, "Signed out.");
}

function showShortcuts() {
  if (modalOpen()) return;
  modal(() => ({
    title: "Keyboard shortcuts",
    body: [h("dl", { class: "shortcuts" },
      HELP_KEYS.map(([k, d]) => [h("dt", {}, k.split(" ").map((x) => h("kbd", {}, x)).reduce((a, x) => a.length ? [...a, " ", x] : [x], [])), h("dd", {}, d)]),
      S.plugins.map((p) => [h("dt", {}, h("kbd", {}, "g"), " ", h("kbd", {}, String(p.order))), h("dd", {}, p.name)]))],
  }));
}

document.addEventListener("keydown", (e) => {
  if (!S.session?.authenticated || modalOpen()) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
  if (S.gPending && /^[0-9]$/.test(e.key)) {
    clearTimeout(S.gPending);
    S.gPending = null;
    const p = S.plugins.find((x) => x.order === Number(e.key));
    if (p) navigate(p.id);
    else toast(`No plugin ${e.key} for your role`, "info");
    e.preventDefault();
    return;
  }
  if (e.key === "g") {
    S.gPending = setTimeout(() => { S.gPending = null; }, 1500);
    return;
  }
  if (e.key === "?") { e.preventDefault(); showShortcuts(); }
});

// ------------------------------------------------------------------ live events

function connectEvents() {
  if (S.es) S.es.close();
  S.esTopics.clear();
  S.es = new EventSource("/api/events");
  ensureTopic("runner.progress");
  ["runner.run_started", "runner.run_finished", "runner.stopped", "runner.rate_limited", "audit.new"].forEach(ensureTopic);
  S.es.onerror = async () => {
    if (S.es && S.es.readyState === EventSource.CLOSED) {
      const s = await rawSession().catch(() => null);
      if (s && !s.authenticated) sessionLost();
    }
  };
}

function ensureTopic(topic) {
  if (!S.es || S.esTopics.has(topic)) return;
  S.esTopics.add(topic);
  S.es.addEventListener(topic, (ev) => {
    let data = null;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (topic === "runner.progress" && data.ns) {
      S.runner[data.ns] = summarizeProgress(data);
      paintStatus();
    }
    if (topic === "runner.rate_limited" && data.ns === S.ns) toast(`Usage limit reached${data.until ? `; resets at ${fmtTime(data.until)}` : ""}`, "info");
    for (const fn of S.topics.get(topic) || []) {
      try { fn(data); } catch (err) { console.error(err); }
    }
  });
}

function subscribe(topic, fn) {
  if (!S.topics.has(topic)) S.topics.set(topic, new Set());
  S.topics.get(topic).add(fn);
  ensureTopic(topic);
  return () => S.topics.get(topic)?.delete(fn);
}

// ------------------------------------------------------------------ routing and plugin host

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [id, qs] = raw.split("?");
  return { id: decodeURIComponent(id || ""), params: Object.fromEntries(new URLSearchParams(qs || "")) };
}

function navigate(pluginId, params = {}) {
  const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v != null && v !== "")).toString();
  const target = `#/${pluginId}${qs ? "?" + qs : ""}`;
  if (location.hash === target) route(true);
  else location.hash = target;
}

function setHeader({ title, subtitle, actions } = {}) {
  if (title !== undefined) document.getElementById("ptitle").textContent = title ?? "";
  if (subtitle !== undefined) document.getElementById("psub").textContent = subtitle ?? "";
  if (actions !== undefined) {
    document.getElementById("pactions").replaceChildren(...(actions || []).map((a) =>
      button({ label: a.label, icon: a.icon, primary: a.primary, disabled: a.disabled, reason: a.reason,
        onClick: () => a.onClick && a.onClick(a.id) })));
  }
}

function unmountCurrent() {
  const c = S.current;
  if (!c) return;
  try { c.mod?.unmount?.(); } catch (e) { console.error(e); }
  c.unsubs.forEach((u) => u());
  c.styleEl?.remove();
  if (c.frameListener) window.removeEventListener("message", c.frameListener);
  S.current = null;
}

function makeShell(plugin, params, unsubs) {
  return {
    api,
    get user() { return { ...S.session.user }; },
    get ns() { return S.ns; },
    get mode() { return S.mode; },
    canWrite: !plugin.readonly,
    params: { ...params },
    plugin: { id: plugin.id, name: plugin.name },
    navigate,
    toast,
    subscribe(topic, fn) { const u = subscribe(topic, fn); unsubs.push(u); return u; },
    confirm: confirmDialog,
    setHeader,
    icon,
  };
}

async function route(force = false) {
  if (!S.session?.authenticated || !document.getElementById("pbody")) return;
  let { id, params } = parseHash();
  if (!id) {
    const first = S.plugins[0];
    if (first) { history.replaceState(null, "", `#/${first.id}`); id = first.id; }
  }
  const plugin = S.plugins.find((p) => p.id === id);
  if (!force && S.current && S.current.plugin.id === id && JSON.stringify(S.current.params) === JSON.stringify(params)) return;
  unmountCurrent();
  document.querySelectorAll(".rail-btn[data-plugin]").forEach((a) => {
    if (a.dataset.plugin === id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const body = document.getElementById("pbody");
  body.className = "pbody";
  body.replaceChildren();
  document.getElementById("pactions").replaceChildren();
  if (!plugin) {
    setHeader({ title: "Not available", subtitle: "" });
    body.append(h("p", { class: "empty" }, S.plugins.length ? `There is no plugin “${id}” for your role.` : "No plugins are available for your role."));
    return;
  }
  document.title = `${plugin.name} — Agents vs. Gates`;
  setHeader({ title: plugin.name, subtitle: plugin.description, actions: [] });
  const unsubs = [];
  const current = { plugin, params, unsubs, mod: null, styleEl: null, frameListener: null };
  S.current = current;
  if (plugin.style_url) {
    current.styleEl = h("link", { rel: "stylesheet", href: plugin.style_url });
    document.head.append(current.styleEl);
  }
  if (plugin.kind === "iframe") return mountFrame(plugin, params, body, current);
  const el = h("div", { class: "pbody-inner" });
  body.append(el);
  try {
    const mod = await import(plugin.entry_url);
    if (S.current !== current) return; // navigated away while loading
    current.mod = mod;
    await mod.mount(el, makeShell(plugin, params, unsubs));
  } catch (e) {
    console.error(e);
    if (S.current !== current) return;
    el.replaceChildren(h("div", { class: "notice fail" }, iconEl("circle-alert", 16),
      h("div", {}, h("div", { class: "strong" }, `${plugin.name} failed to load`), h("div", { class: "small" }, String(e.error || e.message || e)))));
  }
}

function mountFrame(plugin, params, body, current) {
  body.classList.add("is-frame");
  const frame = h("iframe", { class: "plugin-frame", src: plugin.entry_url, title: plugin.name, sandbox: "allow-scripts allow-same-origin", allow: "fullscreen" });
  const hello = () => frame.contentWindow?.postMessage({ type: "avg:hello", apiBase: "/api", csrf: S.session.csrf,
    user: { ...S.session.user }, ns: S.ns, params: { ...params } }, location.origin);
  frame.addEventListener("load", hello);
  current.frameListener = (e) => {
    if (e.source !== frame.contentWindow || e.origin !== location.origin) return;
    const m = e.data || {};
    if (m.type === "avg:navigate" && typeof m.plugin === "string") navigate(m.plugin, m.params || {});
    else if (m.type === "avg:ready") hello();
    else if (m.type === "avg:toast" && typeof m.message === "string") toast(m.message, m.kind || "info");
  };
  window.addEventListener("message", current.frameListener);
  body.append(frame);
}

// ------------------------------------------------------------------ boot

async function boot() {
  let s;
  try {
    s = await rawSession();
  } catch {
    root().replaceChildren(h("div", { class: "auth" }, h("p", { class: "empty" }, "The console server is not reachable. Start it with python -m console.")));
    return;
  }
  if (s.authenticated) { S.session = s; return startShell(); }
  if (s.setup_required) return renderSetup(s);
  renderLogin(s);
}

boot();
