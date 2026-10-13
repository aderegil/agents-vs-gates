// Home (night order 2026-10-13, C.1): question-first. What we tested · What happened · See it, then the Talk figures:
// every number the deck uses, computed live from the records, with its query and a link to the runs behind it.
// Data: GET /api/story (figures.py). Plain labels with the code chip beside them (lib/labels.js).
import { h, table, badge, panel, button, iconEl } from "/web/lib/ui.js";
import { GLOSSARY } from "/web/lib/labels.js";

let alive = false;

export async function mount(el, shell) {
  alive = true;
  shell.setHeader({
    title: "Agents vs. Gates",
    subtitle: "Does a coding agent break deployed consumers it cannot see — and which gate stops it?",
    actions: [{ id: "refresh", label: "Refresh", icon: "refresh-cw", onClick: () => load() }],
  });
  const body = h("div", { class: "stack story" }, h("p", { class: "loading" }, "Loading…"));
  el.replaceChildren(body);
  async function load() {
    try {
      const d = await shell.api.get("story");
      if (alive) body.replaceChildren(...render(d, shell));
    } catch (e) {
      if (alive) body.replaceChildren(h("div", { class: "notice fail" }, iconEl("circle-alert", 16), e.error || String(e)));
    }
  }
  await load();
}

export function unmount() {
  alive = false;
}

/** A code with its plain meaning: "Own repo" + chip "V0", glossary on hover. */
function codeChip(code) {
  const g = GLOSSARY[code];
  return h("span", { class: "st-code", title: g ? `${code}: ${g.long}` : code },
    h("span", { class: "st-plain" }, g ? g.short : code), h("span", { class: "st-chip mono" }, code));
}

function linkBtn(shell, l, primary = false) {
  return button({ label: l.label, icon: l.plugin === "replay" ? "clapperboard" : l.plugin === "runs" ? "table" : "bar-chart-3",
    small: true, subtle: !primary, primary, onClick: () => shell.navigate(l.plugin, l.params || {}) });
}

function render(d, shell) {
  const out = [];
  if (d.ns === "mock") {
    out.push(h("div", { class: "notice" }, iconEl("info", 16),
      "Mock namespace: these numbers come from simulated runs. Switch to REAL (status bar) for the talk's numbers."));
  }

  // ------------------------------------------------------------ what we tested
  const col = (title, ...kids) => h("div", { class: "st-col" }, h("h3", {}, title), ...kids);
  const tested = h("div", { class: "st-tested" },
    col("The company", h("p", {}, "Meridian Retail (fictional). Its orders-service publishes OrderPlaced and serves GET /orders/{id}; " +
      "three other teams (billing, analytics, storefront) read fields from them."),
    h("p", { class: "muted small" }, "One ticket per run asks orders-service to change something those teams read.")),
    col("What changes between runs",
      h("div", { class: "st-codes" }, h("span", { class: "small muted" }, "What the agent can see"), ["V0", "V1", "V2"].map(codeChip)),
      h("div", { class: "st-codes" }, h("span", { class: "small muted" }, "What its spec says"), ["S0", "S1", "S2"].map(codeChip))),
    col("The same gates for every run",
      h("p", {}, "CI on the pull request: tests and the architecture checks ARCH-1…8. A red build goes back to the agent."),
      h("p", {}, "The other teams' own tests also run on the PR, hidden from the agent: they say whether something really broke."),
      h("p", { class: "muted small" }, "Agents: Claude Code (Sonnet; Opus in P5) and Codex (P6, the replication).")));
  out.push(panel({ title: "What we tested", body: tested }));

  // ------------------------------------------------------------ what happened
  const qs = h("ol", { class: "st-questions" }, d.questions.map((q) => h("li", { class: "st-q" },
    h("div", { class: "st-q-text" }, h("div", { class: "st-question" }, q.question), h("div", { class: "st-answer" }, q.answer)),
    h("div", { class: "st-q-links" }, q.links.map((l, i) => linkBtn(shell, l, i === 0))))));
  out.push(panel({ title: "What happened", body: qs,
    actions: h("span", { class: "small muted" }, "Each answer is computed from the run records now") }));

  // ------------------------------------------------------------ see it
  const card = (title, text, label, plugin, params, icon) => h("button", { type: "button", class: "st-card",
    onclick: () => shell.navigate(plugin, params) }, h("span", { class: "st-card-icon" }, iconEl(icon, 20)),
  h("span", { class: "st-card-title" }, title), h("span", { class: "st-card-text" }, text), h("span", { class: "st-card-go" }, label, " ", iconEl("arrow-right", 14)));
  out.push(panel({ title: "See it", body: h("div", { class: "st-cards" },
    card("One run, start to finish", "p1-0002: the agent renames two fields, CI turns red, it repairs with aliases, CI turns green.", "Open in the Replay Theater", "replay", { run: "p1-0002", ns: "real" }, "clapperboard"),
    card("Green CI, broken consumer", "p6-0012: Codex edits the analytics team's contract inside its repo; CI passes; analytics breaks.", "Open in the Replay Theater", "replay", { run: "p6-0012", ns: "real" }, "clapperboard"),
    card("Five AI-SDLC models, one change", "Illustrations scripted from public documentation: where each model keeps the rule, and what blocks the merge.", "Compare the models", "replay", { lanes: "1" }, "layout-list"),
    card("Every number", "Results per research question, with intervals; p-values only for the pre-registered tests.", "Open Results", "results", {}, "bar-chart-3")) }));

  // ------------------------------------------------------------ talk figures
  out.push(figuresPanel(d, shell));
  return out;
}

function figuresPanel(d, shell) {
  const t = table({
    caption: "Talk figures", keyboard: false, empty: "No figures.",
    columns: [
      { key: "slide", label: "Slide", num: true, render: (r) => h("span", { class: "strong" }, String(r.slide)) },
      { key: "claim", label: "On the slide", render: (r) => h("span", {}, r.claim) },
      { key: "value", label: "From the records", render: (r) => h("span", { class: "strong mono" }, r.value) },
      { key: "expected", label: "Storyboard", render: (r) => h("span", { class: "mono muted" }, r.expected ?? "—") },
      { key: "matches", label: "", render: (r) => r.matches == null ? "" : r.matches ? badge("matches", "pass") : badge("differs", "fail") },
      { key: "query", label: "How it is counted", render: (r) => h("span", { class: "small" }, r.query, r.note ? h("span", { class: "muted" }, ` · ${r.note}`) : null) },
      { key: "runs", label: "", render: (r) => r.runs ? button({ label: "Runs", icon: "table", small: true, subtle: true,
        onClick: () => shell.navigate(r.runs.plugin, r.runs.params) }) : "" },
    ],
    rows: d.figures,
  });
  const ok = d.matches === d.checked;
  const details = h("details", { class: "st-figs", open: shell.mode === "expert" },
    h("summary", {}, `${d.figures.length} figures from slides 10, 11, 16, 18 and 20 · ${d.matches} of ${d.checked} match the storyboard`),
    t,
    h("p", { class: "small muted st-pad" }, "Counts are runs of the visible, analyzable records (blinded stages count for nothing). " +
      "p-values only for the pre-registered tests. The reviewer's reasons and the gate edits were blind-coded by two independent AI coders. " +
      "Claude Code and Codex are each tested against themselves: no figure here is a test of one agent against the other."));
  return panel({ title: "Talk figures", body: details, flush: false,
    actions: d.checked ? badge(ok ? `${d.matches} of ${d.checked} match` : `${d.checked - d.matches} differ`, ok ? "pass" : "fail") : null });
}
