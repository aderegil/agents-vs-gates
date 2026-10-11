// Scenario (spec 22.7): the spec that carries rules. Read-only view of the committed scenario/ folder:
// repos with a code viewer, ARCH rules, catalog graph, tickets, S0/S1/S2 contexts and the consumer contracts.
import { h, table, tabs, badge, facts, panel, empty, notice, button, fmtInt, iconEl } from "/web/lib/ui.js";
import { markdownViewer, mdViewSwitch, renderMarkdown } from "/web/lib/markdown.js";
import { tokenize } from "./highlight.js";
import { layoutGraph, edgePath } from "./graph.js";

const TABS = [
  { id: "repos", label: "Repos", icon: "folder-open" },
  { id: "rules", label: "Rules", icon: "gavel" },
  { id: "catalog", label: "Catalog", icon: "network" },
  { id: "tickets", label: "Tickets", icon: "list-todo" },
  { id: "contexts", label: "Contexts", icon: "layers" },
  { id: "broker", label: "Broker", icon: "git-compare" },
];

let shell = null;
let tabsEl = null;
let cache = new Map();
let S = null; // view state, reset on mount

const get = (path, query) => {
  const key = path + JSON.stringify(query || {});
  if (!cache.has(key)) {
    const p = shell.api.get(`scenario/${path}`, query ? { query } : undefined);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
};

const errNotice = (e) => notice(e && (e.error || e.message) ? String(e.error || e.message) : String(e), "fail", "circle-alert");
const kb = (n) => (n < 1024 ? `${fmtInt(n)} B` : `${(n / 1024).toFixed(1)} KB`);
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const mdText = (text) => String(text).split(/(`[^`]+`)/g).map((p) => (p.startsWith("`") && p.endsWith("`") && p.length > 1 ? h("code", {}, p.slice(1, -1)) : p));
const mono = (t) => h("span", { class: "mono" }, t);

function setHash() {
  const q = new URLSearchParams({ tab: S.tab });
  if (S.tab === "repos" && S.path) q.set("path", S.path);
  history.replaceState(null, "", `#/scenario?${q}`);
}

/** Open a scenario file in the Repos tab (from the other tabs). */
function openFile(path) {
  S.path = path;
  S.tab = "repos";
  setHash();
  if (tabsEl.current && tabsEl.current() === "repos") tabsEl.refresh();
  else tabsEl.select("repos");
}

export function mount(el, sh) {
  shell = sh;
  cache = new Map();
  S = { tab: ["repos", "rules", "catalog", "tickets", "contexts", "broker"].includes(sh.params.tab) ? sh.params.tab : "repos",
    path: sh.params.path || null, filter: "", open: new Set(), sel: null };
  shell.setHeader({ title: "Scenario", subtitle: "Meridian Retail · what the agent is given and what the gates check" });
  let current = S.tab;
  tabsEl = tabs({
    items: TABS.map((x) => ({ ...x, render: () => section(x.id) })),
    active: S.tab,
    onChange: (id) => { S.tab = id; current = id; setHash(); },
  });
  tabsEl.current = () => current;
  const sel = tabsEl.select;
  tabsEl.select = (id) => { current = id; sel(id); };
  el.replaceChildren(h("div", { class: "sc-root" }, tabsEl));
}

export function unmount() {
  shell = null;
  tabsEl = null;
  S = null;
  cache = new Map();
}

function section(id) {
  const box = h("div", { class: "stack" }, h("p", { class: "loading" }, "Loading…"));
  RENDER[id]().then((n) => box.replaceChildren(...[n].flat().filter(Boolean)))
    .catch((e) => box.replaceChildren(errNotice(e)));
  return box;
}

// ================================================================== Repos

function buildTree(files) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ ...f, name: parts[parts.length - 1] });
  }
  return root;
}

function countFiles(n) {
  return n.files.length + [...n.dirs.values()].reduce((a, d) => a + countFiles(d), 0);
}

