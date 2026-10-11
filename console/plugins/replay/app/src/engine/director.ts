// Director: presentation logic over a replay, all pure and deterministic (no randomness, no wall-clock reads).
//  - slides: key moments as a slide deck (presenter mode) and the paced approach to the next one;
//  - director's cut: a presentation clock that plays a whole run in ~60–90 s (key moments at 1×, the stretches in
//    between compressed, runs of repetitive reads collapsed into a short "montage" captioned only from replay data);
//  - compare sync: two runs aligned by key moment (kind + order), the side lacking a moment holds while the other
//    plays it, so both reach the next shared moment together;
//  - Timebase: one function from the presentation clock to the replay clock(s) that the Player drives.
// Erasable TypeScript only (runs under `node --test` with type stripping).

import { duration, markerTone, type MarkerKind, type Replay, type ReplayMarker } from "./replay.ts";

/** Rounds to 1 µs so float noise never leaves a step at t_ms just "before" the clock (step times are integers). */
function snap(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ------------------------------------------------------------------------------------------------ slides

export interface Slide {
  /** position on the clock the slides were built for (replay ms, joint ms or presentation ms) */
  t: number;
  label: string;
  kind: MarkerKind | "start" | "end" | "moment";
  tone: "pass" | "fail" | "neutral";
}

const SAME_T = 1;

function pushSlide(out: Slide[], s: Slide): void {
  const last = out[out.length - 1];
  if (last && Math.abs(last.t - s.t) < SAME_T) {
    if (last.kind === "start") {
      out[out.length - 1] = { ...s, t: last.t };
    } else if (!last.label.split(" · ").includes(s.label)) {
      last.label = `${last.label} · ${s.label}`;
      if (s.tone === "fail" || (s.tone === "pass" && last.tone === "neutral")) last.tone = s.tone;
    }
    return;
  }
  out.push(s);
}

/** Key moments as slides: "Start" at 0, every marker in order (same-time markers merged), then "End". */
export function slides(r: Replay): Slide[] {
  const out: Slide[] = [{ t: 0, label: "Start", kind: "start", tone: "neutral" }];
  for (const m of r.markers) pushSlide(out, { t: m.t_ms, label: m.label, kind: m.kind, tone: markerTone(m) });
  const end = duration(r);
  if (end > out[out.length - 1].t + SAME_T) out.push({ t: end, label: "End", kind: "end", tone: "neutral" });
  return out;
}

/** Re-times slides onto another clock (e.g. the director's cut presentation clock). */
export function mapSlides(list: Slide[], f: (t: number) => number): Slide[] {
  const out: Slide[] = [];
  for (const s of list) pushSlide(out, { ...s, t: f(s.t) });
  return out;
}

/** Index of the first slide strictly after `clock`, or null at the end. */
export function nextSlide(list: Slide[], clock: number): number | null {
  for (let i = 0; i < list.length; i++) if (list[i].t > clock + SAME_T) return i;
  return null;
}

/** Index of the last slide strictly before `clock` (the one we are leaving or have just left), or null. */
export function prevSlide(list: Slide[], clock: number): number | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].t < clock - SAME_T) return i;
  return null;
}

/** Index of the slide the clock is at or past (0 = Start). */
export function currentSlide(list: Slide[], clock: number): number {
  let cur = 0;
  for (let i = 0; i < list.length; i++) if (list[i].t <= clock + SAME_T) cur = i;
  return cur;
}

/**
 * On-screen duration of the approach to the next key moment, a deterministic function of the gap: about 2 s for
 * short gaps, rising smoothly towards 4 s for long ones (never more). Gaps under 1 s play at 0.5× (2 × gap) so a
 * moment that is close by is not skipped in a blink.
 */
export function approachDuration(gapMs: number): number {
  if (!(gapMs > 0)) return 0;
  if (gapMs < 1000) return 2 * gapMs;
  return 2000 + 2000 * (1 - Math.exp(-Math.max(0, gapMs - 2000) / 30_000));
}

