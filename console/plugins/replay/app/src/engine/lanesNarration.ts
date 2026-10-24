// The lanes view with ?narration=1 (2026-10-24, coordinator's order, Alfredo approved): the narration is data
// (public/narration/lanes-neutral.json) and it sets the clock. Each moment is {focus, text}; a sentence stays at
// least max(2.5 s, words / 2 + 0.8 s), one at a time with 0.4 s of empty band between two. A moment's focus (the lit
// column, the camera) starts with its sentence; its event (the change reaching the column, CI turning red or green)
// happens when the sentence before it ends, never earlier. A pure function of t, like engine/lanes.ts, so a
// virtual-clock capture and the tests see the same frame. Erasable TypeScript only.
import { MOVE_MS, type LanesFrame } from "./lanes.ts";

export interface NarrationMoment {
  n: number;
  text: string;
  focus: "table" | "column" | "gate-ci" | "rule" | "ci";
  col?: string;
  /** a second column the change moves on to halfway through the sentence */
  then?: string;
  gate?: "fail" | "pass";
  minMs?: number;
}
export interface Narration { moments: NarrationMoment[] }

/** The full table, empty band: the poster frame. */
export const POSTER_MS = 600;
export const GAP_MS = 400;
export const TAIL_MS = 1200;
export const CAM_MS = 1200;
export const FADE_MS = 200;
/** Camera zoom on a column (4–6 columns and all five rows in view), and on the gate lane's CI cell. */
export const COLUMN_ZOOM = 1.25;   // lanes.css sizes the grid to the view at this zoom
export const CELL_ZOOM = 1.5;
/** The model column's share of the grid width (lanes.css --mw) and the gate row's height in the grid (last row). */
const MODEL_W = 0.125;
const GATE_ROW_Y = 0.9;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
export const phraseMs = (s: string, minMs = 0) => Math.max(2500, (words(s) / 2) * 1000 + 800, minMs);

export interface Cue { n: number; text: string; start: number; end: number; moment: NarrationMoment }
export interface Timeline { cues: Cue[]; total: number }

export function timeline(nar: Narration): Timeline {
  const cues: Cue[] = [];
  let t = POSTER_MS;
  for (const m of nar.moments) {
    const d = phraseMs(m.text, m.minMs);
    cues.push({ n: m.n, text: m.text, start: t, end: t + d, moment: m });
    t += d + GAP_MS;
  }
  return { cues, total: t - GAP_MS + TAIL_MS };
}

export interface Camera { s: number; cx: number; cy: number }
export interface NarratedFrame {
  frame: LanesFrame;
  camera: Camera;
  caption: { text: string; opacity: number };
  /** the moment on screen (0 before the first sentence) */
  n: number;
}

const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const WIDE: Camera = { s: 1, cx: 0.5, cy: 0.5 };
const colX = (i: number, n: number) => MODEL_W + (1 - MODEL_W) * (i + 0.5) / n;

/** The column a moment shows at time t (its `then` column from halfway), or -1. */
function columnAt(c: Cue | undefined, t: number, axis: string[]): number {
  if (!c) return -1;
  const m = c.moment;
  if (m.focus === "gate-ci") return axis.indexOf("ci");
  if (m.focus !== "column" || !m.col) return -1;
  if (m.then && t >= (c.start + c.end) / 2) return axis.indexOf(m.then);
  return axis.indexOf(m.col);
}
/** When the column shown at t became the current one. */
function columnSince(c: Cue, t: number): number {
  return c.moment.then && t >= (c.start + c.end) / 2 ? (c.start + c.end) / 2 : c.start;
}

function cameraFor(c: Cue | undefined, t: number, axis: string[]): Camera {
  if (!c) return WIDE;
  const m = c.moment;
  if (m.focus === "gate-ci") return { s: CELL_ZOOM, cx: colX(axis.indexOf("ci"), axis.length), cy: GATE_ROW_Y };
  if (m.focus === "column") return { s: COLUMN_ZOOM, cx: colX(columnAt(c, t, axis), axis.length), cy: 0.5 };
  return WIDE;
}