async function renderRepos() {
  const data = await get("repos");
  const all = data.repos.flatMap((r) => r.files);
  if (!S.path) {
    S.path = all.find((f) => f.path === "orders-service/src/core/events.ts")?.path || all[0]?.path || null;
  }
  if (S.path) {
    const parts = S.path.split("/");
    for (let i = 1; i < parts.length; i++) S.open.add(parts.slice(0, i).join("/"));
  }
  for (const r of data.repos) if (!S.open.has(r.name) && S.open.size === 0) S.open.add(r.name);

  const treeBody = h("div", { class: "sc-tree-body", role: "tree", "aria-label": "Scenario repositories" });
  const viewer = h("div", { class: "sc-viewer" });
  const filterIn = h("input", { class: "input input-sm", type: "search", placeholder: "Filter files", "aria-label": "Filter files",
    value: S.filter, oninput: (e) => { S.filter = e.target.value; drawTree(); } });

  function drawTree(focusPath) {
    const q = S.filter.trim().toLowerCase();
    const rows = [];
    const visit = (node, depth, forceOpen) => {
      for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const matches = q ? hasMatch(d, q) : true;
        if (!matches) continue;
        const open = q ? true : S.open.has(d.path);
        rows.push(nodeRow({ kind: "dir", path: d.path, name: d.name, depth, open, count: countFiles(d) }));
        if (open) visit(d, depth + 1);
      }
      for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
        if (q && !f.path.toLowerCase().includes(q)) continue;
        rows.push(nodeRow({ kind: "file", path: f.path, name: f.name, depth, size: f.size }));
      }
    };
    for (const r of data.repos) {
      const tree = buildTree(r.files).dirs.get(r.name) || buildTree([]);
      if (q && !hasMatch(tree, q)) continue;
      const open = q ? true : S.open.has(r.name);
      rows.push(nodeRow({ kind: "dir", path: r.name, name: r.name, depth: 0, open, count: r.files.length, repo: true, owner: r.owner }));
      if (open) visit(tree, 1);
    }
    treeBody.replaceChildren(...(rows.length ? rows : [empty("No file matches.")]));
    if (focusPath) treeBody.querySelector(`[data-path="${CSS.escape(focusPath)}"]`)?.focus();
  }

  const hasMatch = (node, q) => node.files.some((f) => f.path.toLowerCase().includes(q)) || [...node.dirs.values()].some((d) => hasMatch(d, q));

  function nodeRow(n) {
    const isDir = n.kind === "dir";
    const selected = !isDir && n.path === S.path;
    return h("button", {
      type: "button", class: ["sc-node", isDir && "is-dir", n.repo && "is-repo", selected && "is-sel"], role: "treeitem",
      "aria-level": n.depth + 1, "aria-expanded": isDir ? String(n.open) : null, "aria-selected": !isDir ? String(selected) : null,
      tabindex: selected || (!S.path && n.repo && n.name === data.repos[0]?.name) ? "0" : "-1",
      style: { paddingLeft: `${8 + n.depth * 14}px` }, "data-path": n.path,
      onclick: () => {
        if (isDir) { if (S.open.has(n.path)) S.open.delete(n.path); else S.open.add(n.path); drawTree(n.path); }
        else openPath(n.path);
      },
    }, iconEl(isDir ? (n.open ? "chevron-down" : "chevron-right") : "file", 13),
    h("span", { class: "sc-node-name" }, n.name),
    isDir ? h("span", { class: "sc-node-meta" }, fmtInt(n.count)) : h("span", { class: "sc-node-meta" }, kb(n.size)),
    n.repo && n.owner ? h("span", { class: "sc-node-owner", title: `Owner in the catalog: ${n.owner}` }, n.owner) : null);
  }

  treeBody.addEventListener("keydown", (e) => {
    const items = [...treeBody.querySelectorAll(".sc-node")];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const cur = items[i];
    const go = (j) => { if (items[j]) { e.preventDefault(); items.forEach((x) => x.setAttribute("tabindex", "-1")); items[j].setAttribute("tabindex", "0"); items[j].focus(); } };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "ArrowRight" && cur.classList.contains("is-dir") && cur.getAttribute("aria-expanded") === "false") { e.preventDefault(); cur.click(); }
    else if (e.key === "ArrowLeft" && cur.classList.contains("is-dir") && cur.getAttribute("aria-expanded") === "true") { e.preventDefault(); cur.click(); }
  });

  async function openPath(path) {
    S.path = path;
    setHash();
    treeBody.querySelectorAll(".sc-node.is-sel").forEach((x) => { x.classList.remove("is-sel"); x.setAttribute("aria-selected", "false"); });
    const cur = treeBody.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (cur) { cur.classList.add("is-sel"); cur.setAttribute("aria-selected", "true"); }
    viewer.replaceChildren(h("p", { class: "loading" }, "Loading…"));
    try {
      const f = await get("file", { path });
      if (S && S.path === path) viewer.replaceChildren(...viewFile(f).filter(Boolean));
    } catch (e) {
      if (S && S.path === path) viewer.replaceChildren(h("div", { class: "sc-vhead" }, mono(path)), errNotice(e));
    }
  }

  drawTree();
  if (S.path) openPath(S.path);
  else viewer.replaceChildren(empty("No files."));
  const treeCount = fmtInt(all.length);
  return h("div", { class: "sc-split" },
    panel({
      title: "Repositories", actions: h("span", { class: "small muted num" }, `${treeCount} files`),
      body: h("div", { class: "sc-tree" }, h("div", { class: "sc-tree-filter" }, filterIn), treeBody,
        h("p", { class: "small muted sc-tree-foot" }, `Read-only · ${data.excluded.join(", ")} hidden · files over ${kb(data.max_bytes)} are cut`)),
      flush: true,
    }),
    panel({ title: "File", flush: true, body: viewer }));
}