/** Eased position of an approach (sine in-out), landing exactly on `to`. */
export function approachAt(from: number, to: number, elapsed: number, dur: number): number {
  if (dur <= 0 || elapsed >= dur) return to;
  const u = clamp(elapsed / dur, 0, 1);
  return from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * u));
}

// ------------------------------------------------------------------------------------------------ track + montage

/** One replay step as seen by the director's cut (on whatever clock the track uses). */
export interface TrackEvent {
  t: number;
  actor: string;
  tool: string | null;
  input: string | null;
  /** a TOOL_CALL_STARTED (counts as one call); completions carry the tool name too but are not counted */
  started: boolean;
  /** a repetitive read-only step (Read/Grep/Glob tool call) */
  readish: boolean;
  /** derived steps (moves) neither break nor join a run */
  ignorable: boolean;
}

export interface Track {
  end: number;
  /** key-moment times (played at 1× in the cut) */
  keys: number[];
  /** per side (pane A, pane B in compare) the step sequence, sorted by t */
  sides: TrackEvent[][];
}

export const READ_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

export function trackEvents(r: Replay, toClock: (t: number) => number = (t) => t): TrackEvent[] {
  return r.steps.map((s) => {
    const d = s.detail ?? {};
    const tool = typeof d["tool_name"] === "string" ? (d["tool_name"] as string) : null;
    const input = typeof d["input_summary"] === "string" ? (d["input_summary"] as string) : null;
    const started = d["event_type"] === "TOOL_CALL_STARTED" || (input !== null && d["output_summary"] === undefined);
    return {
      t: toClock(s.t_ms),
      actor: s.actor,
      tool,
      input,
      started: tool !== null && started,
      readish: s.action === "work" && tool !== null && READ_TOOLS.includes(tool),
      ignorable: s.action === "move",
    };
  });
}

export function replayTrack(r: Replay): Track {
  return { end: duration(r), keys: r.markers.map((m) => m.t_ms), sides: [trackEvents(r)] };
}

export interface Montage {
  /** e.g. "Montage · 6 reads" */
  title: string;
  /** e.g. ["src/core/events.ts, test/app.test.ts, …"] */
  lines: string[];
  /** title + lines in one string */
  text: string;
  /** 0 = pane A, 1 = pane B */
  side: number;
  actor: string;
  calls: number;
}

interface Run {
  r0: number;
  r1: number;
  side: number;
  events: TrackEvent[];
}

const PATHS_MAX_CHARS = 84;

/** Caption of a montage, composed only from the steps' tool names and input summaries. */
export function montageCaption(events: TrackEvent[], side = 0): Montage {
  const calls = events.filter((e) => e.started);
  const counted = calls.length ? calls : events;
  const counts = new Map<string, number>();
  for (const e of counted) if (e.tool) counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
  const parts = [...counts].map(([tool, n]) => `${n} ${tool.toLowerCase()}${n === 1 ? "" : "s"}`);
  const title = `Montage · ${parts.join(", ")}`;
  const paths: string[] = [];
  for (const e of events) {
    const p = e.input?.trim();
    if (p && !paths.includes(p)) paths.push(p);
  }
  let line = "";
  let shown = 0;
  for (const p of paths) {
    const next = line ? `${line}, ${p}` : p;
    if (next.length > PATHS_MAX_CHARS && shown > 0) break;
    line = next.length > PATHS_MAX_CHARS ? `${next.slice(0, PATHS_MAX_CHARS - 1)}…` : next;
    shown++;
  }
  if (shown < paths.length) line = `${line}, …`;
  const lines = line ? [line] : [];
  return {
    title,
    lines,
    text: lines.length ? `${title}: ${line}` : title,
    side,
    actor: events[0]?.actor ?? "",
    calls: counted.length,
  };
}

