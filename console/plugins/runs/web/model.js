// Pure logic of the Run Explorer (no DOM): unified-diff parsing, side-by-side pairing, transcript pairing, labels.
// Tested by model.test.mjs (node --test).

// ------------------------------------------------------------------ diff

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Unified diff text → [{path, status, hunks: [{header, context, lines: [{type: "ctx"|"add"|"del"|"note", old, new, text}]}], additions, deletions}] */
export function parseDiff(text) {
  const files = [];
  let file = null, hunk = null, o = 0, n = 0;
  const startFile = (path) => { file = { path, status: "modified", hunks: [], additions: 0, deletions: 0, binary: false }; files.push(file); hunk = null; };
  const all = String(text || "").split("\n");
  if (all.length && all[all.length - 1] === "") all.pop();
  for (const raw of all) {
    const line = raw.replace(/\r$/, "");
    if (line === "" && hunk) { hunk.lines.push({ type: "ctx", old: o++, new: n++, text: "" }); continue; }   // a context line whose space was stripped
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      startFile(m ? m[2] : line.slice(11));
      continue;
    }
    if (!file) {
      if (line.startsWith("--- ") || line.startsWith("+++ ")) startFile(line.slice(4).replace(/^[ab]\//, ""));
      else continue;
    }
    if (hunk === null || !(line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\"))) {
      const hm = HUNK.exec(line);
      if (hm) { o = Number(hm[1]); n = Number(hm[3]); hunk = { header: line, context: hm[5] || "", lines: [] }; file.hunks.push(hunk); continue; }
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) file.status = "renamed";
      else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) file.binary = true;
      else if (line.startsWith("+++ ") && file.status === "modified") { const p = line.slice(4); if (p !== "/dev/null") file.path = p.replace(/^b\//, ""); }
      if (hunk === null) continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) { hunk.lines.push({ type: "add", old: null, new: n++, text: line.slice(1) }); file.additions++; }
    else if (line.startsWith("-")) { hunk.lines.push({ type: "del", old: o++, new: null, text: line.slice(1) }); file.deletions++; }
    else if (line.startsWith("\\")) hunk.lines.push({ type: "note", old: null, new: null, text: line });
    else if (line.startsWith(" ")) hunk.lines.push({ type: "ctx", old: o++, new: n++, text: line.slice(1) });
  }
  return files;
}

export function diffStats(files) {
  return files.reduce((a, f) => ({ files: a.files + 1, additions: a.additions + f.additions, deletions: a.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 });
}

/** A hunk's lines → rows for the two-column view: [{left, right}] where each side is a line or null. */
export function sideBySide(hunk) {
  const rows = [];
  const lines = hunk.lines;
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (l.type === "ctx") { rows.push({ left: l, right: l }); i++; continue; }
    if (l.type === "note") { rows.push({ left: l, right: null, note: true }); i++; continue; }
    const dels = [], adds = [];
    while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
    if (!dels.length && !adds.length) { i++; continue; }
    const k = Math.max(dels.length, adds.length);
    for (let j = 0; j < k; j++) rows.push({ left: dels[j] || null, right: adds[j] || null });
  }
  return rows;
}

// ------------------------------------------------------------------ CI

/** "ARCH-4 FAIL billing-service…" → [{text, arch}] so the renderer can bold each ARCH-n. */
export function splitArch(text) {
  const out = [];
  let last = 0;
  const re = /ARCH-\d+/g;
  let m;
  const s = String(text ?? "");
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), arch: false });
    out.push({ text: m[0], arch: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), arch: false });
  return out;
}

export const isArch = (id) => /^ARCH-\d+$/.test(String(id || ""));

// ------------------------------------------------------------------ transcript

/** One-line summary of a tool call's input. */
export function inputSummary(name, input) {
  const i = input && typeof input === "object" ? input : {};
  const pick = i.file_path || i.path || i.command || i.pattern || i.query || i.description;
  if (pick) return String(pick).split("\n")[0].slice(0, 120);
  const j = JSON.stringify(input ?? {});
  return j.length > 120 ? j.slice(0, 117) + "…" : j;
}