// Fenced blocks in the Markdown preview reuse the code viewer's tokenizer.
const FENCE_LANG = { ts: "ts", tsx: "ts", typescript: "ts", js: "ts", javascript: "ts", mjs: "ts", cjs: "ts", json: "json", yaml: "yaml", yml: "yaml" };
const tokSpans = (toks) => toks.map(([t, s]) => (t ? h("span", { class: `sc-t-${t}` }, s) : s));
function fenceHighlight(lang, text) {
  const l = FENCE_LANG[lang];
  return l ? tokenize(l, text).map((toks, i) => [i ? "\n" : "", tokSpans(toks)]) : null;
}

function viewFile(f) {
  const isMd = f.lang === "md";
  const codeView = () => h("pre", { class: "sc-pre", tabindex: "0", "aria-label": `Contents of ${f.path}` },
    h("code", {}, tokenize(f.lang, f.content).map((toks) => h("span", { class: "sc-line" }, tokSpans(toks)))));
  const code = isMd ? h("div", { class: "sc-md" }, markdownViewer({ text: f.content, code: codeView, highlight: fenceHighlight })) : codeView();
  return [
    h("div", { class: "sc-vhead" }, mono(f.path),
      h("span", { class: "sc-vmeta" },
        isMd ? mdViewSwitch() : null,
        badge(f.lang === "text" ? "text" : f.lang, "neutral"),
        h("span", { class: "small muted num" }, `${fmtInt(f.lines)} lines · ${kb(f.size)}`),
        f.canary_lines ? h("span", { class: "small muted", title: "Canary lines mark files that must never reach an agent workspace" }, `${f.canary_lines} canary line${f.canary_lines > 1 ? "s" : ""}`) : null)),
    f.truncated ? notice(`Showing the first ${kb(f.max_bytes)} of ${kb(f.size)}.`, "warn", "triangle-alert") : null,
    code,
  ];
}

// ================================================================== Rules