/**
 * Runs of ≥ minCalls consecutive Read/Grep/Glob calls by the same actor with no other kind of step in between
 * (moves ignored), within one side's events (already restricted to a stretch).
 */
export function findReadRuns(events: TrackEvent[], side = 0, minCalls = 3): Run[] {
  const runs: Run[] = [];
  let cur: TrackEvent[] = [];
  const close = () => {
    const calls = cur.filter((e) => e.started).length || cur.length;
    if (cur.length && calls >= minCalls) runs.push({ r0: cur[0].t, r1: cur[cur.length - 1].t, side, events: cur });
    cur = [];
  };
  for (const e of events) {
    if (e.ignorable) continue;
    if (e.readish && (cur.length === 0 || cur[0].actor === e.actor)) {
      cur.push(e);
    } else {
      close();
      if (e.readish) cur.push(e);
    }
  }
  close();
  return runs;
}

// ------------------------------------------------------------------------------------------------ director's cut

export interface CutSegment {
  /** presentation clock */
  p0: number;
  p1: number;
  /** track clock (replay ms; joint ms in compare) */
  r0: number;
  r1: number;
  kind: "key" | "fast" | "montage";
  montage?: Montage;
}

export interface Cut {
  segments: CutSegment[];
  /** presentation duration */
  end: number;
  /** track duration */
  sourceEnd: number;
  /** half-width actually used for key-moment windows */
  keyHalfMs: number;
  /** compression factor of the "fast" stretches (1 = not compressed) */
  factor: number;
}

export const KEY_HALF_MS = 2500;
export const MONTAGE_MS = 2000;
export const MONTAGE_MIN_MS = 800;
export const CUT_TARGET_MS = 75_000;

function mergeWindows(times: number[], half: number, lo: number, hi: number): [number, number][] {
  const sorted = [...times].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const t of sorted) {
    const w0 = clamp(t - half, lo, hi);
    const w1 = clamp(t + half, lo, hi);
    if (w1 <= w0) continue;
    const last = out[out.length - 1];
    if (last && w0 <= last[1]) last[1] = Math.max(last[1], w1);
    else out.push([w0, w1]);
  }
  return out;
}

const total = (ws: [number, number][]) => ws.reduce((s, [a, b]) => s + (b - a), 0);

