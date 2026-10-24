// The lanes view with ?narration=1 (2026-10-24, coordinator's orders, rounds 1 and 2, Alfredo approved): the
// narration is data (public/narration/lanes-neutral.json) and it sets the clock. Each moment is {focus, text, type}:
//   A (anticipates): the camera is on the moment's column before the sentence; its event (the change moving into the
//     column) starts when the sentence ends, then at least 2 s with an empty band;
//   D (describes): its subject (the red CI cell, the green one, the summary's lit cells) is on screen, still, at
//     least 0.55 s before the sentence.
// A sentence stays max(3 s, words / 1.8 + 1.0 s), one at a time. timeline() lays the moments out once (sentences,
// camera moves, the change's moves, the gate's red and green); narratedAt(t) is a pure function of t over that
// layout, like engine/lanes.ts, so a virtual-clock capture and the tests see the same frame. Erasable TypeScript.
import type { LanesFrame } from "./lanes.ts";

export interface NarrationMoment {
  n: number;
  text: string;
  type: "A" | "D";
  focus: "table" | "column" | "gate-ci" | "rule" | "ci";
  col?: string;
  /** a second column the change moves on to right after the first (one sentence, two moves) */
  then?: string;
  gate?: "fail" | "pass";
}
export interface Narration { moments: NarrationMoment[]; subtitle?: string }

export const GAP_MS = 400;
export const WATCH_MS = 2000;
export const SHOWN_MS = 550;
export const LEAD_MS = 600;          // the first sentence after the poster frame (the table is on screen from 0)
export const CAM_MS = 1700;
export const SETTLE_MS = 300;       // the camera stands still this long before its sentence
export const MOVE_MS = 1600;         // the change from one column to the next
export const FADE_MS = 600;          // the gate's red and green fade in
export const BAND_FADE_MS = 200;
export const END_HOLD_MS = 3000;     // the closing table, still, empty band
/** Camera zoom on a column (all five rows in view: lanes.css lays the grid out as tall as the view at this zoom),
 * and on the gate lane's CI cell. */
export const COLUMN_ZOOM = 1.25;
export const CELL_ZOOM = 1.5;
/** The model column's share of the grid width (lanes.css --mw) and the gate row's height in the grid (last row). */
export const MODEL_W = 0.125;
const GATE_ROW_Y = 0.9;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
export const phraseMs = (s: string) => Math.max(3000, (words(s) / 1.8) * 1000 + 1000);

export interface Camera { s: number; cx: number; cy: number }
export type SummaryBeat = "intro" | "columns" | "rule" | "ci" | "final";
export interface Cue { n: number; type: "A" | "D"; text: string; start: number; end: number;
  /** A: when its event starts; D: since when its subject is on screen */
  action: number; moment: NarrationMoment }
interface Key<T> { t: number; v: T }
interface Move { t0: number; t1: number; from: number; to: number }
interface CamMove { t0: number; t1: number; to: Camera }
export interface Timeline {
  cues: Cue[]; total: number;
  beats: Key<SummaryBeat>[]; focus: Key<number>[]; moves: Move[]; cams: CamMove[];
  gate: Key<"idle" | "fail" | "pass">[];
}

const WIDE: Camera = { s: 1, cx: 0.5, cy: 0.5 };
export const colX = (i: number, n: number) => MODEL_W + (1 - MODEL_W) * (i + 0.5) / n;

export function timeline(nar: Narration, axis: string[]): Timeline {
  const n = axis.length;
  const ci = axis.indexOf("ci");
  const colCam = (i: number): Camera => ({ s: COLUMN_ZOOM, cx: colX(i, n), cy: 0.5 });
  const cellCam: Camera = { s: CELL_ZOOM, cx: colX(ci, n), cy: GATE_ROW_Y };
  const tl: Timeline = { cues: [], total: 0, beats: [{ t: 0, v: "intro" }], focus: [{ t: 0, v: -1 }], moves: [],
    cams: [], gate: [{ t: 0, v: "idle" }] };
  let lastEnd = -GAP_MS, quiet = 0, camReady = 0, shown = 0, col = 0, cam = WIDE;
  let free = 0;                       // when the scene is free for the next moment's preparation
  const camTo = (t: number, to: Camera) => {
    if (to.s === cam.s && to.cx === cam.cx && to.cy === cam.cy) return t;
    tl.cams.push({ t0: t, t1: t + CAM_MS, to });
    cam = to;
    return t + CAM_MS;
  };
  for (const m of nar.moments) {
    const prep = Math.max(free, lastEnd);
    if (m.focus === "column" && m.col) {
      const i = axis.indexOf(m.col);
      if (tl.beats.at(-1)!.v !== "columns") tl.beats.push({ t: prep, v: "columns" });
      tl.focus.push({ t: prep, v: m.then ? axis.indexOf(m.then) : i });
      camReady = camTo(prep, colCam(m.then ? (i + axis.indexOf(m.then)) / 2 : i));
    } else if (m.focus === "gate-ci") {
      tl.focus.push({ t: prep, v: ci });
      camReady = camTo(prep, cellCam);
      if (m.gate) {
        // the red (or green) fades in once the camera is on the cell, and is fully there before the sentence
        const at = Math.max(prep, camReady - FADE_MS);
        tl.gate.push({ t: at, v: m.gate });
        shown = at + FADE_MS;
      }
    } else if (m.focus === "rule" || m.focus === "ci") {
      const i = m.focus === "rule" ? axis.indexOf("plan") : ci;
      tl.beats.push({ t: prep, v: m.focus });
      tl.focus.push({ t: prep, v: -1 });
      camReady = camTo(prep, colCam(i));
      shown = prep;
    } else {
      shown = 0;
    }
    let start = Math.max(lastEnd + GAP_MS, quiet, camReady + SETTLE_MS);
    if (m.n === nar.moments[0].n) start = Math.max(start, LEAD_MS);
    if (m.type === "D") start = Math.max(start, shown + SHOWN_MS);
    const end = start + phraseMs(m.text);
    const cue: Cue = { n: m.n, type: m.type, text: m.text, start, end, action: m.type === "D" ? shown : end, moment: m };
    tl.cues.push(cue);
    lastEnd = end;
    free = end;
    if (m.type === "A") {
      // the event: the change moves into the moment's column (and on to `then`), when the sentence ends
      let t = end;
      const stops = m.focus === "column" && m.col ? [axis.indexOf(m.col), ...(m.then ? [axis.indexOf(m.then)] : [])] : [];
      for (const to of stops) {
        if (to === col) continue;
        tl.moves.push({ t0: t, t1: t + MOVE_MS, from: col, to });
        col = to;
        t += MOVE_MS;
      }
      quiet = Math.max(end + WATCH_MS, t + 400);
      free = t;
    } else {
      quiet = 0;
    }
  }
  // the close: the whole table, the rule cells and the CI column lit, still, with an empty band
  const close = lastEnd + GAP_MS;
  tl.beats.push({ t: close, v: "final" });
  const ready = camTo(close, WIDE);
  tl.total = ready + END_HOLD_MS;
  return tl;
}