async function renderRules() {
  const d = await get("rules");
  const s2 = d.rules.filter((r) => r.in_s2).length;
  const s1 = d.rules.filter((r) => r.in_s1).length;
  const tbl = table({
    columns: [
      { key: "id", label: "ID", width: "78px", render: (r) => h("span", { class: "mono strong nowrap" }, r.id) },
      { key: "rule", label: "Rule", render: (r) => h("span", {}, mdText(r.rule)) },
      { key: "owner", label: "Owner", width: "190px" },
      { key: "enforced_by", label: "Enforced by", width: "250px", render: (r) => h("span", {}, mdText(r.enforced_by)) },
      { key: "in_s1", label: "In S1", width: "64px", render: (r) => (r.in_s1 ? "yes" : h("span", { class: "muted" }, "—")) },
      { key: "in_s2", label: "In S2", width: "64px", render: (r) => (r.in_s2 ? badge("yes", "accent") : h("span", { class: "muted" }, "—")) },
    ],
    rows: d.rules, keyboard: false, caption: "Architecture rules",
  });
  return [
    panel({
      title: d.title,
      actions: button({ label: "Open source", icon: "file-text", small: true, subtle: true, onClick: () => openFile(d.source) }),
      body: tbl, flush: true,
    }),
    h("p", { class: "small muted" }, `${d.rules.length} rules. S2 names ${s2} of them in the context the agent reads; S1 names ${s1}. `
      + "Rules the context does not name are still enforced by CI."),
    h("div", { class: "grid-2" },
      panel({ title: "ADRs", flush: true, body: d.adrs.length ? h("ul", { class: "sc-list" }, d.adrs.map((a) =>
        h("li", {}, h("button", { type: "button", class: "sc-link", onclick: () => openFile(a.path) }, a.title), h("span", { class: "small muted mono" }, a.file)))) : empty("No ADRs.") }),
      panel({ title: "PII baseline", flush: true, body: d.pii_baseline && d.pii_baseline.length
        ? h("ul", { class: "sc-list" }, d.pii_baseline.map((x) => h("li", {}, mono(x), h("span", { class: "small muted" }, "known occurrence (ARCH-6)"))))
        : empty("No baseline.") })),
  ];
}

// ================================================================== Catalog graph

const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

