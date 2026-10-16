// Overview (spec §22.1): where are we and what comes next. Data: GET /api/overview?ns=…
import { h, table, badge, bar, facts, panel, fmtInt, fmtDate, fmtTime, empty, iconEl, button } from "/web/lib/ui.js";
import { withCode, meaningOf } from "/web/lib/labels.js";

let timer = null;
let alive = false;

const BLIND = {
  visible: ["Always visible", "neutral"],
  blinded: ["Blinded", "neutral"],
  unblinded: ["Unblinded", "accent"],
  unblinded_forced: ["Unblinded (forced)", "warn"],
};

export async function mount(el, shell) {
  alive = true;
  shell.setHeader({
    title: "Overview",
    subtitle: "Where the experiment stands and what comes next",
    actions: [{ id: "refresh", label: "Refresh", icon: "refresh-cw", onClick: () => load() }],
  });
  const body = h("div", { class: "stack" }, h("p", { class: "loading" }, "Loading…"));
  el.replaceChildren(body);

  async function load() {
    try {
      const d = await shell.api.get("overview");
      if (alive) body.replaceChildren(...render(d, shell));
    } catch (e) {
      if (alive) body.replaceChildren(h("div", { class: "notice fail" }, iconEl("circle-alert", 16), e.error || String(e)));
    }
  }
  const soon = (data) => {
    if (data && data.ns && data.ns !== shell.ns) return;
    clearTimeout(timer);
    timer = setTimeout(load, 1500);
  };
  shell.subscribe("runner.progress", soon);
  shell.subscribe("runner.run_finished", soon);
  shell.subscribe("runner.stopped", soon);
  await load();
}

export function unmount() {
  alive = false;
  clearTimeout(timer);
}

function render(d, shell) {
  const visible = (id) => id && shell.navigate && document.querySelector(`.rail-btn[data-plugin="${id}"]`);
  const n = d.next;
  const nextPanel = h("section", { class: "panel", "aria-label": "Next recommended action" },
    h("div", { class: "panel-body row-between" },
      h("div", { class: "stack-sm" },
        h("span", { class: "small muted" }, "Next recommended action"),
        h("span", { style: { fontSize: "16px", fontWeight: 500 } }, n?.text || "—"),
        n?.why ? h("span", { class: "small muted" }, n.why) : null),
      n && visible(n.plugin)
        ? button({ label: `Open ${pluginName(n.plugin)}`, icon: "arrow-right", primary: true, onClick: () => shell.navigate(n.plugin, n.params || {}) })
        : null));

  const pre = d.prereg;
  const c = d.counts;
  const q = d.last_quota_event;
  const smokeTone = { passed: "pass", failed: "fail", not_run: "neutral" }[d.smoke.status];
  const smokeText = { passed: "Passed", failed: "Failed", not_run: "Not run" }[d.smoke.status];
  const factsEl = facts([
    { label: "Phase", value: d.phase, sub: d.phase_detail },
    { label: "Pre-registration", value: pre.frozen ? `Frozen ${fmtDate(pre.frozen_at, { time: false })}` : "Not frozen",
      sub: pre.frozen ? h("span", { class: "mono" }, `sha256 ${pre.short_hash}`) : (pre.prereg_md ? "PREREGISTRATION.md drafted" : "PREREGISTRATION.md missing") },
    { label: "Smoke test", value: badge(smokeText, smokeTone), sub: "5 live calls (§10.8)" },
    { label: "Real runs", value: `${fmtInt(c.real.done)} of ${fmtInt(c.real.planned)}`, sub: c.real.has_manifest ? `${fmtInt(c.real.archived)} archived` : "no manifest yet" },
    { label: "Mock runs", value: `${fmtInt(c.mock.done)} of ${fmtInt(c.mock.planned)}`, sub: `${fmtInt(c.mock.selftest)} selftest archived` },
    { label: "Infrastructure failures", value: `${fmtInt(c.real.infra_failures)} real · ${fmtInt(c.mock.infra_failures)} mock`,
      sub: `${fmtInt(c.real.infra_final + c.mock.infra_final)} final (given up)` },
    { label: "Last quota event", value: q ? `${fmtDate(q.ts)}` : "None",
      sub: q ? `${q.ns}${q.until ? ` · reset ${fmtTime(q.until)}` : ""}` : "no usage limit hit so far" },
  ]);

  const stages = table({
    caption: "Progress per stage",
    columns: [
      { key: "stage", label: "Stage", render: (r) => h("span", { class: "strong", title: meaningOf(r.stage) || null }, withCode(r.stage)) },
      { key: "name", label: "What" },
      { key: "bar", label: "Progress", width: "22%", render: (r) => r.in_manifest ? bar(r.done, r.total, { running: r.running }) : h("span", { class: "small muted" }, r.stage === "P3" ? "reviewer calls, not runs" : "not in manifest") },
      { key: "done", label: "Done", num: true, render: (r) => r.in_manifest ? `${fmtInt(r.done)} of ${fmtInt(r.total)}` : "—" },
      { key: "running", label: "Running", num: true, render: (r) => r.in_manifest ? fmtInt(r.running) : "—" },
      { key: "infra_events", label: "Infra failures", num: true, render: (r) => r.in_manifest ? fmtInt(r.infra_events) : "—" },
      { key: "blinding", label: "Outcomes", render: (r) => r.in_manifest ? badge(...BLIND[r.blinding]) : null },
      { key: "tokens", label: "Tokens", num: true, render: (r) => r.tokens == null ? "—" : fmtInt(r.tokens) },
      { key: "minutes", label: "Minutes", num: true, render: (r) => r.minutes == null ? "—" : fmtInt(r.minutes) },
    ],
    rows: d.stages,
    keyboard: false,
  });

  const heads = d.headlines.length
    ? h("ul", { class: "stack-sm", style: { margin: 0, paddingLeft: "18px" } },
      d.headlines.map((x) => h("li", {}, x.stage ? h("span", { class: "muted" }, `${withCode(x.stage)} · `) : null, x.text)))
    : empty("No stage is unblinded yet. Outcomes stay hidden until a stage is complete and unblinded.");

  return [
    nextPanel,
    panel({ title: "Status", body: factsEl, flush: true }),
    panel({ title: `Progress per stage · ${d.ns === "mock" ? "mock" : "real"} namespace`, body: stages, flush: true,
      actions: h("span", { class: "small muted" }, `Updated ${fmtTime(d.generated_at)}`) }),
    panel({ title: "Headline figures (unblinded stages only)", body: heads }),
  ];
}

const NAMES = { "run-control": "Run Control", readiness: "Readiness", scenario: "Scenario", results: "Results", runs: "Run Explorer" };
const pluginName = (id) => NAMES[id] || id;
