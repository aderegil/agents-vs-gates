// Pure logic of Run Control (no DOM): formatting, labels, request bodies, button reasons. Tested by model.test.mjs.

export const STAGE_ORDER = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"];

/** 3725 → "1:02:05"; 125 → "2:05"; null → "—" */
export function fmtElapsed(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return "—";
  const s = Math.max(0, Math.floor(Number(sec)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), rr = String(r).padStart(2, "0");
  return h ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

/** 1234567 → "1.23M"; 52300 → "52.3k"; 800 → "800" (tabular figures; raw counts stay exact in titles) */
export function fmtCompact(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

export function cellLabel(c) {
  const cond = `${c.visibility}·${c.spec}·${c.wording}`;
  return `${c.ticket} ${cond}${c.control ? " control" : ""}`;
}

/** Splits "X-rename|V0|S0|W1|mock" into a readable "X-rename V0·S0·W1 mock". */
export function cellKeyLabel(cell) {
  if (!cell) return "—";
  const [t, v, s, w, u] = String(cell).split("|");
  return v ? `${t} ${v}·${s}·${w}${u ? ` ${u}` : ""}` : String(cell);
}

/** [text, tone] pairs for the status badges of a stage card. */
export function stageBadges(card) {
  const out = [];
  const st = card.status;
  if (st === "running") out.push(["Running", "accent"]);
  else if (st === "complete") out.push(["Complete", "neutral"]);
  else if (st === "in_progress") out.push(["In progress", "neutral"]);
  else if (st === "pending") out.push(["Pending", "neutral"]);
  else out.push(["Not in manifest", "neutral"]);
  if (card.in_manifest) {
    if (card.blinding === "visible") out.push(["Always visible", "neutral"]);
    else if (card.blinding === "blinded") out.push(["Blinded", "neutral"]);
    else if (card.blinding === "unblinded") out.push(["Unblinded", "accent"]);
    else if (card.blinding === "unblinded_forced") out.push(["Unblinded (forced)", "warn"]);
  }
  return out;
}

/** Outcome counts as [["fixed_code", 3], …] sorted by count desc then name. */
export function outcomeEntries(outcomes) {
  return Object.entries(outcomes || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/** The JSON body of dry-run / start for the launch form. */
export function launchBody(form, { calibrate = false } = {}) {
  const body = { workers: Number(form.workers) || 1 };
  if (calibrate) return { ...body, calibrate: true };
  body.stage = form.stage;
  const n = Number(form.amount);
  if (form.mode === "minutes") body.max_minutes = n;
  else body.batch = n;
  if (form.unit) body.unit = form.unit;
  return body;
}

export function validAmount(form) {
  const n = Number(form.amount);
  if (!Number.isFinite(n) || n <= 0) return false;
  return form.mode === "minutes" ? n <= 1440 : Number.isInteger(n) && n <= 1000;
}

/** Why an action is unavailable, or null. action: "batch" | "calibrate" | "stop" | "dry". */
export function reasonFor(action, { alive, canWrite = true, guardReasons = [], stageRunnable = true, amountOk = true }) {
  if (!canWrite) return "Your role cannot launch runs";
  if (action === "stop") return alive ? null : "No runner is running";
  if (action === "dry") {
    if (!stageRunnable) return "This stage is not run as a batch";
    return amountOk ? null : "Enter a number of runs or minutes";
  }
  if (alive) return "A runner is already running";
  if (!stageRunnable) return "This stage is not run as a batch";
  if (guardReasons.length) return guardReasons[0];
  if (action === "batch" && !amountOk) return "Enter a number of runs or minutes";
  return null;
}

/** A signature that changes when the launch panel must be rebuilt (not on every tick). */
export function launchSignature({ alive, ns, units, guards }) {
  return JSON.stringify([alive, ns, units, guards]);
}

/** Local HH:MM of an ISO timestamp (the "Resume at HH:MM" label). */
export function hhmm(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