async function renderCatalog() {
  const d = await get("catalog");
  const nodes = d.graph.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const svcByName = new Map(d.services.map((s) => [s.name, s]));
  const { left, right } = layoutGraph(nodes, d.graph.edges);
  const W = 960, ROW = 44, NH = 32, TOP = 34, LX = 0, LW = 250, RW = 300, RX = W - RW;
  const rows = Math.max(left.length, right.length);
  const H = TOP + rows * ROW + 6;
  // spread each column evenly over the full height so edges have room
  const yOf = (list) => new Map(list.map((id, i) => [id, TOP + (list.length < 2 ? 0 : (i * (rows - 1) * ROW) / (list.length - 1))]));
  const yl = yOf(left), yr = yOf(right);
  const pos = (id) => (yl.has(id) ? { x: LX + LW, y: yl.get(id) + NH / 2 } : { x: RX, y: yr.get(id) + NH / 2 });

  S.sel = S.sel && byId.has(S.sel) ? S.sel : "svc:orders-service";
  const detail = h("div", { class: "sc-detail" });
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "sc-graph", role: "group", "aria-label": "Catalog graph: services on the left, APIs and events on the right" });
  svg.append(sv("defs", {}, sv("marker", { id: "sc-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
    sv("path", { d: "M0 0L10 5L0 10z", class: "sc-arrow" }))));
  svg.append(sv("text", { x: LX, y: 16, class: "sc-colhead" }, "SERVICES"), sv("text", { x: RX, y: 16, class: "sc-colhead" }, "APIS AND EVENTS"));
  const edgeEls = d.graph.edges.map((e) => {
    // use-edges run contract → service, drawn right to left, with the arrow at the service
    const a = pos(e.from), b = pos(e.to);
    const path = sv("path", { d: edgePath(a.x, a.y, b.x, b.y), class: `sc-edge ${e.type}`, "marker-end": e.type === "provides" ? null : "url(#sc-arrow)" });
    path.dataset.from = e.from; path.dataset.to = e.to;
    svg.append(path);
    return { e, path };
  });
  const nodeEls = new Map();
  const drawNode = (id, x, w, y) => {
    const n = byId.get(id);
    const sub = n.kind === "service" ? (n.owner ? `owner ${n.owner}` : "")
      : n.kind === "event" ? `event v${n.version} · ${n.topic}` : `API v${n.version} · ${n.host}`;
    const g = sv("g", { class: `sc-gnode ${n.kind}`, tabindex: "0", role: "button", "aria-label": `${n.kind} ${n.label}`, transform: `translate(${x} ${y})`,
      onclick: () => select(id), onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(id); } } },
    sv("rect", { width: w, height: NH, rx: n.kind === "event" ? NH / 2 : 4, class: "sc-box" }),
    sv("text", { x: n.kind === "event" ? 16 : 10, y: 14, class: "sc-label" }, n.label),
    sv("text", { x: n.kind === "event" ? 16 : 10, y: 26, class: "sc-sub" }, sub));
    nodeEls.set(id, g);
    svg.append(g);
  };
  left.forEach((id) => drawNode(id, LX, LW, yl.get(id)));
  right.forEach((id) => drawNode(id, RX, RW, yr.get(id)));

  function select(id) {
    S.sel = id;
    const linked = new Set([id]);
    for (const { e } of edgeEls) if (e.from === id || e.to === id) { linked.add(e.from); linked.add(e.to); }
    for (const { e, path } of edgeEls) {
      const on = e.from === id || e.to === id;
      path.classList.toggle("is-on", on);
      path.classList.toggle("is-dim", !on);
    }
    for (const [nid, g] of nodeEls) {
      g.classList.toggle("is-sel", nid === id);
      g.classList.toggle("is-dim", !linked.has(nid));
    }
    detail.replaceChildren(...detailFor(id));
  }

  const brokerBadge = (yes) => (yes ? badge("in broker", "pass") : badge("no broker contract", "neutral"));
  function detailFor(id) {
    const n = byId.get(id);
    if (n.kind === "service") {
      const s = svcByName.get(n.label);
      const rowsOut = [];
      for (const a of s.apis) rowsOut.push(["Provides API", h("span", {}, mono(a.name), h("span", { class: "small muted" }, ` v${a.version} · ${a.host}`))]);
      for (const e of s.events) rowsOut.push(["Publishes", h("span", {}, mono(e.name), h("span", { class: "small muted" }, ` v${e.version} · ${e.topic}`))]);
      for (const x of s.depends_on) {
        const edge = d.graph.edges.find((e) => e.type === "dependsOn" && e.from === `api:${x.api}` && e.to === id);
        rowsOut.push(["Calls", h("span", { class: "row" }, mono(x.api), h("span", { class: "small muted" }, `of ${x.service}`), edge ? brokerBadge(edge.in_broker) : null)]);
      }
      for (const x of s.consumes) {
        const edge = d.graph.edges.find((e) => e.type === "consumes" && e.from === `evt:${x.event}` && e.to === id);
        rowsOut.push(["Consumes", h("span", { class: "row" }, mono(x.event), h("span", { class: "small muted" }, `from ${x.service}`), edge ? brokerBadge(edge.in_broker) : null)]);
      }
      return [h("div", { class: "sc-dhead" }, h("h3", {}, n.label), badge("service", "neutral")),
        h("p", { class: "small muted" }, `Owner: ${s.owner}`),
        rowsOut.length ? h("dl", { class: "kv sc-kv" }, rowsOut.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])) : h("p", { class: "muted small" }, "Declares nothing."),
        button({ label: `Open ${s.file}`, icon: "file-code", small: true, subtle: true, onClick: () => openFile(`architecture/catalog/${s.file}`) })];
    }
    const c = d.contracts.find((x) => x.id === id);
    const meta = n.kind === "event" ? `topic ${n.topic}` : `host ${n.host}`;
    return [h("div", { class: "sc-dhead" }, h("h3", {}, n.label), badge(n.kind === "event" ? "event" : "API", "neutral")),
      h("p", { class: "small muted" }, `v${n.version} · ${meta} · provided by ${n.provider}`),
      h("h3", { class: "sc-sub-h" }, c.consumers.length ? `${c.consumers.length} ${n.kind === "event" ? "consumer" : "caller"}${c.consumers.length > 1 ? "s" : ""}` : "No consumers declared"),
      c.consumers.length ? h("ul", { class: "sc-list sc-list-tight" }, c.consumers.map((x) =>
        h("li", {}, mono(x.service), brokerBadge(x.in_broker)))) : null,
      button({ label: `Open ${byId.get(`svc:${n.provider}`).file}`, icon: "file-code", small: true, subtle: true, onClick: () => openFile(`architecture/catalog/${byId.get(`svc:${n.provider}`).file}`) })];
  }
  select(S.sel);

  const legend = h("div", { class: "sc-legend small muted" },
    h("span", {}, h("i", { class: "sc-key provides" }), "provides"),
    h("span", {}, h("i", { class: "sc-key uses" }), "calls or consumes (arrow points at the user)"),
    h("span", {}, "pill = event, rectangle = API"));
  return [
    d.errors.length ? notice(`Could not read: ${d.errors.map((e) => `${e.file} (${e.error})`).join("; ")}`, "fail", "circle-alert") : null,
    d.graph.warnings.length ? notice(d.graph.warnings.join(" · "), "warn", "triangle-alert") : null,
    h("div", { class: "sc-catalog" },
      panel({ title: `${d.services.length} services · ${d.contracts.filter((c) => c.kind === "api").length} APIs · ${d.contracts.filter((c) => c.kind === "event").length} events`,
        body: h("div", {}, svg, legend) }),
      panel({ title: "Selected", body: detail })),
  ];
}

