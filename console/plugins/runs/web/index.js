// Run Explorer (spec §22.4): runs table with filters, and a detail panel with Summary, Diff, CI, Oracle, Detectors,
// Transcript and Trace tabs. Data: GET /api/runs and /api/runs/{id}/{diff,ci,oracle,detectors,transcript,trace}.
// While a stage is blinded the server answers 403 "Blinded until stage complete" for the outcome-bearing tabs; this UI
// never asks for them (and shows the same message) so nothing flashes.
import { h, table, tabs, badge, button, panel, facts, notice, empty, fmtInt, fmtDuration, fmtDate, fmtTime, iconEl, unitTag, unitSeg, unitInfo } from "/web/lib/ui.js";
import {
  parseDiff, diffStats, sideBySide, splitArch, isArch, groupTranscript, outcomeTone, ticketDoneTone, statusTone, flagChips,
  filtersToQuery, conditionLabel, fmtBytes,
} from "./model.js";
import { GLOSSARY, plainCondition, conditionTitle, conditionCode, outcomeLabel } from "/web/lib/labels.js";

const BLINDED = "Blinded until stage complete";
let alive = false;
let timer = null;

export function unmount() {
  alive = false;
  clearTimeout(timer);
}

export async function mount(el, shell) {
  alive = true;
  const S = {
    rows: [], facets: null, blinded: [], total: 0,
    // filters can arrive in the link (Home's Talk figures, Results): #/runs?stage=P1&V=V0&S=S2
    filters: Object.fromEntries(["stage", "ticket", "V", "S", "W", "unit", "status", "q"].map((k) => [k, shell.params[k] || ""])),
    selected: null, detail: null, cache: new Map(), tab: shell.params.tab || "summary",
    diffView: "unified", diffRef: null, loadSeq: 0,
  };
  shell.setHeader({
    title: "Run Explorer",
    subtitle: `${shell.ns === "mock" ? "Mock" : "Real"} namespace · individual runs`,
    actions: [{ id: "refresh", label: "Refresh", icon: "refresh-cw", onClick: () => loadList() }],
  });

  const notes = h("div", {});
  const filterBar = h("div", { class: "rx-filters" });
  const tableBox = h("div", { class: "rx-table" });
  const detailBox = h("div", { class: "rx-detail" }, empty("Select a run to see its detail."));
  el.replaceChildren(h("div", { class: "stack rx" }, notes, panel({ title: "Runs", body: h("div", {}, filterBar, tableBox), flush: true, actions: h("span", { class: "small muted", id: "rx-count" }) }), detailBox));

  // ---------------------------------------------------------------- list
  async function loadList() {
    try {
      const d = await shell.api.get("runs", { query: filtersToQuery(S.filters) });
      if (!alive) return;
      S.rows = d.runs; S.total = d.total; S.blinded = d.blinded_stages;
      S.facets = d.facets;
      paintNotes(); paintFilters(); paintTable();
    } catch (e) {
      if (alive) tableBox.replaceChildren(notice(e.error || String(e), "fail", "circle-alert"));
    }
  }

  function paintNotes() {
    notes.replaceChildren(S.blinded.length
      ? notice(`${S.blinded.join(", ")} ${S.blinded.length > 1 ? "are" : "is"} blinded. Outcomes, CI, oracle, detectors, diff and transcript of those runs open after the stage is complete and unblinded.`, "", "lock")
      : "");
  }

  function paintFilters() {
    const f = S.facets || { stages: [], tickets: [], V: [], S: [], W: [], units: [], statuses: [] };
    const sel = (key, label, options) => h("label", { class: "rx-f" }, h("span", {}, label),
      h("select", { class: "select select-sm", "aria-label": label, onchange: (e) => { S.filters[key] = e.target.value; loadList(); } },
        h("option", { value: "" }, "All"), options.map((o) => h("option", { value: o, selected: S.filters[key] === o, title: GLOSSARY[o]?.long || null },
          GLOSSARY[o] && ["V", "S", "W"].includes(key) ? `${o} · ${GLOSSARY[o].short}` : o))));
    const search = h("input", { class: "input input-sm", type: "search", placeholder: "Run ID or cell", value: S.filters.q, "aria-label": "Search runs", style: { width: "170px" },
      oninput: (e) => { S.filters.q = e.target.value; clearTimeout(timer); timer = setTimeout(loadList, 250); } });
    const active = Object.values(S.filters).some(Boolean);
    filterBar.replaceChildren(sel("stage", "Stage", f.stages), sel("ticket", "Ticket", f.tickets), sel("V", "V", f.V), sel("S", "S", f.S), sel("W", "W", f.W),
      h("div", { class: "rx-f" }, h("span", {}, "Unit"), unitSeg({ units: f.units, value: S.filters.unit, onChange: (v) => { S.filters.unit = v; loadList(); } })),
      sel("status", "Status", f.statuses), h("label", { class: "rx-f" }, h("span", {}, "Search"), search),
      ...(active ? [button({ label: "Clear", small: true, subtle: true, onClick: () => { Object.keys(S.filters).forEach((k) => { S.filters[k] = ""; }); loadList(); } })] : []));
  }

  function paintTable() {
    const count = document.getElementById("rx-count");
    if (count) count.textContent = S.rows.length === S.total ? `${fmtInt(S.total)} runs` : `${fmtInt(S.rows.length)} of ${fmtInt(S.total)} runs`;
    const t = table({
      caption: "Runs", rows: S.rows, rowKey: (r) => r.run_id, selected: S.selected, empty: S.total ? "No run matches these filters." : "No runs have been archived in this namespace yet.",
      onRowClick: (r) => openRun(r.run_id),
      sort: undefined,
      columns: [
        { key: "run_id", label: "ID", sort: true, render: (r) => h("span", { class: "mono strong", "data-run": r.run_id }, r.run_id) },
        { key: "cell", label: "Cell", sort: (r) => r.cell, render: (r) => h("span", { class: "rx-cell", title: `${r.cell}
${conditionTitle(r.visibility, r.spec, r.wording)}` },
          h("span", { class: "strong" }, r.ticket), " · ", plainCondition(r.visibility, r.spec, r.wording), " ",
          h("span", { class: "rx-code mono" }, conditionCode(r.visibility, r.spec, r.wording))) },
        { key: "unit", label: "Unit", sort: (r) => unitInfo(r.unit).label, render: (r) => unitTag(r.unit, { compact: true }) },
        { key: "turns", label: "Turns", num: true, sort: true, render: (r) => fmtInt(r.turns) },
        { key: "duration_ms", label: "Duration", num: true, sort: true, render: (r) => r.duration_ms == null ? "—" : fmtDuration(r.duration_ms) },
        { key: "tokens", label: "Tokens", num: true, sort: true, render: (r) => fmtInt(r.tokens) },
        { key: "flags", label: "Flags", render: (r) => h("span", { class: "rx-chips" }, flagChips(r).map((c) => h("span", { title: c.title }, badge(c.text, c.tone)))) },
        { key: "outcome", label: "Outcome", sort: (r) => r.outcome || "", render: (r) => r.blinded ? h("span", { class: "small muted rx-blind", title: BLINDED }, iconEl("lock", 12), " Blinded")
          : (r.outcome ? h("span", { title: r.outcome }, badge(outcomeLabel(r.outcome), outcomeTone(r.outcome))) : h("span", { class: "muted" }, "—")) },
      ],
    });
    tableBox.replaceChildren(t);
  }

  function markSelected() {
    tableBox.querySelectorAll("[data-run]").forEach((n) => {
      const tr = n.closest("tr");
      if (tr) tr.setAttribute("aria-selected", String(n.dataset.run === S.selected));
    });
  }

  // ---------------------------------------------------------------- detail
  async function openRun(id) {
    S.selected = id;
    markSelected();
    el.firstChild.classList.add("has-run");
    history.replaceState(null, "", `#/runs?run=${encodeURIComponent(id)}${S.tab !== "summary" ? `&tab=${S.tab}` : ""}`);
    const seq = ++S.loadSeq;
    detailBox.replaceChildren(h("p", { class: "loading" }, "Loading…"));
    try {
      const d = await shell.api.get(`runs/${encodeURIComponent(id)}`);
      if (!alive || seq !== S.loadSeq) return;
      S.detail = d;
      S.diffRef = null;
      paintDetail();
    } catch (e) {
      if (alive && seq === S.loadSeq) detailBox.replaceChildren(notice(e.error || String(e), "fail", "circle-alert"));
    }
  }

  function paintDetail() {
    const d = S.detail, r = d.record;
    const replayReason = d.blinded ? BLINDED : (!d.files.replay ? "This run has no trace to replay" : null);
    const head = h("div", { class: "rx-head" },
      h("div", { class: "rx-head-main" },
        h("span", { class: "mono strong rx-id" }, d.run_id),
        h("span", { class: "muted", title: conditionTitle(r.visibility, r.spec, r.wording) },
          `${r.ticket} · ${plainCondition(r.visibility, r.spec, r.wording)} (${conditionCode(r.visibility, r.spec, r.wording)})`),
        unitTag(r.unit, { model: r.model_reported }),
        d.blinded ? badge("Blinded", "neutral") : (r.outcome ? badge(r.outcome, outcomeTone(r.outcome)) : null),
        d.status && d.status !== "done" ? badge(d.status, statusTone(d.status)) : null,
        d.ns === "mock" ? h("span", { class: "rx-sim", title: "SIMULATED (mock agent) — not a real run" }, "SIMULATED (mock agent) — not a real run") : null),
      button({ label: "Open in Replay Theater", icon: "clapperboard", primary: true, small: true, disabled: !!replayReason, reason: replayReason,
        onClick: () => shell.navigate("replay", { run: d.run_id, ns: shell.ns }) }));
    const items = [
      { id: "summary", label: "Summary", icon: "file-text" },
      { id: "diff", label: "Diff", icon: "git-compare", count: d.blinded ? null : (d.files.diffs.length || null) },
      { id: "ci", label: "CI", icon: "list-checks" },
      { id: "oracle", label: "Oracle", icon: "scale" },
      { id: "detectors", label: "Detectors", icon: "flag", count: d.blinded ? null : (r.detector_flags || null) },
      { id: "transcript", label: "Transcript", icon: "message-square" },
      { id: "trace", label: "Trace", icon: "activity" },
    ].map((t) => ({ ...t, label: d.blinded && TAB_LOCKED.has(t.id) ? [t.label, " ", iconEl("lock", 12)] : t.label, render: () => tabBody(t.id) }));
    const tb = tabs({ items, active: S.tab, onChange: (id) => { S.tab = id; history.replaceState(null, "", `#/runs?run=${encodeURIComponent(d.run_id)}${id !== "summary" ? `&tab=${id}` : ""}`); } });
    detailBox.replaceChildren(h("section", { class: "panel rx-panel", "aria-label": `Run ${d.run_id}` }, h("div", { class: "panel-body" }, head, tb)));
  }

  const TAB_LOCKED = new Set(["diff", "ci", "oracle", "detectors", "transcript"]);

  /** Fetch (with cache) one tab's data. */
  async function data(tab, query) {
    const key = `${S.detail.run_id}:${tab}:${JSON.stringify(query || {})}`;
    if (!S.cache.has(key)) S.cache.set(key, shell.api.get(`runs/${encodeURIComponent(S.detail.run_id)}/${tab}`, { query }).catch((e) => { S.cache.delete(key); throw e; }));
    return S.cache.get(key);
  }

  async function tabBody(id) {
    const d = S.detail;
    if (d.blinded && TAB_LOCKED.has(id)) return notice(`${BLINDED}. This tab shows outcome information.`, "", "lock");
    try {
      return await TABS[id](d);
    } catch (e) {
      return notice(e.status === 403 ? BLINDED : (e.error || String(e)), e.status === 403 ? "" : "fail", e.status === 403 ? "lock" : "circle-alert");
    }
  }

  const fill = (box, ...items) => box.replaceChildren(...items.flat(Infinity).filter((x) => x != null && x !== false));
  const kv = (pairs) => h("dl", { class: "kv rx-kv" }, pairs.filter(Boolean).map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  const pre = (text, cls = "") => h("pre", { class: `rx-pre mono small ${cls}` }, text);

  const TABS = {
    // ------------------------------------------------------------ summary
    async summary(d) {
      const r = d.record, t = r.totals || {};
      const tok = (t.input_tokens || 0) + (t.output_tokens || 0);
      const outcomeCell = d.blinded ? h("span", { class: "muted" }, iconEl("lock", 13), ` ${BLINDED}`) : (r.outcome ? badge(r.outcome, outcomeTone(r.outcome)) : "—");
      const doneCell = d.blinded ? h("span", { class: "muted" }, BLINDED) : (r.ticket_done ? badge(r.ticket_done.replace("_", " "), ticketDoneTone(r.ticket_done)) : "—");
      const nodes = [facts([
        { label: "Ticket", value: r.ticket, sub: `${r.wording}${r.paraphrase ? ` · paraphrase ${r.paraphrase}` : ""}` },
        { label: "Condition", value: `${r.visibility} · ${r.spec} · ${r.wording}`, sub: `replicate ${r.replicate}` },
        { label: "Outcome", value: outcomeCell },
        { label: "ticket_done", value: doneCell },
        { label: "Turns", value: fmtInt(t.turns), sub: d.blinded ? null : `${r.repair_attempts ?? 0} repair attempt${r.repair_attempts === 1 ? "" : "s"}` },
        { label: "Duration", value: fmtDuration(r.duration_ms), sub: r.started_at ? fmtDate(r.started_at) : null },
        { label: "Tokens", value: fmtInt(tok), sub: `in ${fmtInt(t.input_tokens)} · out ${fmtInt(t.output_tokens)}`, title: "input + output" },
        { label: "Cache", value: fmtInt((t.cache_read_tokens || 0) + (t.cache_creation_tokens || 0)), sub: `read ${fmtInt(t.cache_read_tokens)} · write ${fmtInt(t.cache_creation_tokens)}` },
      ])];
      const flags = [];
      if (r.contamination && r.contamination.flag) flags.push(badge(`Contaminated (${(r.contamination.hits || []).length} hit${(r.contamination.hits || []).length === 1 ? "" : "s"})`, "fail"));
      if (r.token_exposed) flags.push(badge("Token exposed", "fail"));
      if (r.infra_failure) flags.push(badge(`Infrastructure failure: ${r.infra_failure.kind}`, "warn"));
      if (!d.blinded && r.detector_flags) flags.push(badge(`${r.detector_flags} detector flag${r.detector_flags === 1 ? "" : "s"}`, "warn"));
      if (d.coding_label) flags.push(badge(`Coded ${d.coding_label}`, "accent"));
      const body = [kv([
        ["Run", h("span", { class: "mono" }, d.run_id)],
        ["Stage / unit", [`${d.stage} · `, unitTag(r.unit), " ", h("span", { class: "muted small" }, `unit ${r.unit}, adapter ${r.adapter || "—"}`), /^X[0-9]$/.test(d.stage || "") ? [" ", badge(`Pilot ${d.stage} · exploratory`, "neutral")] : null]],
        ["Model", [r.model_requested, r.model_reported].filter(Boolean).join(" → ") || "—"],
        ["Effort", r.effort || "—"],
        ["Context file", r.context_file || "—"],
        ["Worker", r.worker ?? "—"],
        ["Started", r.started_at ? fmtDate(r.started_at) : "—"],
        ["Ended", r.ended_at ? fmtDate(r.ended_at) : "—"],
        ["Flags", flags.length ? h("span", { class: "rx-chips" }, flags) : h("span", { class: "muted" }, "none")],
      ])];
      if (!d.blinded) {
        const m = r.metrics || {};
        const mkeys = Object.keys(m);
        const pair = [];
        if (mkeys.length) pair.push(h("div", { class: "rx-sub" }, h("h3", {}, "Metrics"),
          table({ keyboard: false, caption: "Metrics", columns: [{ key: "k", label: "Metric", mono: true }, { key: "v", label: "Value", render: (x) => x.v === true ? badge("true", "fail") : x.v === false ? badge("false", "neutral") : String(x.v ?? "—") }],
            rows: mkeys.map((k) => ({ k, v: m[k] })) })));
        if ((r.sessions || []).length) pair.push(h("div", { class: "rx-sub" }, h("h3", {}, "Sessions"),
          table({ keyboard: false, caption: "Agent sessions", columns: [
            { key: "kind", label: "Session", mono: true }, { key: "num_turns", label: "Turns", num: true },
            { key: "duration_ms", label: "Duration", num: true, render: (s) => fmtDuration(s.duration_ms) },
            { key: "tokens", label: "Tokens in / out", num: true, render: (s) => `${fmtInt((s.usage || {}).input_tokens)} / ${fmtInt((s.usage || {}).output_tokens)}` },
            { key: "subtype", label: "Ended as", render: (s) => [s.subtype, s.capped ? badge("capped", "warn") : null, s.is_error ? badge("error", "fail") : null] }],
            rows: r.sessions })));
        if (pair.length) body.push(h("div", { class: "grid-2" }, ...pair));
        if (r.final_message) body.push(h("div", { class: "rx-sub" }, h("h3", {}, "Agent's final message"), h("blockquote", { class: "rx-quote" }, r.final_message)));
        const extra = [...(r.out_of_scope_edits || []).map((x) => `Out of scope edit: ${x}`), ...(r.out_of_workspace_access || []).map((x) => `Outside workspace: ${typeof x === "string" ? x : JSON.stringify(x)}`)];
        if (extra.length) body.push(h("div", { class: "rx-sub" }, h("h3", {}, "Boundary"), h("ul", { class: "rx-list" }, extra.map((x) => h("li", { class: "mono small" }, x)))));
      } else {
        body.push(notice(`${BLINDED}. Outcome, ticket_done, metrics, sessions and the final message are hidden for ${d.stage}; resource use and exclusion flags stay visible.`, "", "lock"));
      }
      if (r.ticket_text) body.push(h("details", { class: "rx-sub" }, h("summary", {}, "Ticket text given to the agent"), pre(r.ticket_text)));
      return h("div", { class: "stack" }, ...nodes, ...body);
    },

    // ------------------------------------------------------------ diff
    async diff(d) {
      const res = await data("diff");
      if (!res.diffs.length) return empty("This run has no diffs archived.");
      const ref = S.diffRef && res.diffs.some((x) => x.ref === S.diffRef) ? S.diffRef : res.diffs[0].ref;
      S.diffRef = ref;
      const cur = res.diffs.find((x) => x.ref === ref);
      const files = parseDiff(cur.text);
      const st = diffStats(files);
      const box = h("div", { class: "stack" });
      const redraw = () => {
        fill(box,
          h("div", { class: "rx-toolbar" },
            h("div", { class: "rx-seg", role: "group", "aria-label": "Attempt" }, res.diffs.map((x) => h("button", { type: "button", "aria-pressed": String(x.ref === S.diffRef), onclick: () => { S.diffRef = x.ref; paintTabKeep("diff"); } }, x.ref))),
            h("div", { class: "rx-seg", role: "group", "aria-label": "View" }, [["unified", "Unified"], ["split", "Side by side"]].map(([v, l]) => h("button", { type: "button", "aria-pressed": String(S.diffView === v), onclick: () => { S.diffView = v; paintTabKeep("diff"); } }, l))),
            h("span", { class: "small muted" }, `${st.files} file${st.files === 1 ? "" : "s"} · `, h("span", { class: "rx-add" }, `+${st.additions}`), " ", h("span", { class: "rx-del" }, `−${st.deletions}`), ` · ${fmtBytes(cur.bytes)}`),
            cur.incremental ? h("span", { class: "small muted" }, "Incremental: only what changed since the previous attempt") : null),
          cur.truncated ? notice(`This diff is larger than the limit and is cut at ${fmtBytes(300000)}.`, "warn", "triangle-alert") : null,
          files.length ? files.map((f) => diffFile(f)) : (cur.text.trim() ? pre(cur.text) : empty("This attempt changed nothing.")));
      };
      redraw();
      return box;
    },

    // ------------------------------------------------------------ CI
    async ci(d) {
      const res = await data("ci");
      if (!res.attempts.length) return empty("No CI result is recorded for this run.");
      return h("div", { class: "stack" }, res.attempts.map((a) => h("section", { class: "rx-attempt" },
        h("div", { class: "rx-attempt-head" }, h("span", { class: "strong mono" }, a.ref), h("span", { class: "muted small" }, `attempt ${a.attempt}`),
          badge(a.ok ? "CI green" : `CI red${a.failed.length ? `: ${a.failed.join(", ")}` : ""}`, a.ok ? "pass" : "fail")),
        table({ keyboard: false, caption: `CI checks of ${a.ref}`, columns: [
          { key: "id", label: "Check", render: (c) => h("span", { class: isArch(c.id) || c.rule ? "strong rx-arch" : "mono" }, c.id) },
          { key: "category", label: "Category" },
          { key: "status", label: "Result", render: (c) => badge(c.status, c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : "neutral") },
          { key: "duration_ms", label: "Time", num: true, render: (c) => c.duration_ms == null ? "—" : `${fmtInt(c.duration_ms)} ms` },
          { key: "output", label: "Output", render: (c) => c.output ? h("details", { class: "rx-out", open: c.status === "fail" }, h("summary", {}, firstLine(c.output)), archPre(c.output)) : h("span", { class: "muted" }, "—") }],
          rows: a.checks }),
        a.feedback_text ? h("details", { class: "rx-out" }, h("summary", {}, "Feedback sent to the agent"), archPre(a.feedback_text)) : null)));
    },

    // ------------------------------------------------------------ oracle
    async oracle(d) {
      const res = await data("oracle");
      const one = (title, v) => h("section", { class: "rx-attempt" },
        h("div", { class: "rx-attempt-head" }, h("span", { class: "strong" }, title), v ? badge(v.ok ? "No consumer broke" : "A consumer broke", v.ok ? "pass" : "fail") : badge("Not run", "neutral")),
        v ? table({ keyboard: false, caption: title, columns: [
          { key: "name", label: "Consumer", mono: true },
          { key: "status", label: "Result", render: (c) => badge(c.status, c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : "warn") },
          { key: "message", label: "Message", render: (c) => c.message ? h("span", { class: "mono small" }, c.message) : "—" }],
          rows: Object.entries(v.consumers || {}).map(([name, c]) => ({ name, ...c })) }) : empty("No oracle result (infrastructure failure or not reached)."));
      const done = (label, v, chk) => v ? h("div", { class: "small" }, h("span", { class: "muted" }, `${label} `), badge(v.replace("_", " "), ticketDoneTone(v)),
        chk && chk.detail ? h("span", { class: "muted" }, ` ${chk.detail}`) : null) : null;
      // ticket_done is judged on the final PR; gen is shown beside it only when a repair changed it
      const genDiffers = res.ticket_done_gen && res.ticket_done_gen !== res.ticket_done;
      return h("div", { class: "stack" }, one("After generation (gen)", res.gen), one("Final", res.final),
        done(genDiffers ? "ticket_done (final)" : "ticket_done", res.ticket_done, res.ticket_check),
        genDiffers ? done("ticket_done (gen)", res.ticket_done_gen, res.ticket_check_gen) : null);
    },

    // ------------------------------------------------------------ detectors
    async detectors(d) {
      const res = await data("detectors");
      const rows = [];
      for (const e of res.entries) for (const f of e.flags || []) rows.push({ ref: e.ref, range: e.range, ...f });
      const nodes = [h("div", { class: "row" }, h("span", { class: "strong" }, "Blind coding label"),
        res.coding_label ? badge(res.coding_label, "accent") : h("span", { class: "muted small" }, "not coded yet (T1 benign, T2 weakened, T3 evaded; coded blind after the stage completes)"))];
      nodes.push(rows.length ? table({ keyboard: false, caption: "Detector flags", columns: [
        { key: "ref", label: "Attempt", mono: true }, { key: "range", label: "Range", mono: true },
        { key: "detector", label: "Detector", render: (f) => [h("span", { class: "strong" }, f.detector), " ", h("span", { class: "muted small" }, res.names[f.detector] || "")] },
        { key: "path", label: "Path", mono: true }, { key: "summary", label: "Summary" }], rows })
        : empty("No detector fired in any attempt."));
      const bounds = [...res.out_of_scope_edits.map((x) => ["Out of scope edit", x]), ...res.out_of_workspace_access.map((x) => ["Outside workspace", typeof x === "string" ? x : JSON.stringify(x)])];
      if (bounds.length) nodes.push(h("div", { class: "rx-sub" }, h("h3", {}, "Recorded, not detectors"), kv(bounds)));
      const hits = (res.contamination && res.contamination.hits) || [];
      if (hits.length) nodes.push(h("div", { class: "rx-sub" }, h("h3", {}, "Contamination hits"), table({ keyboard: false, caption: "Contamination", columns: [
        { key: "origin", label: "Origin" }, { key: "where", label: "Where", mono: true }, { key: "canary", label: "Canary", mono: true }], rows: hits })));
      return h("div", { class: "stack" }, ...nodes);
    },

    // ------------------------------------------------------------ transcript
    async transcript(d) {
      const events = [];
      let total = 0, cut = false;
      const box = h("div", { class: "stack" });
      async function more() {
        const res = await data("transcript", { offset: events.length, limit: 500 });
        events.push(...res.events); total = res.total; cut = cut || res.truncated_strings;
        draw();
      }
      function draw() {
        const groups = groupTranscript(events);
        fill(box,
          h("div", { class: "rx-toolbar" }, h("span", { class: "small muted" }, `${fmtInt(events.length)} of ${fmtInt(total)} events`),
            button({ label: "Expand tools", small: true, subtle: true, onClick: () => box.querySelectorAll("details.rx-tool").forEach((x) => { x.open = true; }) }),
            button({ label: "Collapse tools", small: true, subtle: true, onClick: () => box.querySelectorAll("details.rx-tool").forEach((x) => { x.open = false; }) })),
          cut ? h("div", { class: "small muted" }, "Very long outputs are cut in this view.") : null,
          groups.map((g) => h("section", { class: "rx-session" }, h("h3", {}, g.session), g.items.map(transcriptItem))),
          events.length < total ? button({ label: `Load more (${fmtInt(total - events.length)} left)`, small: true, onClick: more }) : null);
      }
      await more();
      return box;
    },

    // ------------------------------------------------------------ trace
    async trace(d) {
      const res = await data("trace");
      const nodes = [facts([
        { label: "Validator (AISDLC-Trace 2.1)", value: badge(res.valid ? "Valid" : `${res.violation_count} violation${res.violation_count === 1 ? "" : "s"}`, res.valid ? "pass" : "fail") },
        { label: "Events", value: fmtInt(res.events) },
        { label: "Rules violated", value: res.rules.length ? res.rules.join(", ") : "none" },
        d.blinded ? null : { label: "Recorded at run time", value: res.recorded_valid == null ? "—" : (res.recorded_valid ? "valid" : "invalid") },
      ].filter(Boolean))];
      if (d.blinded) nodes.push(notice("Only the validity of the trace is shown while the stage is blinded; the events carry CI and oracle results.", "", "lock"));
      else if (res.violations && res.violations.length) nodes.push(table({ keyboard: false, caption: "Trace violations", columns: [
        { key: "seq", label: "Seq", num: true }, { key: "rule", label: "Rule", mono: true }, { key: "message", label: "Message" }], rows: res.violations }));
      return h("div", { class: "stack" }, ...nodes);
    },
  };

  function paintTabKeep(tab) {
    S.tab = tab;
    paintDetail();
  }

  // ---------------------------------------------------------------- renderers
  const firstLine = (s) => String(s).split("\n")[0].slice(0, 110) || "(empty)";
  const archPre = (text) => h("pre", { class: "rx-pre mono small" }, splitArch(text).map((p) => p.arch ? h("strong", {}, p.text) : p.text));

  function diffFile(f) {
    const head = h("div", { class: "rx-file-head" }, h("span", { class: "mono strong" }, f.path),
      f.status !== "modified" ? badge(f.status, "neutral") : null,
      h("span", { class: "small" }, h("span", { class: "rx-add" }, `+${f.additions}`), " ", h("span", { class: "rx-del" }, `−${f.deletions}`)));
    if (f.binary) return h("section", { class: "rx-file" }, head, h("p", { class: "small muted rx-pad" }, "Binary file"));
    const split = S.diffView === "split";
    const rows = [];
    for (const hk of f.hunks) {
      rows.push(h("tr", { class: "rx-hunk" }, h("td", { colspan: split ? 4 : 3 }, hk.header)));
      if (!split) {
        for (const l of hk.lines) rows.push(h("tr", { class: `rx-l l-${l.type}` }, h("td", { class: "ln" }, l.old ?? ""), h("td", { class: "ln" }, l.new ?? ""),
          h("td", { class: "code" }, h("span", { class: "sign" }, l.type === "add" ? "+" : l.type === "del" ? "−" : " "), l.text)));
      } else {
        for (const r of sideBySide(hk)) {
          const side = (l, n) => l ? [h("td", { class: `ln l-${l.type}` }, l[n] ?? ""), h("td", { class: `code l-${l.type}` }, l.text)] : [h("td", { class: "ln rx-empty" }), h("td", { class: "code rx-empty" })];
          rows.push(h("tr", { class: "rx-l" }, ...side(r.left, "old"), ...side(r.right, "new")));
        }
      }
    }
    return h("section", { class: "rx-file" }, head, h("div", { class: "rx-diff-wrap" }, h("table", { class: ["rx-diff", split ? "is-split" : null] }, h("tbody", {}, ...rows))));
  }

  function transcriptItem(it) {
    if (it.type === "text") return h("div", { class: "rx-say" }, h("span", { class: "rx-ts small muted" }, fmtTime(it.ts)), h("div", {}, it.text));
    if (it.type === "final") return h("div", { class: "rx-final small" }, h("span", { class: "rx-ts muted" }, fmtTime(it.ts)),
      h("span", {}, "Session ended: ", h("span", { class: "strong" }, it.subtype || "—"), it.is_error ? badge("error", "fail") : null,
        ` · ${fmtInt(it.turns)} turns · ${fmtDuration(it.duration_ms)}`, it.usage ? ` · ${fmtInt((it.usage.input_tokens || 0) + (it.usage.output_tokens || 0))} tokens` : ""),
      it.text ? h("div", { class: "rx-quote" }, it.text) : null);
    if (it.type === "result") return h("details", { class: "rx-tool" }, h("summary", {}, h("span", { class: "muted" }, "result "), badge(it.status || "—", it.status === "success" ? "pass" : "fail")), pre(it.output ?? ""));
    const r = it.result;
    return h("details", { class: "rx-tool" },
      h("summary", {}, h("span", { class: "strong" }, it.name), " ", h("span", { class: "mono small" }, it.summary),
        r ? badge(r.status, r.status === "success" ? "pass" : "fail") : h("span", { class: "small muted" }, " no result")),
      h("div", { class: "rx-io" }, h("div", { class: "small muted" }, "Input"), pre(JSON.stringify(it.input, null, 2)),
        r ? [h("div", { class: "small muted" }, "Output"), pre(typeof r.output === "string" ? r.output : JSON.stringify(r.output, null, 2))] : null));
  }

  // ---------------------------------------------------------------- live updates and start
  shell.subscribe("runner.run_finished", (d) => { if (!d || !d.ns || d.ns === shell.ns) { clearTimeout(timer); timer = setTimeout(() => alive && loadList(), 1500); } });
  await loadList();
  if (shell.params.run) {
    S.tab = ["summary", "diff", "ci", "oracle", "detectors", "transcript", "trace"].includes(shell.params.tab) ? shell.params.tab : "summary";
    await openRun(shell.params.run);
    markSelected();
  }
}