/** AgentEvents → [{session, items: [{type: "text"|"tool"|"result"|"final", …}]}] with each tool_result attached to its call. */
export function groupTranscript(events) {
  const groups = [];
  const calls = new Map();
  let cur = null;
  for (const ev of events || []) {
    const session = ev.session || "gen";
    if (!cur || cur.session !== session) { cur = { session, items: [] }; groups.push(cur); }
    if (ev.kind === "text") cur.items.push({ type: "text", ts: ev.ts, text: ev.text });
    else if (ev.kind === "tool_call") {
      const it = { type: "tool", ts: ev.ts, id: ev.id, name: ev.name, input: ev.input, summary: inputSummary(ev.name, ev.input), result: null };
      calls.set(`${session}:${ev.id}`, it);
      cur.items.push(it);
    } else if (ev.kind === "tool_result") {
      const call = calls.get(`${session}:${ev.id}`) || calls.get([...calls.keys()].reverse().find((k) => k.endsWith(`:${ev.id}`)));
      if (call) call.result = { status: ev.status, output: ev.output, ts: ev.ts };
      else cur.items.push({ type: "result", ts: ev.ts, id: ev.id, status: ev.status, output: ev.output });
    } else if (ev.kind === "final") cur.items.push({ type: "final", ts: ev.ts, text: ev.text, subtype: ev.subtype, is_error: ev.is_error, turns: ev.num_turns, duration_ms: ev.duration_ms, usage: ev.usage });
    else cur.items.push({ type: "text", ts: ev.ts, text: JSON.stringify(ev) });
  }
  return groups;
}

// ------------------------------------------------------------------ labels and tones

const OUTCOME_TONE = {
  passed_first_ci: "pass", fixed_code: "pass", passed_with_gate_flag: "warn", fixed_with_gate_flag: "warn",
  still_failing: "fail", capped: "warn", no_change: "neutral", honest_escalation_candidate: "neutral", infra_failure: "warn",
};
export const outcomeTone = (o) => OUTCOME_TONE[o] || "neutral";
export const ticketDoneTone = (t) => ({ done: "pass", not_done: "fail" }[t] || "neutral");
export const statusTone = (s) => ({ done: "neutral", running: "accent", infra_failure: "warn", infra_failure_final: "warn" }[s] || "neutral");

/** Row of the table → compact flag chips: [{text, tone, title}] */
export function flagChips(row) {
  const out = [];
  if (row.contaminated) out.push({ text: "contaminated", tone: "fail", title: "A canary string appeared in the run" });
  if (row.token_exposed) out.push({ text: "token exposed", tone: "fail", title: "The OAuth token was visible to the agent" });
  if (row.detectors) out.push({ text: `${row.detectors} detector${row.detectors === 1 ? "" : "s"}`, tone: "warn", title: "Gate-manipulation detectors fired" });
  if (row.infra) out.push({ text: `infra: ${row.infra}`, tone: "warn", title: "Infrastructure failure, not an agent result" });
  return out;
}

export function conditionLabel(r) {
  return `${r.ticket} ${r.visibility}·${r.spec}·${r.wording}`;
}

/** Filter state → query object for GET /api/runs (empty values dropped). */
export function filtersToQuery(f) {
  const q = {};
  for (const k of ["stage", "ticket", "V", "S", "W", "unit", "status", "q"]) if (f[k]) q[k] = f[k];
  return q;
}

/** Client-side fallback filter with the same semantics as the API (used while typing in the search box). */
export function applyFilters(rows, f) {
  const text = (f.q || "").trim().toLowerCase();
  return rows.filter((r) =>
    (!f.stage || r.stage === f.stage) && (!f.ticket || r.ticket === f.ticket) && (!f.V || r.visibility === f.V) &&
    (!f.S || r.spec === f.S) && (!f.W || r.wording === f.W) && (!f.unit || r.unit === f.unit) && (!f.status || r.status === f.status) &&
    (!text || r.run_id.toLowerCase().includes(text) || String(r.cell || "").toLowerCase().includes(text)));
}

export const fmtBytes = (n) => (n == null ? "—" : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`);