// ================================================================== Tickets

async function renderTickets() {
  const d = await get("tickets");
  const missing = d.paraphrases_expected - d.paraphrases_written;
  const rows = [];
  for (const t of d.tickets) {
    const mk = (variant, e, extra = {}) => ({ ticket: t.id, variant, e, ...extra });
    if (t.base) rows.push(mk(t.note ? `Base (${t.note})` : "Base", t.base, { first: true }));
    if (t.w2) rows.push(mk("W2 wording", t.w2));
    for (const p of t.paraphrases) rows.push(mk(`p${p.n}`, p, { para: true }));
  }
  let lastTicket = null;
  const tbl = table({
    columns: [
      { key: "ticket", label: "Ticket", width: "100px", render: (r) => { const show = r.ticket !== lastTicket; lastTicket = r.ticket; return show ? h("span", { class: "mono strong" }, r.ticket) : ""; } },
      { key: "variant", label: "Variant", width: "130px", render: (r) => h("span", { class: r.para ? "" : "strong" }, r.variant) },
      { key: "text", label: "Text", render: (r) => (r.e.todo ? h("span", { class: "sc-todo" }, badge("TODO(human)", "warn"), h("span", { class: "small" }, r.e.text.replace("TODO(human):", "").trim()))
        : h("span", { class: "sc-ticket-text" }, r.e.text)) },
      { key: "words", label: "Words", num: true, width: "70px", render: (r) => (r.e.todo ? "" : fmtInt(r.e.words)) },
      { key: "status", label: "Status", width: "110px", render: (r) => (r.para ? (r.e.todo ? badge("To write", "warn") : badge("Written", "neutral")) : h("span", { class: "muted" }, "Exact text")) },
    ],
    rows, keyboard: false, caption: "Tickets and paraphrases",
  });
  // rows are rendered in order; reset the grouping marker if the table re-renders (sorting is off)
  return [
    facts([
      { label: "Tickets", value: fmtInt(d.tickets.length), sub: "base wording, §6.1" },
      { label: "Paraphrases written", value: `${d.paraphrases_written} of ${d.paraphrases_expected}`, sub: "p1–p5 for rename, remove, api" },
      { label: "Still to write", value: fmtInt(missing), sub: missing ? "by a person, not a model" : "complete" },
    ]),
    missing ? notice("Paraphrases are written by a person, not generated. If any stay empty when the pre-registration is frozen, the manifest uses the base text ×10 for that ticket and says so.", "warn", "triangle-alert") : null,
    panel({ title: "Ticket texts (the agent prompt is the text itself, no wrapper)", body: tbl, flush: true }),
  ];
}

