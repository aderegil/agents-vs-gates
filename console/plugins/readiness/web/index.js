// Readiness (spec §22.8): health, smoke test, pre-registration, units.json, token, review checklist.
// Owner acts; operator sees everything read-only (shell.canWrite === false).
import { h, table, tabs, badge, facts, panel, empty, notice, button, fmtDate, fmtAgo, iconEl } from "/web/lib/ui.js";

let alive = false;
let poll = null;

const TABS = [
  { id: "health", label: "Health", icon: "activity" },
  { id: "smoke", label: "Smoke test", icon: "terminal" },
  { id: "prereg", label: "Pre-registration", icon: "lock" },
  { id: "units", label: "Units", icon: "sliders-horizontal" },
  { id: "token", label: "Token", icon: "key-round" },
  { id: "checklist", label: "Review checklist", icon: "list-checks" },
];

export function mount(el, shell) {
  alive = true;
  const isOwner = shell.user.role === "owner" && shell.canWrite;
  shell.setHeader({
    title: "Readiness",
    subtitle: isOwner ? "What must be true before real runs" : "What must be true before real runs · read-only for your role",
  });
  const ctx = { shell, isOwner };
  const t = tabs({
    items: TABS.map((x) => ({ ...x, render: () => section(x.id, ctx) })),
    active: shell.params.tab || "health",
    onChange: (id) => history.replaceState(null, "", `#/readiness?tab=${id}`),
  });
  el.replaceChildren(t);
}

export function unmount() {
  alive = false;
  clearTimeout(poll);
}

// Renders a section into a container that reloads itself.
function section(id, ctx) {
  const box = h("div", { class: "stack" }, h("p", { class: "loading" }, "Loading…"));
  const reload = async (opts) => {
    clearTimeout(poll);
    try {
      const nodes = await SECTIONS[id](ctx, reload, opts);
      if (alive && box.isConnected !== false) box.replaceChildren(...[nodes].flat().filter(Boolean));
    } catch (e) {
      if (alive) box.replaceChildren(notice(e.error || String(e), "fail", "circle-alert"));
    }
  };
  reload();
  return box;
}