export function narratedAt(t: number, tl: Timeline, axis: string[]): NarratedFrame {
  let k = -1;
  tl.cues.forEach((c, i) => { if (t >= c.start) k = i; });
  const cur = k >= 0 ? tl.cues[k] : undefined;
  const prev = k >= 1 ? tl.cues[k - 1] : undefined;
  const n = axis.length;

  // the change on the axis: it moves into the current column over MOVE_MS
  let lastCol = 0;
  for (let i = 0; i < k; i++) {
    const c = columnAt(tl.cues[i], tl.cues[i].end, axis);
    if (c >= 0) lastCol = c;
  }
  const col = columnAt(cur, t, axis);
  let frame: LanesFrame;
  const focus = cur?.moment.focus ?? "table";
  if (!cur || focus === "table") {
    frame = { beat: "intro", shown: 0, now: -1, inColumn: 0, pos: 0 };
  } else if (focus === "rule" || focus === "ci") {
    frame = { beat: focus, shown: n, now: -1, inColumn: 0, pos: n - 1 };
  } else {
    const since = columnSince(cur, t);
    // within a `then` moment the change starts from the moment's first column
    const from = cur.moment.then && since > cur.start ? axis.indexOf(cur.moment.col ?? "") : lastCol;
    const p = col === from ? 1 : ease(clamp01((t - since) / MOVE_MS));
    // on the red and green moments the change is already at CI (it arrived with the sentence before)
    const settled = focus === "gate-ci" ? MOVE_MS : 0;
    frame = { beat: "columns", shown: col + 1, now: col, inColumn: t - since + settled, pos: from + (col - from) * p };
  }
  // the gate lane's CI: idle until its red moment, red during it, green from the repair on
  const failAt = tl.cues.findIndex((c) => c.moment.gate === "fail");
  const passAt = tl.cues.findIndex((c) => c.moment.gate === "pass");
  frame.gate = k < 0 || failAt < 0 || k < failAt ? "idle" : passAt >= 0 && k >= passAt ? "pass" : "fail";

  // the camera eases from the previous moment's shot to this one's when the sentence (or its `then` half) starts
  let camera = cameraFor(cur, t, axis);
  if (cur) {
    const since = columnSince(cur, t);
    const before = since > cur.start ? cameraFor(cur, cur.start, axis) : cameraFor(prev, prev ? prev.end : 0, axis);
    const p = ease(clamp01((t - since) / CAM_MS));
    camera = { s: before.s + (camera.s - before.s) * p, cx: before.cx + (camera.cx - before.cx) * p,
      cy: before.cy + (camera.cy - before.cy) * p };
  }

  const on = cur && t < cur.end ? cur : undefined;
  const caption = on
    ? { text: on.text, opacity: Math.min(1, (t - on.start) / FADE_MS, (on.end - t) / FADE_MS) }
    : { text: "", opacity: 0 };
  return { frame, camera, caption, n: cur?.n ?? 0 };
}

/** Cell opacity with narration: what is past stays readable, the future is faint, the summary keeps the rest at 0.5. */
export function narratedOpacity(f: LanesFrame, col: number, opts: { rule: boolean; ci: boolean }): number {
  if (f.beat === "intro") return 0.9;
  if (f.beat === "columns") return col > f.now ? 0.25 : col === f.now ? 1 : 0.85;
  if (f.beat === "rule") return opts.rule ? 1 : 0.5;
  if (f.beat === "ci") return opts.ci ? 1 : 0.5;
  return 1;
}

/** The grid's transform for a camera, inside a view of W×H showing a grid of w×h (origin top-left, no gaps shown). */
export function cameraTransform(c: Camera, view: { W: number; H: number }, grid: { w: number; h: number }) {
  const axisFit = (V: number, g: number, center: number) => {
    const size = c.s * g;
    if (size <= V) return (V - size) / 2;
    return Math.min(0, Math.max(V - size, V / 2 - c.s * center * g));
  };
  return { tx: axisFit(view.W, grid.w, c.cx), ty: axisFit(view.H, grid.h, c.cy), s: c.s };
}