/** Director's cut over any track (a replay, or the joint clock of a compare view). */
export function buildCutTrack(track: Track, targetMs = CUT_TARGET_MS): Cut {
  const end = Math.max(0, track.end);
  // 1. key windows at 1× (narrowed only when there are so many moments they would eat the whole budget)
  let half = KEY_HALF_MS;
  let keys = mergeWindows(track.keys, half, 0, end);
  while (total(keys) > 0.55 * targetMs && half > 750) {
    half -= 250;
    keys = mergeWindows(track.keys, half, 0, end);
  }
  // 2. the stretches in between, and the montage runs inside them
  const stretches: [number, number][] = [];
  let at = 0;
  for (const [w0, w1] of keys) {
    if (w0 > at) stretches.push([at, w0]);
    at = w1;
  }
  if (end > at) stretches.push([at, end]);
  const candidates: Run[] = [];
  for (const [s0, s1] of stretches) {
    track.sides.forEach((events, side) => {
      const inside = events.filter((e) => e.t >= s0 && e.t <= s1);
      for (const run of findReadRuns(inside, side)) if (run.r1 - run.r0 > MONTAGE_MS) candidates.push(run);
    });
  }
  candidates.sort((a, b) => a.r0 - b.r0 || a.side - b.side);
  const runs: Run[] = [];
  for (const c of candidates) {
    const last = runs[runs.length - 1];
    if (!last || c.r0 >= last.r1) runs.push(c);
  }
  // montages share at most ~20 % of the cut (each 0.8–2 s)
  const montageMs = runs.length
    ? clamp(Math.floor((0.2 * targetMs) / runs.length / 100) * 100, MONTAGE_MIN_MS, MONTAGE_MS)
    : MONTAGE_MS;
  // 3. one compression factor for everything else (never slower than 1×)
  const keyTotal = total(keys);
  const runSpan = runs.reduce((s, r) => s + (r.r1 - r.r0), 0);
  const montageTotal = runs.reduce((s, r) => s + Math.min(montageMs, r.r1 - r.r0), 0);
  const fast = Math.max(0, end - keyTotal - runSpan);
  const budget = Math.max(targetMs - keyTotal - montageTotal, 0.1 * targetMs);
  const factor = fast > 0 ? Math.max(1, fast / budget) : 1;
  // 4. segments in order
  const segments: CutSegment[] = [];
  let p = 0;
  const push = (r0: number, r1: number, kind: CutSegment["kind"], montage?: Montage) => {
    if (r1 <= r0) return;
    const len = kind === "key" ? r1 - r0 : kind === "montage" ? Math.min(montageMs, r1 - r0) : (r1 - r0) / factor;
    const seg: CutSegment = { p0: p, p1: p + len, r0, r1, kind };
    if (montage) seg.montage = montage;
    segments.push(seg);
    p += len;
  };
  const pieces: { r0: number; r1: number; kind: "key" | "stretch" }[] = [
    ...keys.map(([r0, r1]) => ({ r0, r1, kind: "key" as const })),
    ...stretches.map(([r0, r1]) => ({ r0, r1, kind: "stretch" as const })),
  ].sort((a, b) => a.r0 - b.r0);
  for (const piece of pieces) {
    if (piece.kind === "key") {
      push(piece.r0, piece.r1, "key");
      continue;
    }
    let cur = piece.r0;
    for (const run of runs) {
      if (run.r0 < piece.r0 || run.r1 > piece.r1) continue;
      push(cur, run.r0, "fast");
      push(run.r0, run.r1, "montage", montageCaption(run.events, run.side));
      cur = run.r1;
    }
    push(cur, piece.r1, "fast");
  }
  return { segments, end: p, sourceEnd: end, keyHalfMs: half, factor };
}

/** Director's cut of one replay: ~targetMs on screen for long runs; a short run is never stretched. */
export function buildCut(replay: Replay, targetMs = CUT_TARGET_MS): Cut {
  return buildCutTrack(replayTrack(replay), targetMs);
}

function segmentAt(cut: Cut, p: number): CutSegment | null {
  const segs = cut.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (p < segs[mid].p0) hi = mid - 1;
    else if (p >= segs[mid].p1) lo = mid + 1;
    else return segs[mid];
  }
  return null;
}

/** Presentation ms → track ms (monotonic, continuous). */
export function cutClock(cut: Cut, presentationMs: number): number {
  if (!cut.segments.length) return 0;
  if (presentationMs <= 0) return cut.segments[0].r0;
  if (presentationMs >= cut.end) return cut.sourceEnd;
  const s = segmentAt(cut, presentationMs);
  if (!s) return cut.sourceEnd;
  return snap(s.r0 + ((presentationMs - s.p0) / (s.p1 - s.p0)) * (s.r1 - s.r0));
}

/** Track ms → the first presentation ms that shows it (inverse of cutClock; used for seeks and slides). */
export function cutTime(cut: Cut, trackMs: number): number {
  if (trackMs <= 0 || !cut.segments.length) return 0;
  for (const s of cut.segments) {
    if (trackMs <= s.r1) return s.p0 + ((Math.max(trackMs, s.r0) - s.r0) / (s.r1 - s.r0)) * (s.p1 - s.p0);
  }
  return cut.end;
}

/** The montage caption on screen at a presentation time, or null. */
export function montageAt(cut: Cut, presentationMs: number): Montage | null {
  const s = segmentAt(cut, presentationMs);
  return s && s.kind === "montage" && s.montage ? s.montage : null;
}

// ------------------------------------------------------------------------------------------------ compare sync