export interface NarratedFrame {
  frame: LanesFrame;
  camera: Camera;
  caption: { text: string; opacity: number };
  /** 0..1: how far the gate's current red or green has faded in */
  gateFade: number;
  /** the moment on screen (0 before the first sentence) */
  n: number;
}

const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
function keyAt<T>(keys: Key<T>[], t: number): Key<T> {
  let k = keys[0];
  for (const x of keys) if (t >= x.t) k = x;
  return k;
}

export function narratedAt(t: number, tl: Timeline, axis: string[]): NarratedFrame {
  const beat = keyAt(tl.beats, t).v;
  const focus = keyAt(tl.focus, t).v;
  // where the change is: the last move started, eased
  let pos = 0;
  for (const m of tl.moves) {
    if (t < m.t0) break;
    pos = m.from + (m.to - m.from) * ease(clamp01((t - m.t0) / (m.t1 - m.t0)));
  }
  // the camera: each move eases from where the previous one left it
  let camera = { s: 1, cx: 0.5, cy: 0.5 };
  for (const c of tl.cams) {
    if (t < c.t0) break;
    const p = ease(clamp01((t - c.t0) / (c.t1 - c.t0)));
    camera = { s: camera.s + (c.to.s - camera.s) * p, cx: camera.cx + (c.to.cx - camera.cx) * p,
      cy: camera.cy + (c.to.cy - camera.cy) * p };
  }
  const g = keyAt(tl.gate, t);
  const n = axis.length;
  const shownCols = beat === "intro" ? 0 : beat === "columns" ? Math.max(focus, Math.round(pos)) + 1 : n;
  const frame: LanesFrame = {
    beat, shown: shownCols, now: beat === "columns" ? focus : -1,
    // the gate's CI cell looks "reached" (no longer moving) once the change is in the column
    inColumn: 1e6, pos, gate: g.v,
  };
  let on: Cue | undefined;
  let cur: Cue | undefined;
  for (const c of tl.cues) {
    if (t >= c.start) cur = c;
    if (t >= c.start && t < c.end) on = c;
  }
  const caption = on
    ? { text: on.text, opacity: Math.min(1, (t - on.start) / BAND_FADE_MS, (on.end - t) / BAND_FADE_MS) }
    : { text: "", opacity: 0 };
  return { frame, camera, caption, gateFade: g.v === "idle" ? 0 : clamp01((t - g.t) / FADE_MS), n: cur?.n ?? 0 };
}

/** Cell opacity with narration: what is past stays readable, the future is faint, the summary keeps the rest at 0.5;
 * the close lights the rule cells and the CI column together. */
export function narratedOpacity(f: LanesFrame, col: number, opts: { rule: boolean; ci: boolean }): number {
  if (f.beat === "intro") return 0.9;
  if (f.beat === "columns") return col >= f.shown ? 0.25 : col === f.now ? 1 : 0.85;
  if (f.beat === "rule") return opts.rule ? 1 : 0.5;
  if (f.beat === "ci") return opts.ci ? 1 : 0.5;
  return opts.rule || opts.ci ? 1 : 0.5;
}

/**
 * The grid's transform for a camera. The view is W×H; its left `left` px hold the fixed model names and the cut, so
 * the camera frames the stops in [left, W]. The grid (w×h, origin top-left) never shows past its right edge, and its
 * first stop never comes right of `left`. `cut`: 0..1, how many stops are out of view on the left (the cut fades in).
 */
export function cameraTransform(c: Camera, view: { W: number; H: number; left?: number }, grid: { w: number; h: number }) {
  const L = view.left ?? 0;
  const firstStop = MODEL_W * grid.w;
  let tx: number;
  const span = c.s * grid.w * (1 - MODEL_W);
  if (span <= view.W - L) tx = L - c.s * firstStop + (view.W - L - span) / 2;
  else tx = Math.min(L - c.s * firstStop, Math.max(view.W - c.s * grid.w, (L + view.W) / 2 - c.s * c.cx * grid.w));
  const sizeY = c.s * grid.h;
  const ty = sizeY <= view.H ? (view.H - sizeY) / 2
    : Math.min(0, Math.max(view.H - sizeY, view.H / 2 - c.s * c.cy * grid.h));
  const hidden = (L - tx) / c.s - firstStop;      // grid px of stops left of the view
  return { tx, ty, s: c.s, cut: clamp01(hidden / 40) };
}
