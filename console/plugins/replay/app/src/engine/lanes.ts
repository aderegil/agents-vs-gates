// The compare lanes' timeline (theater-1016), a pure function of the lanes clock so the video capture on a virtual
// clock and the tests see the same frame: which column the playhead is on, where the change sits in each lane, which
// beat of the closing the lanes are in, and what each lane's change looks like there. No CSS transitions: every
// opacity and position is computed from t. Erasable TypeScript only.

export const COLUMN_MS = 4600;
/** The change takes this long to move from one column to the next. */
export const MOVE_MS = 900;
/** Closing beats after the last column: the rule cells, then the CI column, then everything with the closing line. */
export const RULE_BEAT_MS = 4600;
export const CI_BEAT_MS = 3600;
export const LAST_BEAT_MS = 4800;
export const FINAL_MS = RULE_BEAT_MS + CI_BEAT_MS + LAST_BEAT_MS;
/** In the gate lane the CI cell first shows the failing check, then the repair. */
export const GATE_FAIL_MS = 600;
export const GATE_REPAIR_MS = 2600;

/** "intro": the still table before the change starts (narration only, engine/lanesNarration.ts). */
export type Beat = "intro" | "columns" | "rule" | "ci" | "final";

export function totalMs(columns: number): number {
  return columns * COLUMN_MS + FINAL_MS;
}

export interface LanesFrame {
  beat: Beat;
  /** columns revealed (1..n) */
  shown: number;
  /** the column the playhead is on, or -1 in the closing beats */
  now: number;
  /** ms since the current column started (columns beat) */
  inColumn: number;
  /** the change's position on the axis, in columns (0 = first column centre), eased */
  pos: number;
  /** narration: the gate lane's CI cell set by the moments instead of by GATE_FAIL_MS / GATE_REPAIR_MS */
  gate?: "idle" | "fail" | "pass";
}

const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

export function lanesAt(t: number, columns: number): LanesFrame {
  const end = columns * COLUMN_MS;
  if (t >= end) {
    const f = t - end;
    const beat: Beat = f < RULE_BEAT_MS ? "rule" : f < RULE_BEAT_MS + CI_BEAT_MS ? "ci" : "final";
    return { beat, shown: columns, now: -1, inColumn: 0, pos: columns - 1 };
  }
  const i = Math.max(0, Math.min(columns - 1, Math.floor(t / COLUMN_MS)));
  const inColumn = t - i * COLUMN_MS;
  const pos = i === 0 ? 0 : i - 1 + ease(Math.min(1, inColumn / MOVE_MS));
  return { beat: "columns", shown: i + 1, now: i, inColumn, pos };
}

/** Opacity of a cell: future columns barely there, the current one full, earlier ones stepped back; the closing beats
 * light only what they talk about. */
export function cellOpacity(f: LanesFrame, col: number, opts: { rule: boolean; ci: boolean }): number {
  if (f.beat === "columns") {
    if (col > f.now) return 0.1;
    if (col === f.now) return 1;
    return 0.62;
  }
  if (f.beat === "rule") return opts.rule ? 1 : 0.28;
  if (f.beat === "ci") return opts.ci ? 1 : 0.28;
  return 1;
}

export type TokenState = "moving" | "fail" | "repaired" | "caught" | "escapes" | "neutral";

/**
 * What the change looks like in one lane at this frame. `gate`: the lane with the CI check (fails at CI, then is
 * repaired); otherwise the lane's scripted outcome shows from its outcome column on, unless `neutral` (no per-vendor
 * verdict: the change just travels).
 */
export function tokenState(f: LanesFrame, axis: string[], lane: { gate: boolean; outcomeAxis: string;
  outcome: "caught" | "escapes" }, neutral: boolean): TokenState {
  const ci = axis.indexOf("ci");
  const reached = (col: number) => col >= 0 && f.beat !== "intro" && (f.beat !== "columns" || f.now > col
    || (f.now === col && f.inColumn >= MOVE_MS));
  if (lane.gate) {
    if (!reached(ci)) return "moving";
    if (f.gate) return f.gate === "fail" ? "fail" : f.gate === "pass" ? "repaired" : "moving";
    if (f.beat === "columns" && f.now === ci) {
      if (f.inColumn < MOVE_MS + GATE_FAIL_MS) return "moving";
      if (f.inColumn < MOVE_MS + GATE_REPAIR_MS) return "fail";
    }
    return "repaired";
  }
  if (neutral) return "neutral";
  return reached(axis.indexOf(lane.outcomeAxis)) ? lane.outcome : "moving";
}