/** CI pass and CI fail are the same kind of moment ("CI result"); everything else matches its own kind. */
export function momentClass(kind: MarkerKind): string {
  return kind === "ci_fail" || kind === "ci_pass" ? "ci_result" : kind;
}

export interface AlignedPair {
  a: number | null;
  b: number | null;
}

/**
 * Sequence alignment of two key-moment lists by class and order (LCS; ties resolved towards the earliest match,
 * so "the first CI result of A" meets "the first CI result of B"). A moment one side lacks pairs with null.
 */
export function alignMoments(a: ReplayMarker[], b: ReplayMarker[]): AlignedPair[] {
  const n = a.length;
  const m = b.length;
  const S: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const eq = (i: number, j: number) => momentClass(a[i].kind) === momentClass(b[j].kind);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      S[i][j] = Math.max(S[i + 1][j], S[i][j + 1], eq(i, j) ? 1 + S[i + 1][j + 1] : 0);
    }
  }
  const out: AlignedPair[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && eq(i, j) && S[i][j] === 1 + S[i + 1][j + 1]) out.push({ a: i++, b: j++ });
    else if (i < n && (j >= m || S[i][j] === S[i + 1][j])) out.push({ a: i++, b: null });
    else out.push({ a: null, b: j++ });
  }
  return out;
}