// ================================================================== Contexts

function lamp(tone) {
  return h("span", { class: `sc-lamp t-${tone}`, role: "img", "aria-label": `Fairness light: ${tone === "pass" ? "green" : tone === "warn" ? "amber" : "red"}` },
    ["pass", "warn", "fail"].map((t) => h("i", { class: [`l-${t}`, t === tone && "on"] })));
}

async function renderContexts() {
  const d = await get("contexts");
  if (!d.contexts.length) return empty("No context files in scenario/context/orders-service.");
  const f = d.fairness;
  const max = f ? Math.max(f.s1_added, f.s2_added, 1) : 1;
  const fair = f && h("div", { class: "sc-fair" },
    lamp(f.tone),
    h("div", { class: "sc-fair-text" },
      h("div", { class: "row" }, h("span", { class: "strong" }, f.label), badge(f.tone === "pass" ? "within ±20%" : f.tone === "warn" ? "close to ±20%" : "outside ±20%", f.tone === "pass" ? "pass" : f.tone === "warn" ? "warn" : "fail")),
      h("p", { class: "small muted" }, `Equity rule (§5.7): the sections S1 and S2 add over S0 must be within ±20% of each other in words. `
        + `Measured on the shorter one: spread ${f.spread == null ? "undefined" : pct(f.spread)}; amber from ${pct(f.near)}.`)),
    h("div", { class: "sc-fair-bars" },
      ...[["S1 adds", f.s1_added], ["S2 adds", f.s2_added]].map(([label, n]) => h("div", { class: "sc-fair-bar" },
        h("span", { class: "small" }, label), h("div", { class: "bar" }, h("span", { style: { width: `${(100 * n) / max}%` } })), h("span", { class: "num strong" }, `${fmtInt(n)} words`)))));
  const cols = d.contexts.map((c) => {
    const lines = tokenize("md", c.text);
    let firstAdded = -1;
    if (c.added_text && c.extends_s0) {
      const at = c.text.lastIndexOf(c.added_text);
      if (at >= 0) firstAdded = c.text.slice(0, at).split("\n").length - 1;
    }
    const collapsible = firstAdded > 0;
    let showShared = false;
    const code = h("pre", { class: "sc-pre sc-ctx", tabindex: "0", "aria-label": `${c.id} text` });
    const toggle = collapsible ? h("button", { type: "button", class: "sc-link small", "aria-expanded": "false", onclick: () => { showShared = !showShared; draw(); } }) : null;
    const textLines = c.text.split("\n");
    const box = h("div", {});
    function draw() {
      const from = collapsible && !showShared ? firstAdded : 0;
      code.style.counterReset = `ln ${from}`;
      code.replaceChildren(h("code", {}, lines.slice(from).map((toks, i) =>
        h("span", { class: ["sc-line", firstAdded >= 0 && i + from >= firstAdded && "is-added"] }, toks.map(([t, s]) => (t ? h("span", { class: `sc-t-${t}` }, s) : s))))));
      // Preview: the same split, with the part this condition adds over S0 marked like the added lines
      const shared = firstAdded >= 0 ? textLines.slice(0, firstAdded).join("\n") : c.text;
      const added = firstAdded >= 0 ? textLines.slice(firstAdded).join("\n") : "";
      box.replaceChildren(markdownViewer({
        code: () => code,
        preview: () => h("div", { class: "sc-ctx-md" },
          from ? null : renderMarkdown(shared, { highlight: fenceHighlight }),
          added ? h("div", { class: "is-added" }, renderMarkdown(added, { highlight: fenceHighlight })) : null),
      }));
      if (toggle) {
        toggle.textContent = showShared ? `Hide the ${firstAdded} lines shared with S0` : `Show the ${firstAdded} lines shared with S0`;
        toggle.setAttribute("aria-expanded", String(showShared));
      }
    }
    draw();
    const head = { S0: "S0 · the README", S1: "S1 · README + architecture prose", S2: "S2 · README + rules" }[c.id] || c.id;
    return panel({
      title: head,
      actions: c.id === "S0" ? (d.readme_present ? badge(d.readme_equal ? "equals README" : "differs from README", d.readme_equal ? "pass" : "fail") : badge("README missing", "warn")) : null,
      body: h("div", { class: "stack-sm" },
        h("div", { class: "sc-stats" },
          h("div", {}, h("span", { class: "num strong" }, fmtInt(c.words)), h("span", { class: "small muted" }, " words")),
          c.id === "S0" ? null : h("div", {}, h("span", { class: "num strong" }, `+${fmtInt(c.added_words)}`), h("span", { class: "small muted" }, " over S0")),
          h("div", {}, h("span", { class: "num strong" }, fmtInt(c.lines)), h("span", { class: "small muted" }, " lines"))),
        h("div", { class: "sc-ids small" }, c.arch_ids.length ? [h("span", { class: "muted" }, "Rule IDs named: "), c.arch_ids.map((x) => h("span", { class: "mono" }, x))] : h("span", { class: "muted" }, "No rule IDs")),
        c.id !== "S0" && !c.extends_s0 ? notice("This file does not start with the S0 text, so the added part is a line diff.", "warn", "triangle-alert") : null,
        toggle, box),
    });
  });
  return [
    panel({ title: "Fairness of the added sections", body: fair || notice("S1 and S2 are both needed to evaluate the rule.", "warn", "triangle-alert") }),
    h("div", { class: "sc-ctx-bar" }, h("span", { class: "small muted" }, "Show the context files as"), mdViewSwitch()),
    h("div", { class: "grid-3 sc-ctx-grid" }, cols),
    h("p", { class: "small muted" }, "Word counts split on whitespace and skip any line that carries a canary. The tinted lines are what S1 and S2 add; the agent receives exactly one of the three files."),
  ];
}

