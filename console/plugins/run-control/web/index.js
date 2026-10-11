// Run Control (spec §22.2): stage cards, launch / stop / workers / dry run, live view of the runner.
// Data: GET /api/run-control/{stages,status,log}; actions POST …/{dry-run,start,stop,workers,resume-at,unblind}.
// Live: shell.subscribe("runner.progress" | "runner.run_started" | "runner.run_finished" | "runner.stopped" | "runner.rate_limited").
import { h, table, badge, bar, button, panel, notice, empty, field, fmtInt, fmtDuration, fmtTime, fmtDate, iconEl } from "/web/lib/ui.js";
import {
  fmtElapsed, fmtCompact, cellLabel, cellKeyLabel, stageBadges, outcomeEntries, launchBody, validAmount, reasonFor, launchSignature, hhmm,
} from "./model.js";
import { outputPanel } from "./output.js";

let alive = false;
let timers = [];
let term = null;

export function unmount() {
  alive = false;
  if (term) { term.stop(); term = null; }
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  timers = [];
}

export async function mount(el, shell) {
  alive = true;
  const S = {
    stages: null, status: null,
    form: { stage: shell.params.stage || "P1", mode: "runs", amount: "8", workers: 1, unit: "" },
    dry: null, busy: false, launchSig: null, expanded: new Set(),
  };
  const canWrite = shell.canWrite !== false;
  shell.setHeader({
    title: "Run Control",
    subtitle: shell.ns === "mock" ? "Launch and follow mock batches" : "Launch and follow real batches",
    actions: [{ id: "refresh", label: "Refresh", icon: "refresh-cw", onClick: () => loadAll() }],
  });

  const strip = h("div", { class: "stack-sm rc-strip" });
  const cards = h("div", { class: "rc-cards-box" });
  const launch = h("div", { class: "rc-launch-box" });
  const live = h("div", { class: "stack rc-live" });
  const root = h("div", { class: "stack rc" }, strip, cards, launch, live);
  term = outputPanel(shell, { isAlive: () => !!(S.status && S.status.alive), onToggle: (v) => layout.classList.toggle("is-term-closed", !v) });
  const layout = h("div", { class: ["rc-layout", !term.isOpen() && "is-term-closed"] }, root, term.el);
  el.replaceChildren(layout);
  cards.append(h("p", { class: "loading" }, "Loading…"));

  // ---------------------------------------------------------------- loading
  async function loadStatus() {
    try {
      const was = S.status && S.status.alive;
      S.status = await shell.api.get("run-control/status");
      if (term && was !== S.status.alive) term.nudge();
      paintStrip(); paintLive(); paintLaunch();
    }
    catch (e) { if (alive) strip.replaceChildren(notice(e.error || String(e), "fail", "circle-alert")); }
  }
  async function loadStages() {
    try { S.stages = await shell.api.get("run-control/stages"); S.form.workers = S.stages.settings.workers; paintCards(); paintLaunch(); }
    catch (e) { if (alive) cards.replaceChildren(notice(e.error || String(e), "fail", "circle-alert")); }
  }
  const loadAll = () => Promise.all([loadStatus(), loadStages()]);

  let lastStatus = 0, lastStages = 0, pending = null;
  function soon() {
    if (pending) return;
    pending = setTimeout(async () => {
      pending = null;
      if (!alive) return;
      const now = Date.now();
      if (now - lastStatus > 1500) { lastStatus = now; await loadStatus(); }
      if (now - lastStages > 4000) { lastStages = now; await loadStages(); }
    }, 700);
    timers.push(pending);
  }
  const mine = (fn) => (d) => { if (!d || !d.ns || d.ns === shell.ns) fn(d); };
  shell.subscribe("runner.progress", mine((d) => { applyProgress(d); soon(); }));
  ["runner.run_started", "runner.run_finished", "runner.stopped", "runner.rate_limited"].forEach((t) => shell.subscribe(t, mine(() => { lastStatus = lastStages = 0; soon(); })));
  timers.push(setInterval(() => { if (alive) { lastStatus = lastStages = 0; soon(); } }, 15000));   // fallback if SSE drops
  timers.push(setInterval(tick, 1000));

  /** Live numbers from runner.progress without a round trip. */
  function applyProgress(d) {
    const s = S.status;
    if (!s || !d.workers) return;
    const r = d.runner || {};
    s.runner = { ...s.runner, status: r.status ?? s.runner.status, done: (r.batch || {}).done, planned: (r.batch || {}).planned };
    s.batch = r.batch ?? s.batch;
    s.sleep_prevented = !!(s.alive && r.sleep_prevented);
    s.workers = s.workers.map((col) => {
      const w = d.workers[String(col.worker)];
      return { worker: col.worker, run: !s.alive || !w ? null : { run_id: w.run_id, ticket: w.ticket, cell: w.cell, attempt: w.attempt, started_at: w.started_at, turns: w.turns, tokens: w.tokens } };
    });
    paintStrip();
    paintLive(true);
  }

  function tick() {
    if (!alive) return;
    el.querySelectorAll("[data-since]").forEach((n) => {
      const t = Date.parse(n.dataset.since);
      n.textContent = Number.isNaN(t) ? "—" : fmtElapsed((Date.now() - t) / 1000);
    });
  }

  // ---------------------------------------------------------------- actions
  const guardReasonsOf = (stage) => {
    const c = S.stages && S.stages.stages.find((x) => x.stage === stage);
    return c ? c.guard.reasons.map((r) => r.message) : [];
  };

  async function confirmReal(title, plan, confirmLabel) {
    if (shell.ns !== "real") return true;
    const lines = (plan.summary || []).map((l) => h("div", { class: l.startsWith("Command:") ? "mono small rc-cmd" : null }, l));
    return shell.confirm({ title, confirmLabel, message: h("div", { class: "stack-sm" }, ...lines, plan.notes && plan.notes.length ? h("div", { class: "small muted" }, plan.notes.join(" ")) : null) });
  }

  async function guarded(fn) {
    if (S.busy) return;
    S.busy = true;
    try { await fn(); } catch (e) { shell.toast(e.error || String(e), "error"); } finally { S.busy = false; }
  }

  const runDry = () => guarded(async () => {
    S.dry = await shell.api.post("run-control/dry-run", launchBody(S.form));
    S.launchSig = null;
    paintLaunch();
  });

  const startBatch = (calibrate) => guarded(async () => {
    const body = launchBody(S.form, { calibrate });
    const plan = await shell.api.post("run-control/start", { ...body, preview: true });
    if (plan.blocking.length) { shell.toast(plan.blocking[0].message, "error"); return; }
    const title = calibrate ? "Calibrate (P0) in the REAL namespace?" : `Run ${plan.stage} batch in the REAL namespace?`;
    if (!(await confirmReal(title, plan, calibrate ? "Calibrate" : "Run batch"))) return;
    const r = await shell.api.post("run-control/start", { ...body, confirmed: shell.ns === "real" });
    shell.toast(`Runner started (pid ${r.pid})`, "ok");
    S.dry = null; lastStatus = lastStages = 0;
    setTimeout(() => alive && loadAll(), 1500);
    await loadAll();
  });

  const stopNow = () => guarded(async () => {
    const st = S.status;
    const plan = { summary: [`Namespace: ${shell.ns.toUpperCase()}`, `Stop after the current run${st.workers_count > 1 ? "s" : ""}.`,
      st.stage ? `Stage ${st.stage}: ${st.runner.done ?? 0} of ${st.runner.planned ?? "?"} done in this batch.` : "",
      "The runner finishes what is in progress, writes its state and exits."].filter(Boolean) };
    if (!(await confirmReal("Stop the real batch after the current run?", plan, "Stop after current"))) return;
    await shell.api.post("run-control/stop", { confirmed: shell.ns === "real" });
    shell.toast("Stop requested; the runner exits after the current run", "ok");
    await loadStatus();
  });

  const setWorkers = (n) => guarded(async () => {
    S.form.workers = n;
    const r = await shell.api.post("run-control/workers", { workers: n });
    if (S.stages) S.stages.settings = r.settings;
    shell.toast(`Workers set to ${n} ${r.applies}`, "ok");
    S.launchSig = null;
    await loadStatus();
  });

  const resume = (at) => guarded(async () => {
    const plan = await shell.api.post("run-control/resume-at", { at, preview: true });
    if (plan.blocking.length) { shell.toast(plan.blocking[0].message, "error"); return; }
    if (!(await confirmReal(`Resume at ${plan.at_local}?`, plan, `Resume at ${plan.at_local}`))) return;
    await shell.api.post("run-control/resume-at", { at, confirmed: shell.ns === "real" });
    shell.toast(`Resume scheduled for ${plan.at_local}`, "ok");
    await loadAll();
  });

  const cancelResume = () => guarded(async () => {
    await shell.api.post("run-control/resume-at", { cancel: true });
    shell.toast("Scheduled resume cancelled", "ok");
    await loadAll();
  });

  const unblind = (card) => guarded(async () => {
    const ok = await shell.confirm({
      title: `Unblind ${card.stage}?`, confirmLabel: "Unblind", requireText: `UNBLIND ${card.stage}`,
      message: h("div", { class: "stack-sm" }, h("div", {}, `Outcomes of ${card.stage} (${card.done} of ${card.total} runs) become visible in Results and Run Explorer.`),
        h("div", { class: "small muted" }, "This is recorded in the audit log and cannot be undone.")),
    });
    if (!ok) return;
    await shell.api.post("run-control/unblind", { stage: card.stage, confirm: `UNBLIND ${card.stage}` });
    shell.toast(`${card.stage} unblinded`, "ok");
    await loadAll();
  });

  // ---------------------------------------------------------------- status strip
  function paintStrip() {
    const s = S.status;
    if (!s) return;
    const r = s.runner;
    const nodes = [];
    const running = s.alive;
    root.classList.toggle("is-alive", !!running);
    let state;
    if (running) {
      const stopping = r.status === "stopping" || s.stop_requested;
      state = h("div", { class: "row" },
        badge(stopping ? "Stopping after current" : (r.status === "running" ? "Running" : "Starting"), "accent"),
        h("span", { class: "strong" }, s.stage ? `${s.stage}` : "Batch"),
        h("span", { class: "num" }, r.planned != null ? `${fmtInt(r.done ?? 0)} of ${fmtInt(r.planned)} done in this batch` : `${fmtInt(r.done ?? 0)} done`),
        h("span", { class: "muted" }, `${s.workers_count} worker${s.workers_count > 1 ? "s" : ""}`),
        s.started_at ? h("span", { class: "muted" }, `started ${fmtTime(s.started_at)}${s.launch && s.launch.by ? ` by ${s.launch.by}` : ""}`) : null,
        s.batch && s.batch.max_minutes ? h("span", { class: "muted" }, `limit ${s.batch.max_minutes} min`) : null,
        h("span", { class: "grow" }),
        button({ label: "Stop after current", icon: "circle-stop", disabled: !canWrite || stopping, reason: stopping ? "Stop already requested" : "Your role cannot stop runs", onClick: stopNow }));
    } else {
      const label = { rate_limited: "Stopped by usage limit", error: "Runner error", stopped: "Stopped" }[r.status] || "Idle";
      state = h("div", { class: "row" }, badge(label, r.status === "rate_limited" || r.status === "error" ? "warn" : "neutral"),
        h("span", { class: "muted" }, r.message ? r.message : (r.status === "idle" ? "No runner is active in this namespace" : (r.stage ? `Last batch: ${r.stage}, ${r.done ?? 0} of ${r.planned ?? "?"} done` : ""))));
    }
    nodes.push(panel({ title: "Runner", body: h("div", { class: "stack-sm" }, state,
      running ? h("div", { class: "small rc-sleep" }, iconEl("moon", 14),
        s.sleep_prevented ? "Sleep prevented while running" : "The runner did not report sleep prevention") : null,
      running && s.heartbeat_stale ? notice(`No heartbeat from the runner for ${s.heartbeat_age_s} s. It may be stuck.`, "warn", "triangle-alert") : null,
      s.launch && s.launch.log_tail && s.launch.log_tail.some((l) => /refused|error|traceback/i.test(l))
        ? h("details", { class: "rc-log", open: true }, h("summary", {}, "The last runner exited early; its output"), h("pre", { class: "mono small" }, s.launch.log_tail.join("\n"))) : null) }));
    // usage-limit strip
    const rl = s.rate_limit;
    if (rl) {
      const until = rl.until;
      const sched = rl.scheduled_at;
      nodes.push(h("div", { class: "notice warn rc-limit", role: "status" }, iconEl("clock", 16),
        h("div", { class: "grow" },
          h("div", { class: "strong" }, rl.limited ? "Usage limit reached" : "Resume scheduled"),
          h("div", { class: "small" }, rl.limited
            ? (until ? `The quota resets at ${hhmm(until)} (${fmtDate(until)}). The runner stopped cleanly; nothing was lost.` : "The reset time is not known; choose a time to resume.")
            : null,
            sched ? ` Resume scheduled for ${hhmm(sched)} by ${rl.scheduled_by || "—"}.` : null)),
        h("div", { class: "row" },
          sched ? button({ label: "Cancel resume", small: true, disabled: !canWrite, reason: "Your role cannot do this", onClick: cancelResume }) : null,
          rl.limited && until && !sched ? button({ label: `Resume at ${hhmm(until)}`, icon: "clock", primary: true, small: true, disabled: !canWrite || s.alive, reason: "Not available", onClick: () => resume(null) }) : null,
          rl.limited && !until && !sched ? resumeCustom() : null)));
    }
    strip.replaceChildren(...nodes);
  }

  function resumeCustom() {
    const input = h("input", { class: "input input-sm", type: "time", "aria-label": "Resume at (HH:MM)", style: { width: "110px" } });
    return h("span", { class: "row" }, input, button({ label: "Resume at…", small: true, primary: true, onClick: () => input.value ? resume(input.value) : shell.toast("Pick a time first", "info") }));
  }

  // ---------------------------------------------------------------- stage cards
  function paintCards() {
    const d = S.stages;
    if (!d) return;
    cards.replaceChildren(h("div", { class: "section-title" }, h("h2", {}, "Stages"), h("span", { class: "small muted" }, `${shell.ns} namespace · updated ${fmtTime(d.generated_at)}`)),
      h("div", { class: "rc-cards" }, d.stages.map(stageCard)));
  }

  function stageCard(c) {
    const badges = stageBadges(c).map(([t, tone]) => badge(t, tone));
    const pct = c.total ? c.done : 0;
    const body = [];
    if (c.in_manifest) {
      body.push(h("div", { class: "rc-card-prog" }, bar(c.done, c.total, { running: c.running }),
        h("span", { class: "num strong" }, `${fmtInt(c.done)} of ${fmtInt(c.total)}`),
        c.running ? h("span", { class: "small muted" }, `${c.running} running`) : null));
      const shown = S.expanded.has(c.stage) ? c.cells : c.cells.slice(0, 5);
      body.push(h("div", { class: "rc-cells" }, shown.map((x) => h("div", { class: "rc-cell", title: x.cell },
        h("span", { class: "rc-cell-name" }, cellLabel(x)),
        bar(x.done, x.total, { running: x.running }),
        h("span", { class: "num small" }, `${x.done}/${x.total}`)))));
      if (c.cells.length > 5) body.push(h("button", { type: "button", class: "btn btn-subtle btn-sm rc-more", onclick: () => { S.expanded.has(c.stage) ? S.expanded.delete(c.stage) : S.expanded.add(c.stage); paintCards(); } },
        S.expanded.has(c.stage) ? "Show fewer cells" : `Show all ${c.cells.length} cells`));
      body.push(h("div", { class: "rc-card-foot small" },
        h("span", { title: c.tokens == null ? "" : `${fmtInt(c.tokens)} tokens (input + output + cache)` }, h("span", { class: "muted" }, "Tokens "), h("span", { class: "num" }, c.tokens == null ? "—" : fmtCompact(c.tokens))),
        h("span", {}, h("span", { class: "muted" }, "Minutes "), h("span", { class: "num" }, c.minutes == null ? "—" : fmtInt(c.minutes))),
        c.infra_events ? h("span", {}, h("span", { class: "muted" }, "Infra failures "), h("span", { class: "num" }, c.infra_events)) : null));
      if (c.outcomes) {
        const ents = outcomeEntries(c.outcomes);
        body.push(h("div", { class: "small rc-outcomes" }, h("span", { class: "muted" }, "Outcomes "), ents.length ? ents.map(([k, v]) => h("span", { class: "rc-oc" }, `${k} `, h("span", { class: "num" }, v))) : "none yet"));
      } else {
        body.push(h("div", { class: "small muted" }, iconEl("lock", 13), " Outcomes: Blinded until stage complete"));
      }
    } else {
      body.push(h("p", { class: "small muted" }, c.note || "Not in the manifest."));
    }
    const actions = [];
    if (c.runnable && c.in_manifest) {
      const reasons = c.guard.reasons.map((r) => r.message);
      actions.push(button({ label: "Run…", icon: "play", small: true, primary: S.form.stage === c.stage,
        disabled: !canWrite || reasons.length > 0, reason: reasons[0] || "Your role cannot launch runs",
        onClick: () => { S.form.stage = c.stage; S.dry = null; S.launchSig = null; paintLaunch(); launch.scrollIntoView({ block: "nearest", behavior: "smooth" }); } }));
      if (reasons.length) actions.push(h("span", { class: "small rc-reason", title: reasons.join("; ") }, iconEl("lock", 12), reasons[0]));
    }
    if (c.complete && c.blinding === "blinded" && S.stages.can_unblind) {
      actions.push(button({ label: "Unblind…", icon: "eye", small: true, onClick: () => unblind(c) }));
    }
    return h("section", { class: ["panel", "rc-card", c.status === "running" ? "is-running" : null, !c.in_manifest ? "is-off" : null], "aria-label": `${c.stage} ${c.name}` },
      h("header", { class: "rc-card-head" }, h("span", { class: "strong rc-stage" }, c.stage), h("span", { class: "muted" }, c.name), h("span", { class: "grow" }), ...badges),
      h("div", { class: "rc-card-body" }, ...body),
      actions.length ? h("footer", { class: "rc-card-actions" }, ...actions) : null);
  }

  // ---------------------------------------------------------------- launch panel
  function paintLaunch() {
    const d = S.stages, s = S.status;
    if (!d || !s) return;
    const card = d.stages.find((x) => x.stage === S.form.stage);
    const guardReasons = card && card.runnable ? card.guard.reasons.map((r) => r.message) : [];
    const p0 = d.stages.find((x) => x.stage === "P0");
    const p0Reasons = p0 ? p0.guard.reasons.map((r) => r.message) : [];
    const sig = launchSignature({ alive: s.alive, ns: shell.ns, units: d.units, guards: [S.form.stage, guardReasons, p0Reasons, !!S.dry, canWrite] });
    if (sig === S.launchSig && launch.firstChild) return;   // do not rebuild while the user types
    S.launchSig = sig;
    const amountOk = validAmount(S.form);
    const common = { alive: s.alive, canWrite, stageRunnable: !!(card && card.runnable && card.in_manifest), amountOk };
    const rBatch = reasonFor("batch", { ...common, guardReasons });
    const rCal = reasonFor("calibrate", { ...common, stageRunnable: !!(p0 && p0.in_manifest), guardReasons: p0Reasons });
    const rDry = reasonFor("dry", common);

    const stageSel = h("select", { class: "select", "aria-label": "Stage", onchange: (e) => { S.form.stage = e.target.value; S.dry = null; S.launchSig = null; paintLaunch(); } },
      d.stages.filter((x) => x.runnable).map((x) => h("option", { value: x.stage, selected: x.stage === S.form.stage }, `${x.stage} · ${x.name}`)));
    const amount = h("input", { class: "input", type: "number", min: "1", step: S.form.mode === "minutes" ? "any" : "1", value: S.form.amount, "aria-label": S.form.mode === "minutes" ? "Minutes" : "Number of runs", style: { width: "90px" },
      oninput: (e) => { S.form.amount = e.target.value; S.dry = null; } });
    const modeSel = h("select", { class: "select", "aria-label": "Limit", style: { minWidth: "110px" }, onchange: (e) => { S.form.mode = e.target.value; S.launchSig = null; paintLaunch(); } },
      h("option", { value: "runs", selected: S.form.mode === "runs" }, "runs"), h("option", { value: "minutes", selected: S.form.mode === "minutes" }, "minutes"));
    const workerSel = h("select", { class: "select", "aria-label": "Workers", style: { minWidth: "70px" }, disabled: !canWrite, onchange: (e) => setWorkers(Number(e.target.value)) },
      [1, 2, 3].map((n) => h("option", { value: n, selected: Number(S.form.workers) === n }, String(n))));
    const unitSel = shell.ns === "real" ? h("select", { class: "select", "aria-label": "Unit", onchange: (e) => { S.form.unit = e.target.value; S.dry = null; } },
      h("option", { value: "", selected: !S.form.unit }, "All units of the stage"), d.units.map((u) => h("option", { value: u, selected: S.form.unit === u }, u))) : null;

    const reasonLine = (r) => r ? h("div", { class: "small rc-reason" }, iconEl("lock", 13), r) : null;
    const body = h("div", { class: "stack" },
      h("div", { class: "rc-form" },
        field("Stage", stageSel), field("Limit", h("span", { class: "row" }, amount, modeSel)), field("Workers", workerSel), unitSel ? field("Unit", unitSel) : null),
      h("div", { class: "small muted rc-workers-note" }, iconEl("info", 13), d.workers_notice, ". The count applies to the next batch."),
      h("div", { class: "row" },
        button({ label: "Dry run", icon: "list-checks", disabled: !!rDry, reason: rDry, onClick: runDry }),
        button({ label: "Run batch", icon: "play", primary: true, disabled: !!rBatch, reason: rBatch, onClick: () => startBatch(false) }),
        button({ label: "Calibrate (P0)", icon: "gauge", disabled: !!rCal, reason: rCal, onClick: () => startBatch(true) }),
        button({ label: "Stop after current", icon: "circle-stop", disabled: !canWrite || !s.alive, reason: !canWrite ? "Your role cannot stop runs" : "No runner is running", onClick: stopNow })),
      h("div", { class: "stack-sm" }, reasonLine(rBatch ? `Run batch unavailable: ${rBatch}` : null),
        reasonLine(rCal && rCal !== rBatch ? `Calibrate unavailable: ${rCal}` : null)),
      S.dry ? dryResult(S.dry) : null);
    launch.replaceChildren(panel({ title: "Launch", body }));
  }

  function dryResult(p) {
    return h("div", { class: "stack-sm rc-dry" },
      h("div", { class: "row" }, h("span", { class: "strong" }, `Dry run: ${fmtInt(p.count)} run${p.count === 1 ? "" : "s"} would run`),
        h("span", { class: "muted small" }, `${fmtInt(p.pending)} pending in ${p.stage} · ${p.workers} worker${p.workers > 1 ? "s" : ""}`)),
      p.blocking.length ? notice(p.blocking.map((b) => b.message).join(" · "), "warn", "lock") : null,
      p.notes.length ? h("div", { class: "small muted" }, p.notes.join(" ")) : null,
      h("div", { class: "mono small rc-cmd" }, p.command),
      table({ caption: "Runs a batch would start", keyboard: false, empty: "Nothing would run.",
        columns: [{ key: "run_id", label: "Run", mono: true }, { key: "ticket", label: "Ticket" },
          { key: "cond", label: "V·S·W", render: (r) => `${r.visibility}·${r.spec}·${r.wording}${r.control ? " control" : ""}` },
          { key: "unit", label: "Unit" }, ...(p.runs.some((r) => r.paraphrase) ? [{ key: "paraphrase", label: "Paraphrase" }] : [])],
        rows: p.runs.slice(0, 12) }),
      p.count > 12 ? h("div", { class: "small muted" }, `and ${p.count - 12} more`) : null);
  }

  // ---------------------------------------------------------------- live view
  let liveBuilt = false, liveEls = null;
  function paintLive(light = false) {
    const s = S.status;
    if (!s) return;
    const cols = s.workers.map((w) => workerColumn(w, s));
    if (light && liveEls) { liveEls.cols.replaceChildren(...cols); return; }
    const colsEl = h("div", { class: "rc-workers", style: { gridTemplateColumns: `repeat(${s.workers.length}, minmax(0, 1fr))` } }, ...cols);
    liveEls = { cols: colsEl };
    liveBuilt = true;
    const queue = table({ caption: "Next queued runs", keyboard: false, empty: s.alive ? "The queue is empty." : "No batch is running.",
      columns: [{ key: "run_id", label: "Run", mono: true }, { key: "ticket", label: "Ticket" }, { key: "cell", label: "Cell", render: (r) => cellKeyLabel(r.cell) }],
      rows: s.queue });
    const fin = table({ caption: "Finished runs", keyboard: true, empty: "No finished runs yet.",
      onRowClick: (r) => shell.navigate("runs", { run: r.run_id, ns: shell.ns }),
      columns: [
        { key: "run_id", label: "Run", mono: true },
        { key: "cell", label: "Cell", render: (r) => cellKeyLabel(r.cell) },
        { key: "turns", label: "Turns", num: true },
        { key: "duration_ms", label: "Duration", num: true, render: (r) => r.duration_ms == null ? "—" : fmtDuration(r.duration_ms) },
        { key: "tokens", label: "Tokens", num: true, render: (r) => r.tokens == null ? "—" : fmtInt(r.tokens) },
        { key: "outcome", label: "Outcome", render: (r) => r.status !== "done" ? badge(r.status === "infra_failure_final" ? "Infra failure (final)" : "Infra failure, retrying", "warn")
          : (r.outcome ? badge(r.outcome, "neutral") : h("span", { class: "small muted" }, "Blinded")) },
      ], rows: s.finished });
    live.replaceChildren(
      panel({ title: s.alive ? `Workers · ${s.workers.length}` : "Workers", body: colsEl, actions: h("span", { class: "small muted" }, s.alive ? "Live" : "Idle") }),
      h("div", { class: "rc-lists" },
        panel({ title: "Next in the queue", body: queue, flush: true }),
        panel({ title: "Finished", body: fin, flush: true, actions: h("span", { class: "small muted" }, "Outcomes show only for unblinded stages") })));
  }

  function workerColumn(col, s) {
    const r = col.run;
    if (!r) return h("div", { class: "rc-worker is-idle" }, h("div", { class: "rc-worker-head" }, h("span", { class: "strong" }, `Worker ${col.worker}`), badge("Idle", "neutral")),
      h("p", { class: "small muted" }, s.alive ? "Waiting for the next run" : "No run in progress"));
    return h("div", { class: "rc-worker" },
      h("div", { class: "rc-worker-head" }, h("span", { class: "strong" }, `Worker ${col.worker}`), badge(r.attempt || "gen", "accent")),
      h("dl", { class: "kv" },
        h("dt", {}, "Run"), h("dd", { class: "mono" }, r.run_id),
        h("dt", {}, "Ticket"), h("dd", {}, r.ticket || "—"),
        h("dt", {}, "Cell"), h("dd", {}, cellKeyLabel(r.cell)),
        h("dt", {}, "Attempt"), h("dd", {}, r.attempt || "gen"),
        h("dt", {}, "Elapsed"), h("dd", { class: "num" }, h("span", { "data-since": r.started_at || "" }, fmtElapsed(r.started_at ? (Date.now() - Date.parse(r.started_at)) / 1000 : null))),
        h("dt", {}, "Turns"), h("dd", { class: "num" }, fmtInt(r.turns)),
        h("dt", {}, "Tokens"), h("dd", { class: "num" }, fmtInt(r.tokens))));
  }

  await loadAll();
}