export interface SyncSegment {
  j0: number;
  j1: number;
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

export interface SyncMoment {
  /** joint clock */
  j: number;
  a: ReplayMarker | null;
  b: ReplayMarker | null;
}

export interface Sync {
  segments: SyncSegment[];
  moments: SyncMoment[];
  end: number;
  endA: number;
  endB: number;
}

/** Half-width of the stretch around a one-sided moment during which the other side holds. */
export const HOLD_HALF_MS = 2500;

interface HoldWindow {
  w0: number;
  w1: number;
  markers: ReplayMarker[];
}

function holdWindows(ms: ReplayMarker[], lo: number, hi: number): HoldWindow[] {
  const out: HoldWindow[] = [];
  for (const m of ms) {
    const w0 = clamp(m.t_ms - HOLD_HALF_MS, lo, hi);
    const w1 = clamp(m.t_ms + HOLD_HALF_MS, lo, hi);
    const last = out[out.length - 1];
    if (last && w0 <= last.w1) {
      last.w1 = Math.max(last.w1, w1);
      last.markers.push(m);
    } else {
      out.push({ w0, w1, markers: [m] });
    }
  }
  return out;
}

/**
 * Joint clock of a compare view. Between two shared moments both sides play (A at 1×, B scaled to arrive with it);
 * around a moment only one side has, that side plays at 1× while the other holds.
 */
export function buildSync(ra: Replay, rb: Replay): Sync {
  const endA = duration(ra);
  const endB = duration(rb);
  const pairs = alignMoments(ra.markers, rb.markers);
  const segments: SyncSegment[] = [];
  const moments: SyncMoment[] = [];
  let j = 0;
  let ta0 = 0;
  let tb0 = 0;
  let onlyA: ReplayMarker[] = [];
  let onlyB: ReplayMarker[] = [];
  const seg = (len: number, a0: number, a1: number, b0: number, b1: number) => {
    if (len <= 0) return;
    segments.push({ j0: j, j1: j + len, a0, a1, b0, b1 });
    j += len;
  };
  const interval = (ta1: number, tb1: number) => {
    ta1 = Math.max(ta1, ta0);
    tb1 = Math.max(tb1, tb0);
    const wa = holdWindows(onlyA, ta0, ta1);
    const wb = holdWindows(onlyB, tb0, tb1);
    const RA = ta1 - ta0 - wa.reduce((s, w) => s + w.w1 - w.w0, 0);
    const RB = tb1 - tb0 - wb.reduce((s, w) => s + w.w1 - w.w0, 0);
    const C = RA > 0 ? RA : RB;
    const events: { u: number; side: 0 | 1; w: HoldWindow }[] = [];
    let before = 0;
    let prev = ta0;
    for (const w of wa) {
      before += w.w0 - prev;
      prev = w.w1;
      events.push({ u: RA > 0 ? before / RA : 0, side: 0, w });
    }
    before = 0;
    prev = tb0;
    for (const w of wb) {
      before += w.w0 - prev;
      prev = w.w1;
      events.push({ u: RB > 0 ? before / RB : 0, side: 1, w });
    }
    events.sort((x, y) => x.u - y.u || x.side - y.side);
    let u = 0;
    let pa = ta0;
    let pb = tb0;
    const placeMoments = (w: HoldWindow, side: 0 | 1, j0: number) => {
      for (const m of w.markers) {
        moments.push({ j: j0 + (m.t_ms - w.w0), a: side === 0 ? m : null, b: side === 1 ? m : null });
      }
    };
    for (const ev of events) {
      if (ev.u > u) {
        const du = ev.u - u;
        const na = ev.side === 0 ? ev.w.w0 : pa + du * RA;
        const nb = ev.side === 1 ? ev.w.w0 : pb + du * RB;
        seg(du * C, pa, na, pb, nb);
        pa = na;
        pb = nb;
        u = ev.u;
      }
      const j0 = j;
      if (ev.side === 0) {
        seg(ev.w.w1 - ev.w.w0, ev.w.w0, ev.w.w1, pb, pb);
        pa = ev.w.w1;
      } else {
        seg(ev.w.w1 - ev.w.w0, pa, pa, ev.w.w0, ev.w.w1);
        pb = ev.w.w1;
      }
      placeMoments(ev.w, ev.side, j0);
    }
    seg((1 - u) * C, pa, ta1, pb, tb1);
    if ((1 - u) * C <= 0 && (pa < ta1 || pb < tb1)) {
      // nothing left on the common clock but a side still has ground to cover: play it at 1× (other holds)
      if (pa < ta1) seg(ta1 - pa, pa, ta1, pb, pb);
      if (pb < tb1) seg(tb1 - pb, ta1, ta1, pb, tb1);
    }
    ta0 = ta1;
    tb0 = tb1;
    onlyA = [];
    onlyB = [];
  };
  for (const p of pairs) {
    if (p.a !== null && p.b !== null) {
      const ma = ra.markers[p.a];
      const mb = rb.markers[p.b];
      interval(ma.t_ms, mb.t_ms);
      moments.push({ j, a: ma, b: mb });
    } else if (p.a !== null) {
      onlyA.push(ra.markers[p.a]);
    } else if (p.b !== null) {
      onlyB.push(rb.markers[p.b]);
    }
  }
  interval(endA, endB);
  moments.sort((x, y) => x.j - y.j);
  return { segments, moments, end: j, endA, endB };
}

function syncSegmentAt(sync: Sync, j: number): SyncSegment | null {
  const segs = sync.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (j < segs[mid].j0) hi = mid - 1;
    else if (j >= segs[mid].j1) lo = mid + 1;
    else return segs[mid];
  }
  return null;
}

/** Joint ms → both replay clocks. */
export function syncAt(sync: Sync, j: number): { a: number; b: number } {
  if (!sync.segments.length || j >= sync.end) return { a: sync.endA, b: sync.endB };
  if (j <= 0) return { a: sync.segments[0].a0, b: sync.segments[0].b0 };
  const s = syncSegmentAt(sync, j);
  if (!s) return { a: sync.endA, b: sync.endB };
  const f = (j - s.j0) / (s.j1 - s.j0);
  return { a: snap(s.a0 + f * (s.a1 - s.a0)), b: snap(s.b0 + f * (s.b1 - s.b0)) };
}