const md = (text) => String(text).split(/(`[^`]+`)/g).map((p) => p.startsWith("`") && p.endsWith("`") && p.length > 1 ? h("code", {}, p.slice(1, -1)) : p);
const unavailable = (what) => notice(`${what} is not available yet. It is being built in another package; this section fills in once it exists.`, "", "info");

const SECTIONS = {
  async health({ shell }, reload, opts = {}) {
    const d = await shell.api.get("readiness/doctor", { query: opts.refresh ? { refresh: 1 } : {} });
    if (!d.available) return unavailable("harness.doctor");
    const recheck = button({ label: opts.refresh ? "Checking…" : "Re-check", icon: "refresh-cw", small: true,
      onClick: async () => { await reload({ refresh: true }); shell.toast("Environment re-checked", "ok"); } });
    if (!d.result) return [panel({ title: "Environment (harness.doctor)", actions: recheck, body: notice(`The doctor did not return JSON: ${d.error || "unknown error"}`, "fail", "circle-alert") })];
    const checks = d.result.checks || [];
    const failing = checks.filter((c) => c.required && !c.ok).length;
    const warn = checks.filter((c) => !c.required && !c.ok).length;
    const summary = h("div", { class: "row" },
      failing ? badge(`${failing} required check${failing > 1 ? "s" : ""} failing`, "fail") : badge("All required checks pass", "pass"),
      warn ? badge(`${warn} warning${warn > 1 ? "s" : ""}`, "warn") : null,
      h("span", { class: "small muted" }, `Checked ${fmtAgo(d.at)}`));
    const tbl = table({
      columns: [
        { key: "ok", label: "Result", width: "96px", render: (c) => c.ok ? badge("OK", "pass") : badge(c.required ? "Fail" : "Warn", c.required ? "fail" : "warn") },
        { key: "name", label: "Check", render: (c) => h("span", { class: "strong" }, c.name) },
        { key: "detail", label: "Detail", render: (c) => h("span", { class: "mono small" }, c.detail) },
        { key: "required", label: "Required", render: (c) => c.required ? "yes" : h("span", { class: "muted" }, "no") },
      ],
      rows: checks, keyboard: false,
    });
    const leak = d.result.leaky_config || {};
    const leakRows = [
      ["Managed settings files", (leak.managed_settings || []).length ? leak.managed_settings.join(", ") : "none"],
      ["User ~/.claude items", Object.entries(leak.user_claude_dir || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"],
      ["User settings keys", (leak.user_settings_keys || []).join(", ") || "none"],
      ["User hooks", (leak.user_hooks || []).join(", ") || "none"],
    ];
    return [
      panel({ title: h("div", { class: "row" }, h("h2", {}, "Environment"), summary), actions: recheck, body: tbl, flush: true }),
      panel({ title: "User configuration that runs must not inherit", body: h("dl", { class: "kv" }, leakRows.map(([k, v]) => [h("dt", {}, k), h("dd", { class: "mono small" }, v)])) }),
    ];
  },

  async smoke({ shell, isOwner }, reload) {
    const d = await shell.api.get("readiness/smoke");
    const tone = { passed: "pass", failed: "fail", not_run: "neutral" }[d.status];
    const label = { passed: "Passed", failed: "Failed", not_run: "Not run" }[d.status];
    const running = d.run && d.run.running;
    if (running) poll = setTimeout(reload, 5000);
    let reason = null;
    if (!isOwner) reason = "Only the owner can run the smoke test";
    else if (!d.available) reason = "harness.smoke is not available yet";
    else if (running) reason = "Already running";
    const runBtn = button({ label: "Run smoke test", icon: "play", primary: true, disabled: !!reason, reason, showReason: true,
      onClick: async () => {
        const ok = await shell.confirm({ title: "Run the live smoke test?", confirmLabel: "Run smoke test", requireText: d.confirm_text,
          message: h("div", { class: "stack-sm" },
            h("p", {}, "This makes up to 5 real model calls with the Max-plan token. It is the only step that calls a model before the experiment."),
            h("ol", { style: { margin: 0, paddingLeft: "18px" } }, d.calls.map((c) => h("li", {}, md(c.prompt)))),
            h("p", { class: "small muted" }, "The action is recorded in the audit log.")) });
        if (!ok) return;
        try {
          await shell.api.post("readiness/smoke", { confirm: d.confirm_text });
          shell.toast("Smoke test started", "ok");
          reload();
        } catch (e) { shell.toast(e.error || "Could not start the smoke test", "error"); }
      } });
    const checks = d.result && Array.isArray(d.result.checks) ? d.result.checks : null;
    const result = d.result ? h("div", { class: "stack-sm" },
      h("p", { class: "small muted" }, `Last run ${fmtDate(d.result.at)} · results/smoke.json`),
      checks ? table({ columns: [
        { key: "call", label: "Call", num: true, width: "56px" },
        { key: "name", label: "Check", render: (c) => h("span", { class: "strong" }, c.name) },
        { key: "ok", label: "Result", width: "90px", render: (c) => c.ok ? badge("OK", "pass") : badge("Fail", "fail") },
        { key: "detail", label: "Detail", render: (c) => h("span", { class: "mono small" }, c.detail) },
      ], rows: checks, keyboard: false }) : h("pre", { class: "block small" }, JSON.stringify(d.result, null, 2))) : null;
    return [
      panel({ title: h("div", { class: "row" }, h("h2", {}, "Smoke test"), badge(label, tone),
        running ? badge(`Running since ${fmtDate(d.run.at)}`, "accent") : null),
      body: h("div", { class: "stack" }, h("p", { class: "muted" }, d.note), runBtn, result) }),
      panel({ title: "The five calls (§10.8)", flush: true, body: table({
        columns: [
          { key: "n", label: "#", num: true, width: "40px" },
          { key: "prompt", label: "Call", render: (c) => h("span", {}, md(c.prompt)) },
          { key: "checks", label: "Verifies", render: (c) => h("span", { class: "muted" }, c.checks) },
        ], rows: d.calls, keyboard: false }) }),
    ];
  },

  async prereg({ shell, isOwner }, reload) {
    const d = await shell.api.get("readiness/lock");
    const running = d.freeze_run && d.freeze_run.running;
    if (running) poll = setTimeout(reload, 5000);
    let blockers = [...d.freeze_blockers];
    if (!isOwner) blockers.unshift("Only the owner can freeze");
    const freezeBtn = button({ label: "Freeze pre-registration", icon: "lock", primary: true, disabled: blockers.length > 0,
      reason: blockers.join(" · "),
      onClick: async () => {
        const ok = await shell.confirm({ title: "Freeze the pre-registration?", confirmLabel: "Freeze", requireText: d.confirm_text,
          message: h("div", { class: "stack-sm" },
            h("p", {}, "This writes PREREGISTRATION.lock with the SHA-256 of every frozen file and commits it (python -m harness.prereg --freeze). From then on units.json and the frozen texts cannot change, and real runs from P1 on require the lock."),
            d.checklist.exists && d.checklist.done < d.checklist.total
              ? notice(`The review checklist has ${d.checklist.total - d.checklist.done} unchecked item(s).`, "warn", "triangle-alert") : null) });
        if (!ok) return;
        try {
          await shell.api.post("readiness/freeze", { confirm: d.confirm_text });
          shell.toast("Freeze started", "ok");
          reload();
        } catch (e) { shell.toast(e.error || "Could not freeze", "error"); }
      } });
    const factsEl = facts([
      { label: "Lock", value: d.frozen ? badge("Frozen", "accent") : badge("Not frozen", "neutral"),
        sub: d.frozen ? fmtDate(d.frozen_at) : "PREREGISTRATION.lock absent" },
      { label: "Lock hash", value: d.frozen ? h("span", { class: "mono" }, d.short_hash) : "—", sub: "sha256 of the lock file, short" },
      { label: "PREREGISTRATION.md", value: d.prereg_md ? "Present" : "Missing" },
      { label: "P0 calibration", value: d.p0_complete ? badge("Complete", "pass") : badge("Not complete", "neutral"), sub: "real namespace" },
      { label: "Review checklist", value: d.checklist.exists ? `${d.checklist.done} of ${d.checklist.total}` : "No file yet" },
      { label: "Changed since freeze", value: d.frozen ? String(d.changed.length) : "—",
        sub: d.frozen ? (d.changed.length ? "files differ from the lock" : "every file matches") : null },
    ]);
    const nodes = [panel({ title: "Pre-registration", body: factsEl, flush: true })];
    if (d.parse_error) nodes.push(notice(d.parse_error, "warn", "triangle-alert"));
    if (d.frozen) {
      nodes.push(panel({ title: `Frozen files (${d.files.length})`, flush: true, body: table({
        columns: [
          { key: "status", label: "Status", width: "100px", render: (f) => badge({ same: "Same", changed: "Changed", missing: "Missing" }[f.status], f.status === "same" ? "pass" : "fail") },
          { key: "path", label: "File", render: (f) => h("span", { class: "mono" }, f.path) },
          { key: "sha256", label: "Locked sha256", render: (f) => h("span", { class: "mono small" }, (f.sha256 || "").slice(0, 16)) },
          { key: "current_sha256", label: "Current sha256", render: (f) => h("span", { class: "mono small" }, (f.current_sha256 || "—").slice(0, 16)) },
        ], rows: d.files, keyboard: false, empty: "The lock lists no files." }) }));
      if (d.verify) {
        nodes.push(panel({ title: "harness.prereg --verify", body: d.verify.result
          ? h("pre", { class: "block small" }, JSON.stringify(d.verify.result, null, 2))
          : notice(`Verification did not return JSON: ${d.verify.error}`, "warn", "triangle-alert") }));
      }
    } else {
      nodes.push(panel({ title: "Freeze", body: h("div", { class: "stack" },
        h("p", { class: "muted" }, "Order (§11.4): P0 calibration → fix units.json → review checklist → freeze → P1. The freeze is a step for the owner; the console only launches python -m harness.prereg --freeze after a typed confirmation."),
        freezeBtn,
        blockers.length ? h("ul", { class: "small muted", style: { margin: 0, paddingLeft: "18px" } }, blockers.map((b) => h("li", {}, b))) : null,
        running ? badge(`Freeze running since ${fmtDate(d.freeze_run.at)}`, "accent") : null) }));
    }
    return nodes;
  },

  async units({ shell }, reload) {
    const d = await shell.api.get("readiness/units");
    if (!d.available) return unavailable("harness/units.json");
    const edits = {};
    const rows = Object.entries(d.units).map(([name, u]) => ({ name, ...u }));
    const save = button({ label: "Save units", icon: "save", primary: true, disabled: !d.editable,
      reason: d.locked ? d.locked_reason : "Only the owner can edit units", onClick: async () => {
        const changes = {};
        for (const [name, e] of Object.entries(edits)) changes[name] = e;
        if (!Object.keys(changes).length) { shell.toast("Nothing changed", "info"); return; }
        try {
          const r = await shell.api.post("readiness/units", { units: changes });
          shell.toast(Object.keys(r.changed).length ? `Saved: ${Object.keys(r.changed).join(", ")}` : "Nothing changed", "ok");
          reload();
        } catch (e) { shell.toast(e.error || "Could not save", "error"); }
      } });
    const editable = (r) => d.editable && r.adapter !== "mock";
    const tbl = table({
      columns: [
        { key: "name", label: "Unit", render: (r) => h("span", { class: "strong mono" }, r.name) },
        { key: "adapter", label: "Adapter", render: (r) => h("span", { class: "mono" }, r.adapter) },
        { key: "model", label: "Model id", width: "34%", render: (r) => r.adapter === "mock" ? h("span", { class: "muted" }, "—") :
          h("input", { class: "input input-sm mono", value: r.model ?? "", disabled: !editable(r), "aria-label": `Model id for ${r.name}`, placeholder: "CLI default",
            oninput: (e) => { (edits[r.name] ||= {}).model = e.target.value.trim() || null; } }) },
        { key: "effort", label: "Effort", width: "18%", render: (r) => r.adapter === "mock" ? h("span", { class: "muted" }, "—") :
          h("select", { class: "select select-sm", disabled: !editable(r), "aria-label": `Effort for ${r.name}`,
            onchange: (e) => { (edits[r.name] ||= {}).effort = e.target.value || null; } },
          d.efforts.map((x) => h("option", { value: x ?? "", selected: (r.effort ?? null) === x }, x ?? "CLI default"))) },
      ], rows, keyboard: false });
    return [
      d.locked ? notice(`${d.locked_reason}. units.json is part of the frozen set.`, "", "lock") : null,
      panel({ title: "harness/units.json", actions: save, body: tbl, flush: true }),
      h("p", { class: "small muted" }, "The full model id and effort are fixed after P0 calibration and then frozen (§11.4). Every change is recorded in the audit log."),
    ].filter(Boolean);
  },

  async token({ shell }) {
    const d = await shell.api.get("readiness/token");
    return [
      panel({ title: "Claude Code OAuth token", flush: true, body: facts([
        { label: "File", value: h("span", { class: "mono" }, d.env_path), sub: d.exists ? "exists" : "does not exist" },
        { label: "CLAUDE_CODE_OAUTH_TOKEN", value: d.has_token ? badge("Present", "pass") : badge("Missing", "neutral"),
          sub: "the value is never read into the console" },
        { label: "Needed for", value: "Real runs and the smoke test", sub: "mock runs need no token" },
      ]) }),
      panel({ title: "How to create it", body: h("ol", { class: "stack-sm", style: { margin: 0, paddingLeft: "18px" } }, d.instructions.map((s) => h("li", {}, md(s.replace("claude setup-token", "`claude setup-token`"))))) }),
    ];
  },

  async checklist({ shell }, reload) {
    const d = await shell.api.get("readiness/checklist");
    if (!d.exists) return [panel({ title: "Review checklist", body: empty("docs/REVIEW-CHECKLIST.md does not exist yet. It is written with the pre-registration (§15) and appears here as an interactive list.") })];
    const groups = [];
    for (const it of d.items) {
      let g = groups.find((x) => x.section === it.section);
      if (!g) groups.push((g = { section: it.section, items: [] }));
      g.items.push(it);
    }
    const toggle = async (it, checked) => {
      try {
        await shell.api.post("readiness/checklist", { id: it.id, checked });
        reload();
      } catch (e) { shell.toast(e.error || "Could not save", "error"); reload(); }
    };
    const head = h("div", { class: "row" }, h("h2", {}, "Review checklist"),
      badge(`${d.done} of ${d.total} checked`, d.done === d.total && d.total ? "pass" : "neutral"),
      h("span", { class: "small muted" }, d.path));
    return [panel({ title: head, flush: true, body: h("div", {}, groups.map((g) => h("div", {},
      g.section ? h("h3", { style: { padding: "10px 16px 6px", background: "var(--suave)", borderBottom: "1px solid var(--linea)" } }, g.section) : null,
      h("ul", { style: { listStyle: "none", margin: 0, padding: 0 } }, g.items.map((it) =>
        h("li", { style: { display: "flex", gap: "12px", alignItems: "flex-start", padding: "8px 16px", borderBottom: "1px solid var(--linea)" } },
          h("input", { type: "checkbox", checked: it.checked, disabled: !d.editable, id: `chk-${it.id}`, style: { marginTop: "3px", accentColor: "var(--acento)" },
            "aria-describedby": `chk-meta-${it.id}`, onchange: (e) => toggle(it, e.target.checked) }),
          h("label", { for: `chk-${it.id}`, style: { flex: 1 } }, md(it.text)),
          h("span", { class: "small muted nowrap", id: `chk-meta-${it.id}` }, it.by ? `${it.by}${it.at ? ` · ${fmtDate(it.at)}` : ""}` : ""))))))) })];
  },
};