// ================================================================== Broker

async function renderBroker() {
  const d = await get("broker");
  const tbl = table({
    columns: [
      { key: "consumer", label: "Consumer", render: (c) => h("span", { class: "strong" }, c.consumer) },
      { key: "provider", label: "Provider" },
      { key: "contract", label: "Contract", render: (c) => mono(c.contract) },
      { key: "deployed_version", label: "Deployed", num: true, width: "90px", render: (c) => `v${c.deployed_version}` },
      { key: "n", label: "Required fields", num: true, width: "130px", render: (c) => fmtInt(c.requires.length) },
      { key: "file", label: "File", render: (c) => h("button", { type: "button", class: "sc-link mono", onclick: () => openFile(`architecture/broker/${c.file}`) }, c.file) },
    ],
    rows: d.contracts, keyboard: false, caption: "Consumer contracts",
  });
  const matrices = d.matrix.map((m) => {
    const t = table({
      columns: [
        { key: "field", label: "Field", render: (f) => mono(f.field) },
        ...m.consumers.map((cn) => ({ key: cn, label: cn, width: "150px", render: (f) => { const x = f.by.find((b) => b.consumer === cn); return x ? h("span", { class: "sc-req mono" }, x.type) : h("span", { class: "muted" }, "·"); } })),
        { key: "used", label: "Used by", num: true, width: "80px", render: (f) => fmtInt(f.by.length) },
      ],
      rows: m.fields, keyboard: false, caption: `Fields required of ${m.contract}`,
    });
    return panel({ title: h("h2", {}, `${m.provider} · `, mono(m.contract)), body: t, flush: true });
  });
  return [
    d.errors.length ? notice(`Could not read: ${d.errors.map((e) => `${e.file} (${e.error})`).join("; ")}`, "fail", "circle-alert") : null,
    panel({ title: `${d.contracts.length} consumer contracts`, body: tbl, flush: true }),
    h("p", { class: "small muted" }, "A field a consumer requires cannot be renamed or removed without deprecation (ARCH-4, ARCH-8). The matrices below show who needs what."),
    ...matrices,
  ];
}

const RENDER = { repos: renderRepos, rules: renderRules, catalog: renderCatalog, tickets: renderTickets, contexts: renderContexts, broker: renderBroker };