function fromSide(sync: Sync, t: number, side: "a" | "b"): number {
  if (t <= 0) return 0;
  for (const s of sync.segments) {
    const x0 = side === "a" ? s.a0 : s.b0;
    const x1 = side === "a" ? s.a1 : s.b1;
    if (t <= x0) return s.j0;
    if (t <= x1 && x1 > x0) return s.j0 + ((t - x0) / (x1 - x0)) * (s.j1 - s.j0);
  }
  return sync.end;
}

/** Replay ms of pane A → the first joint ms at which A shows it. */
export function syncFromA(sync: Sync, ta: number): number {
  return fromSide(sync, ta, "a");
}

export function syncFromB(sync: Sync, tb: number): number {
  return fromSide(sync, tb, "b");
}

/** The latest key moment reached on the joint clock (shared or one-sided), or null before the first. */
export function syncMomentAt(sync: Sync, j: number): SyncMoment | null {
  let cur: SyncMoment | null = null;
  for (const m of sync.moments) if (m.j <= j + SAME_T) cur = m;
  return cur;
}

export function momentLabel(m: SyncMoment): string {
  if (m.a && m.b) return m.a.label === m.b.label ? m.a.label : `${m.a.label}  ↔  ${m.b.label}`;
  if (m.a) return `${m.a.label} (A only)`;
  return `${m.b?.label ?? ""} (B only)`;
}

function momentTone(m: SyncMoment): Slide["tone"] {
  const ta = m.a ? markerTone(m.a) : "neutral";
  const tb = m.b ? markerTone(m.b) : "neutral";
  return ta === "fail" || tb === "fail" ? "fail" : ta === "pass" || tb === "pass" ? "pass" : "neutral";
}

export function syncSlides(sync: Sync): Slide[] {
  const out: Slide[] = [{ t: 0, label: "Start", kind: "start", tone: "neutral" }];
  for (const m of sync.moments) pushSlide(out, { t: m.j, label: momentLabel(m), kind: "moment", tone: momentTone(m) });
  if (sync.end > out[out.length - 1].t + SAME_T) out.push({ t: sync.end, label: "End", kind: "end", tone: "neutral" });
  return out;
}

/** The compare view as a track on the joint clock (for a director's cut of both runs at once). */
export function syncTrack(sync: Sync, ra: Replay, rb: Replay): Track {
  return {
    end: sync.end,
    keys: sync.moments.map((m) => m.j),
    sides: [trackEvents(ra, (t) => syncFromA(sync, t)), trackEvents(rb, (t) => syncFromB(sync, t))],
  };
}

