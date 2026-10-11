// Results (spec §22.3): one section per research question, the instrument checks (mutation matrix, CI ↔ oracle),
// excluded runs, and slide export (SVG and PNG 1920×1080, App and Deck styles).
// Data: GET /api/results/{rq,reviewer,mutation,excluded,pilot}?ns=… ; drawing: ./charts.js (pure SVG, no libraries).
// A stage that is not unblinded arrives without numbers; this page only shows "Blinded until stage complete".
import { h, table, badge, empty, panel, notice, iconEl, button, tabs, fmtInt } from "/web/lib/ui.js";
import { markdownViewer, mdViewSwitch } from "/web/lib/markdown.js";
import { renderChart, renderSlide, dataTable, THEMES, SLIDE, fmtXofN, fmtCI } from "./charts.js";

const BLINDED = "Blinded until stage complete";
const FONT_FILES = [["400", "ibm-plex-sans-latin-400-normal.woff2"], ["500", "ibm-plex-sans-latin-500-normal.woff2"],
  ["600", "ibm-plex-sans-latin-600-normal.woff2"]];

let alive = false;
let timer = null;
let fontCssPromise = null;

const store = {
  get(k, d) { try { return localStorage.getItem("avg.results." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("avg.results." + k, v); } catch { /* private window: no memory */ } },
};

// ------------------------------------------------------------------ export (browser side)

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** IBM Plex Sans as data: URLs inside the SVG, so a PNG drawn from it keeps the font (an SVG used as an image cannot
 *  fetch files). Graphik is named first in the deck style and is used only if it is installed on this machine. */
export function loadFontCss() {
  if (!fontCssPromise) {
    fontCssPromise = Promise.all(FONT_FILES.map(async ([w, f]) => {
      const res = await fetch(`/web/fonts/${f}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`font ${f}: ${res.status}`);
      return `@font-face{font-family:'IBM Plex Sans';font-weight:${w};src:url(data:font/woff2;base64,${toBase64(await res.arrayBuffer())}) format('woff2');}`;
    })).then((p) => p.join("")).catch(() => { fontCssPromise = null; return ""; });
  }
  return fontCssPromise;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, style: { display: "none" } });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
}

/** The slide as SVG text (the watermark follows spec.simulated; there is no way to ask for none). */
export async function slideSvg(spec, style) {
  return renderSlide(spec, { style, fontCss: await loadFontCss() });
}

/** The slide as a 1920×1080 PNG: the SVG is drawn into an <img> (blob: URL, allowed by img-src) and then a canvas. */
export async function slidePng(spec, style) {
  const svg = await slideSvg(spec, style);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("The browser could not draw the SVG"));
      img.src = url;
    });
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await new Promise((r) => setTimeout(r, 60)); // let the embedded font settle before the first draw
    const canvas = document.createElement("canvas");
    canvas.width = SLIDE.w;
    canvas.height = SLIDE.h;
    const g = canvas.getContext("2d");
    g.fillStyle = THEMES[style].bg;
    g.fillRect(0, 0, SLIDE.w, SLIDE.h);
    g.drawImage(img, 0, 0, SLIDE.w, SLIDE.h);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("The canvas produced no image");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------------------ small renderers

const fmtSec = (ms) => (ms == null ? "—" : ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const fmtP = (p) => (p == null ? "—" : p < 0.001 ? "<0.001" : p.toFixed(3));
const cellText = (m) => (m && m.n ? `${fmtXofN(m.x, m.n)} ${fmtCI(m.ci)}` : "—");
const code = (s) => h("code", {}, s);

function genericTable(t) {
  const fmt = {
    ms: (v) => fmtSec(v),
    usd: (v) => (v == null ? "—" : `$${Number(v).toFixed(4)}`),
  };
  return table({
    caption: t.title,
    columns: t.columns.map((c) => ({ key: c.key, label: c.label, num: !!c.num,
      render: (r) => (c.fmt ? fmt[c.fmt](r[c.key]) : c.num && typeof r[c.key] === "number" ? fmtInt(r[c.key]) : r[c.key]) })),
    rows: t.rows, keyboard: false,
  });
}

function numbersTable(spec) {
  const d = dataTable(spec);
  return table({ caption: `Numbers behind: ${spec.title}`, keyboard: false,
    columns: d.columns.map((c) => ({ key: c.key, label: c.label, num: !!c.num })), rows: d.rows });
}

// ------------------------------------------------------------------ page

export async function mount(el, shell) {
  alive = true;
  const S = { style: store.get("style", "app") === "deck" ? "deck" : "app", tab: shell.params?.tab || store.get("tab", "rq1"),
    data: null, busy: new Set() };
  if (!THEMES[S.style]) S.style = "app";
  el.classList.add("res-root");
  const body = h("div", { class: "stack" }, h("p", { class: "loading" }, "Loading…"));
  el.replaceChildren(body);

  shell.setHeader({
    title: "Results",
    subtitle: "One section per research question · counts with 95% intervals · only H2 carries p-values",
    actions: [{ id: "refresh", label: "Refresh", icon: "refresh-cw", onClick: () => load() }],
  });

  async function load() {
    try {
      const [rq, reviewer, mutation, excluded, pilot] = await Promise.all([
        shell.api.get("results/rq"), shell.api.get("results/reviewer"),
        shell.api.get("results/mutation"), shell.api.get("results/excluded"),
        shell.api.get("results/pilot").catch(() => null),
      ]);
      S.data = { rq, reviewer, mutation, excluded, pilot };
      if (alive) draw();
    } catch (e) {
      if (alive) body.replaceChildren(h("div", { class: "notice fail" }, iconEl("circle-alert", 16), e.error || String(e)));
    }
  }

  // ---- export plumbing
  async function doExport(spec, format, btn) {
    const key = spec.id + format;
    if (S.busy.has(key)) return;
    S.busy.add(key);
    btn?.setAttribute("aria-busy", "true");
    try {
      const name = `agents-vs-gates_${shell.ns}_${spec.id.replace(/\./g, "-")}_${S.style}`;
      if (format === "svg") download(new Blob([await slideSvg(spec, S.style)], { type: "image/svg+xml" }), `${name}.svg`);
      else download(await slidePng(spec, S.style), `${name}.png`);
      shell.toast(`${format.toUpperCase()} saved${spec.simulated ? " with the MOCK watermark" : ""}`, "ok");
    } catch (e) {
      shell.toast(`Export failed: ${e.message || e}`, "error");
    } finally {
      S.busy.delete(key);
      btn?.removeAttribute("aria-busy");
    }
  }
  el.__results = { slideSvg, slidePng, state: S };

  // ---- chart card
  function chartCard(spec) {
    const theme = THEMES[S.style];
    const exportBtn = (fmt, icon) => {
      const b = button({ label: fmt.toUpperCase(), icon, small: true, subtle: true, title: `Download as ${fmt.toUpperCase()}, 1920×1080, ${S.style} style${spec.simulated ? ", with MOCK watermark" : ""}`,
        onClick: () => doExport(spec, fmt, b) });
      return b;
    };
    const chart = h("div", { class: `res-chart style-${S.style}`, style: { background: theme.bg }, html: renderChart(spec, { style: S.style }) });
    return h("section", { class: "panel res-card", "aria-label": spec.title },
      h("header", { class: "panel-head" }, h("div", { class: "res-card-titles" }, h("h2", {}, spec.title), h("span", { class: "small muted" }, spec.subtitle)),
        h("div", { class: "panel-actions" }, spec.simulated ? badge("MOCK", "neutral") : null, exportBtn("svg", "download"), exportBtn("png", "image"))),
      h("div", { class: "panel-body res-card-body" }, chart,
        h("p", { class: "res-source small muted" }, spec.source),
        spec.footnote ? h("p", { class: "res-foot small muted" }, spec.footnote) : null,
        h("details", { class: "res-numbers" }, h("summary", {}, "Show numbers"), numbersTable(spec))));
  }

  const chartGrid = (charts) => h("div", { class: "res-grid" }, charts.map(chartCard));

  // ---- blinding
  function stageLine(stage) {
    const s = S.data.rq.stages.find((x) => x.stage === stage);
    return s && s.runs_total != null ? `${stage} (${fmtInt(s.runs_done)} of ${fmtInt(s.runs_total)} runs done)` : stage;
  }
  function blindedBlock(stages) {
    return h("div", { class: "res-blind", role: "status" }, iconEl("lock", 20),
      h("div", {}, h("div", { class: "strong" }, BLINDED),
        h("div", { class: "small muted" }, `${stages.map(stageLine).join(", ")} feed${stages.length === 1 ? "s" : ""} this question. ` +
          "Nothing is computed until the owner unblinds the stage in Run Control.")));
  }

  // ---- sections
  function sectionHead(sec) {
    return h("div", { class: "res-qhead" }, h("span", { class: "res-code" }, sec.code), h("h2", {}, sec.question),
      sec.descriptive ? badge("Descriptive", "neutral") : badge("Confirmatory H2 + descriptive", "accent"));
  }

  function sectionBody(sec) {
    const out = [sectionHead(sec), sec.note ? h("p", { class: "small muted res-note" }, sec.note) : null];
    if (sec.status === "blinded") { out.push(blindedBlock(sec.blinded_stages)); return out; }
    if (sec.status === "empty") {
      out.push(empty("No visible runs for this question yet."));
      if (sec.empty_hint) out.push(h("p", { class: "small muted" }, "Generate the reviewer data with ", code(sec.empty_hint)));
      return out;
    }
    if (sec.blinded_stages?.length) out.push(blindedBlock(sec.blinded_stages));
    const h2Chart = sec.charts.find((c) => c.id === "rq2.h2");
    const others = sec.charts.filter((c) => c.id !== "rq2.h2");
    if (sec.h2) {
      out.push(h2Panel(sec));
      if (h2Chart) out.push(chartGrid([h2Chart]));
      if (others.length) out.push(h("h3", { class: "res-sub" }, "Descriptive comparisons (no p-values)"));
    }
    if (others.length) out.push(chartGrid(others));
    for (const t of sec.tables || []) out.push(panel({ title: t.title, flush: true, body: genericTable(t) }));
    if (sec.id === "rq4" && sec.tables?.[0]?.footer?.ci_mean_duration_ms != null) {
      out.push(h("p", { class: "small muted" }, `CI, first run on the same PRs: mean ${fmtSec(sec.tables[0].footer.ci_mean_duration_ms)}.`));
    }
    return out;
  }

  function h2Panel(sec) {
    const h2 = sec.h2;
    const rows = h2.tickets.map((t) => ({ ticket: t.ticket, s0: t.s0, s2: t.s2, p: t.p, p_holm: t.p_holm }));
    const tbl = table({
      caption: "H2 confirmatory contrast", keyboard: false, empty: "No visible runs in the H2 cells yet.",
      columns: [
        { key: "ticket", label: "Ticket", render: (r) => h("span", { class: "strong" }, r.ticket) },
        { key: "s0", label: "V0·S0 (consumers not named)", num: true, render: (r) => cellText(r.s0) },
        { key: "s2", label: "V0·S2 (consumers named)", num: true, render: (r) => cellText(r.s2) },
        { key: "p", label: "Fisher exact p", num: true, render: (r) => fmtP(r.p) },
        { key: "p_holm", label: "Holm-adjusted p", num: true, render: (r) => h("span", { class: "strong" }, fmtP(r.p_holm)) },
      ],
      rows,
    });
    return panel({
      title: `H2 · confirmatory contrast · ${h2.stage}`,
      actions: badge("Pre-registered", "accent"),
      flush: true,
      body: h("div", {}, tbl,
        h("p", { class: "small muted res-pad" }, "staging_break in V0·S0 vs. V0·S2, Fisher exact two-sided per ticket, Holm correction over the two tickets. " +
          "The only place in this console that shows p-values."),
        h2.note ? h("p", { class: "small res-pad" }, iconEl("info", 14), " ", h2.note) : null),
    });
  }

  function reviewerSection() {
    return sectionBody(S.data.reviewer.section);
  }

  function instrumentSection() {
    const { mutation: mu, concordance: co } = S.data.mutation;
    const out = [h("div", { class: "res-qhead" }, h("span", { class: "res-code" }, "Instrument"), h("h2", {}, "What CI sees and what it does not"),
      badge("Deterministic, no agents", "neutral"))];
    // mutation matrix
    out.push(h("h3", { class: "res-sub" }, "Mutation matrix (spec 8.4)"));
    if (!mu.present || !mu.total) {
      out.push(h("div", { class: "res-blind" }, iconEl("info", 20), h("div", {},
        h("div", { class: "strong" }, "No mutation matrix yet"),
        h("div", { class: "small muted" }, "Generate it with ", code(mu.command), " (about 100 mutants of OrderPlaced and the REST response, no model calls). It is the same in the real and mock namespaces."))));
      if (mu.markdown) out.push(h("div", { class: "res-md" }, h("div", { class: "res-md-bar" }, mdViewSwitch()),
        markdownViewer({ text: mu.markdown, code: () => h("pre", { class: "block" }, mu.markdown) })));
    } else {
      out.push(chartGrid([mu.chart]));
      const names = { ci_catch_oracle_catch: "CI catches · oracle catches", ci_catch_oracle_miss: "CI catches · oracle misses",
        ci_miss_oracle_catch: "CI misses · oracle catches (what CI does not see)", ci_miss_oracle_miss: "CI misses · oracle misses" };
      out.push(panel({ title: "Mutants per cell", flush: false, body: h("div", { class: "stack-sm" },
        Object.entries(names).map(([k, label]) => h("details", { class: "res-mut", open: k === "ci_miss_oracle_catch" && mu.cells[k].count > 0 },
          h("summary", {}, h("span", { class: "strong" }, label), " ", h("span", { class: "muted num" }, `${mu.cells[k].count} of ${mu.total}`)),
          mu.cells[k].count ? h("div", { class: "res-chips" }, mu.cells[k].mutants.map((m) =>
            h("span", { class: "res-chip mono", title: [m.family, m.description].filter(Boolean).join(" · ") || null }, m.id))) : h("p", { class: "small muted" }, "None."))) ) }));
      if (mu.families.length) {
        out.push(panel({ title: "By mutation family", flush: true, body: table({ caption: "Mutants by family", keyboard: false,
          columns: [{ key: "family", label: "Family" }, { key: "total", label: "Mutants", num: true },
            { key: "ci_catch_oracle_catch", label: "Both catch", num: true }, { key: "ci_catch_oracle_miss", label: "CI only", num: true },
            { key: "ci_miss_oracle_catch", label: "Oracle only", num: true }, { key: "ci_miss_oracle_miss", label: "Neither", num: true }],
          rows: mu.families }) }));
      }
    }
    // concordance
    out.push(h("h3", { class: "res-sub" }, "CI ↔ oracle agreement on the runs"));
    out.push(notice(co.note, "", "info"));
    if (co.empty) out.push(empty("No visible run has both a first-CI verdict and an oracle verdict yet."));
    else {
      out.push(chartGrid([co.chart]));
      const rows = Object.entries(co.tickets).map(([t, v]) => ({ ticket: t, ...v }));
      out.push(panel({ title: "Counts per ticket", flush: true, body: table({ caption: "CI and oracle verdicts per ticket", keyboard: false,
        columns: [{ key: "ticket", label: "Ticket", render: (r) => h("span", { class: "strong" }, r.ticket) },
          { key: "ci_break_oracle_break", label: "CI breaks · oracle breaks", num: true }, { key: "ci_break_oracle_ok", label: "CI breaks · oracle passes", num: true },
          { key: "ci_ok_oracle_break", label: "CI passes · oracle breaks", num: true }, { key: "ci_ok_oracle_ok", label: "CI passes · oracle passes", num: true },
          { key: "by_construction", label: "Reading", render: (r) => (r.by_construction ? badge("High by construction", "neutral") : badge("Evidence", "accent")) }],
        rows }) }));
    }
    return out;
  }

  function excludedSection() {
    const { excluded, infra } = S.data.excluded;
    const hasRunsNav = !!document.querySelector('.rail-btn[data-plugin="runs"]');
    const out = [h("div", { class: "res-qhead" }, h("span", { class: "res-code" }, "Excluded"), h("h2", {}, "Runs kept out of the main analysis"))];
    out.push(h("p", { class: "small muted res-note" }, "Contaminated (canary found), token exposed or isolation breach. They are listed with their reason; " +
      "infrastructure failures are counted apart."));
    out.push(panel({ title: `Excluded runs · ${fmtInt(excluded.length)}`, flush: true, body: table({
      caption: "Excluded runs", keyboard: false, empty: "No run is excluded.",
      columns: [
        { key: "run_id", label: "Run", mono: true, render: (r) => hasRunsNav
          ? h("a", { href: `#/runs?run=${encodeURIComponent(r.run_id)}`, onclick: (e) => { e.preventDefault(); shell.navigate("runs", { run: r.run_id }); } }, r.run_id) : r.run_id },
        { key: "stage", label: "Stage" },
        { key: "reasons", label: "Reason", render: (r) => r.reasons.join("; ") },
      ], rows: excluded }) }));
    const kinds = Object.entries(infra.by_stage).flatMap(([stage, c]) => Object.entries(c).map(([kind, n]) => ({ stage, kind, n })));
    out.push(panel({ title: `Infrastructure failures · ${fmtInt(kinds.reduce((a, k) => a + k.n, 0))}`, flush: true, body: h("div", {},
      table({ caption: "Infrastructure failures", keyboard: false, empty: "None archived.",
        columns: [{ key: "stage", label: "Stage" }, { key: "kind", label: "Kind" }, { key: "n", label: "Runs", num: true }], rows: kinds }),
      h("p", { class: "small muted res-pad" }, `Retries recorded in state: ${fmtInt(infra.retries_total)}. Final failures (given up): ${infra.final.length ? infra.final.join(", ") : "none"}.`)) }));
    return out;
  }

  // ---- pilot X1 (exploratory; outside the confirmatory analysis)
  function pilotSection(p) {
    const ci = (d) => d && d.n ? `${fmtXofN(d.x, d.n)} ${fmtCI(d.ci)}` : "—";
    const counts = (c) => Object.entries(c || {}).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ") || "—";
    const num = (v) => v == null ? "—" : String(v);
    const pv = (v) => v == null ? "—" : v.toPrecision(3);
    const out = [notice(p.note, "", "info")];
    for (const [unit, tickets] of Object.entries(p.units)) {
      for (const [ticket, g] of Object.entries(tickets)) {
        const a = g.V0, b = g.V2;
        const rows = [
          { m: "Runs", v0: num(a.n), v2: num(b.n) },
          { m: "First attempt broke a consumer (oracle on gen)", v0: ci(a.staging_break_gen), v2: ci(b.staging_break_gen), key: true },
          { m: "Passed the first CI", v0: ci(a.passed_first_ci), v2: ci(b.passed_first_ci) },
          { m: "Outcomes", v0: counts(a.outcomes), v2: counts(b.outcomes) },
          { m: "ticket_done (final PR)", v0: counts(a.ticket_done), v2: counts(b.ticket_done) },
          { m: "Out-of-scope edits", v0: num(a.out_of_scope), v2: num(b.out_of_scope) },
          { m: "Median turns", v0: num(a.median_turns), v2: num(b.median_turns) },
          { m: "Median tokens (in + out)", v0: num(a.median_tokens), v2: num(b.median_tokens) },
          { m: "Median minutes", v0: num(a.median_minutes), v2: num(b.median_minutes) },
          { m: "Ran the checks in gen", v0: a.ran_tests ? `${a.ran_tests.x} of ${a.ran_tests.n}` : "—", v2: b.ran_tests ? `${b.ran_tests.x} of ${b.ran_tests.n}` : "—" },
          { m: "Shell commands denied (runs with any / total)", v0: a.shell_denials ? `${a.shell_denials.runs} / ${a.shell_denials.total}` : "—", v2: b.shell_denials ? `${b.shell_denials.runs} / ${b.shell_denials.total}` : "—" },
        ];
        out.push(panel({ title: `${ticket} · V0 vs V2 · ${unit} · S0 · W1 base text`,
          body: h("div", { class: "stack" },
            table({ keyboard: false, caption: `${ticket} ${unit}`, columns: [
              { key: "m", label: "Measure", render: (r) => r.key ? h("strong", {}, r.m) : r.m },
              { key: "v0", label: "V0 (orders-service only)" }, { key: "v2", label: "V2 (all four repos)" }], rows }),
            h("p", { class: "small muted" }, `Fisher exact V0 vs V2, two-sided, uncorrected (exploratory): first attempt broke a consumer p = ${pv(g.fisher_staging_break)}; passed the first CI p = ${pv(g.fisher_passed_first_ci)}.`)) }));
      }
    }
    if (p.excluded.length) out.push(notice(`Excluded: ${p.excluded.map((e) => `${e.run_id} (${e.reasons.join(", ")})`).join("; ")}`, "", "info"));
    if (p.infra.length) out.push(notice(`Infrastructure failures: ${p.infra.map((e) => `${e.run_id} (${e.kind})`).join("; ")}`, "", "info"));
    return out;
  }

  // ---- page
  function toolbar() {
    const st = S.data.rq.stages;
    const chips = st.length ? st.map((s) => badge(`${s.stage} · ${s.visible ? (["P0", "X1", "selftest"].includes(s.stage) ? "always visible" : "unblinded") : BLINDED}`, s.visible ? "accent" : "neutral"))
      : [h("span", { class: "small muted" }, "No stage has runs in this namespace yet.")];
    const seg = h("div", { class: "res-seg", role: "group", "aria-label": "Export style" },
      ["app", "deck"].map((id) => h("button", { type: "button", "aria-pressed": String(S.style === id), title: id === "app" ? "App: the console's light style" : "Deck: black, deck purple, cyan = pass, pink = fail",
        onclick: () => { S.style = id; store.set("style", id); draw(); } }, id === "app" ? "App" : "Deck")));
    return h("div", { class: "res-toolbar" }, h("div", { class: "row" }, chips),
      h("div", { class: "row" }, h("span", { class: "small muted" }, "Export style"), seg, h("span", { class: "small muted" }, "SVG and PNG · 1920×1080")));
  }

  function draw() {
    const d = S.data;
    const items = [];
    const secs = d.rq.sections;
    for (const id of ["rq1", "rq2", "rq3"]) items.push({ id, label: secs[id].code, render: () => h("div", { class: "stack" }, sectionBody(secs[id])) });
    items.push({ id: "rq4", label: "RQ4", render: () => h("div", { class: "stack" }, reviewerSection()) });
    if (secs.rq5) items.push({ id: "rq5", label: "RQ5", render: () => h("div", { class: "stack" }, sectionBody(secs.rq5)) });
    items.push({ id: "instrument", label: "CI vs. oracle", render: () => h("div", { class: "stack" }, instrumentSection()) });
    if (d.pilot && d.pilot.runs) items.push({ id: "pilot", label: "Pilot X1 · exploratory", render: () => h("div", { class: "stack" }, pilotSection(d.pilot)) });
    items.push({ id: "excluded", label: "Excluded", count: d.excluded.excluded.length || null, render: () => h("div", { class: "stack" }, excludedSection()) });
    if (!items.some((i) => i.id === S.tab)) S.tab = "rq1";
    const t = tabs({ items, active: S.tab, onChange: (id) => { S.tab = id; store.set("tab", id); } });
    body.replaceChildren(...[
      d.rq.simulated ? notice(h("span", {}, h("strong", {}, d.rq.banner), ". Every figure exported from this namespace carries the MOCK watermark; it cannot be switched off."), "", "info") : null,
      toolbar(), t].filter(Boolean));
  }

  const soon = (data) => {
    if (data && data.ns && data.ns !== shell.ns) return;
    clearTimeout(timer);
    timer = setTimeout(load, 4000);
  };
  shell.subscribe("runner.run_finished", soon);
  shell.subscribe("runner.stopped", soon);
  await load();
}

export function unmount() {
  alive = false;
  clearTimeout(timer);
}