/** Condition parts of two runs (ticket, V, S, W) with the ones that differ flagged. */
export function conditionDiff(a: Replay, b: Replay): { key: string; a: string; b: string; differs: boolean }[] {
  const out: { key: string; a: string; b: string; differs: boolean }[] = [];
  const ta = a.meta.ticket ?? a.meta.run_id;
  const tb = b.meta.ticket ?? b.meta.run_id;
  out.push({ key: "ticket", a: ta, b: tb, differs: ta !== tb });
  for (const k of ["V", "S", "W"] as const) {
    const va = a.meta.condition?.[k] ?? "";
    const vb = b.meta.condition?.[k] ?? "";
    if (!va && !vb) continue;
    out.push({ key: k, a: va || "—", b: vb || "—", differs: va !== vb });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ timebase

export interface Timebase {
  /** presentation duration */
  end: number;
  cut: Cut | null;
  sync: Sync | null;
  /** slides on the presentation clock */
  slides: Slide[];
  /** presentation ms → replay ms of pane A (and B in compare) */
  at(p: number): { a: number; b: number | null };
  /** replay ms of pane A → presentation ms (seeks from the timeline, the events panel, ← →) */
  fromA(a: number): number;
  montageAt(p: number): Montage | null;
  /** key moment reached (compare view header) */
  momentAt(p: number): SyncMoment | null;
}

/** The single function the Player drives: presentation clock → replay clock(s), for every mode combination. */
export function makeTimebase(a: Replay, b: Replay | null, opts: { cut: boolean; targetMs?: number }): Timebase {
  const target = opts.targetMs ?? CUT_TARGET_MS;
  if (!b) {
    const markers = a.markers;
    const momentA = (ta: number): SyncMoment | null => {
      let cur: SyncMoment | null = null;
      for (const m of markers) if (m.t_ms <= ta + SAME_T) cur = { j: m.t_ms, a: m, b: null };
      return cur;
    };
    if (!opts.cut) {
      const end = duration(a);
      return {
        end, cut: null, sync: null, slides: slides(a),
        at: (p) => ({ a: clamp(p, 0, end), b: null }),
        fromA: (t) => clamp(t, 0, end),
        montageAt: () => null,
        momentAt: (p) => momentA(p),
      };
    }
    const cut = buildCut(a, target);
    return {
      end: cut.end, cut, sync: null, slides: mapSlides(slides(a), (t) => cutTime(cut, t)),
      at: (p) => ({ a: cutClock(cut, p), b: null }),
      fromA: (t) => cutTime(cut, t),
      montageAt: (p) => montageAt(cut, p),
      momentAt: (p) => momentA(cutClock(cut, p)),
    };
  }
  const sync = buildSync(a, b);
  if (!opts.cut) {
    return {
      end: sync.end, cut: null, sync, slides: syncSlides(sync),
      at: (p) => syncAt(sync, p),
      fromA: (t) => syncFromA(sync, t),
      montageAt: () => null,
      momentAt: (p) => syncMomentAt(sync, p),
    };
  }
  const cut = buildCutTrack(syncTrack(sync, a, b), target);
  return {
    end: cut.end, cut, sync, slides: mapSlides(syncSlides(sync), (j) => cutTime(cut, j)),
    at: (p) => syncAt(sync, cutClock(cut, p)),
    fromA: (t) => cutTime(cut, syncFromA(sync, t)),
    montageAt: (p) => montageAt(cut, p),
    momentAt: (p) => syncMomentAt(sync, cutClock(cut, p)),
  };
}

// ------------------------------------------------------------------------------------------------ conductor

/**
 * The presentation clock the Player advances with requestAnimationFrame deltas: plain play/pause at a speed, or a
 * paced approach to a target (presenter mode) that lands and pauses exactly there.
 */
export class Conductor {
  p = 0;
  end = 0;
  speed = 1;
  playing = false;
  approach: { from: number; to: number; elapsed: number; dur: number } | null = null;

  constructor(end: number) {
    this.end = end;
  }

  get moving(): boolean {
    return this.playing || this.approach !== null;
  }

  /** Advances by real elapsed ms. Returns true if the clock moved. */
  tick(realMs: number): boolean {
    if (realMs <= 0) return false;
    const ap = this.approach;
    if (ap) {
      ap.elapsed += realMs;
      this.p = approachAt(ap.from, ap.to, ap.elapsed, ap.dur);
      if (ap.elapsed >= ap.dur) {
        this.p = ap.to;
        this.approach = null;
      }
      return true;
    }
    if (!this.playing) return false;
    this.p = Math.min(this.end, this.p + realMs * this.speed);
    if (this.p >= this.end) this.playing = false;
    return true;
  }

  seek(p: number): void {
    this.approach = null;
    this.p = clamp(p, 0, this.end);
  }

  play(): void {
    this.approach = null;
    if (this.p >= this.end) this.p = 0;
    this.playing = true;
  }

  pause(): void {
    this.approach = null;
    this.playing = false;
  }

  toggle(): void {
    if (this.moving) this.pause();
    else this.play();
  }

  /** Plays forward to `target` in approachDuration(gap) ms and stops there; a target behind is an instant seek. */
  goTo(target: number): void {
    const to = clamp(target, 0, this.end);
    this.playing = false;
    const gap = to - this.p;
    if (gap <= 0) {
      this.seek(to);
      return;
    }
    this.approach = { from: this.p, to, elapsed: 0, dur: approachDuration(gap) };
  }
}
