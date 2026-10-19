// ReplayEngine: replaces pixel-souls' tick(). A deterministic clock over replay.json (spec 22.5.1): the scene at
// clock t is exactly "every step with t_ms <= t applied in order", so seeking back re-applies from 0 and the same
// run always looks the same. No randomness, no wall-clock reads, no model calls.
// Erasable TypeScript only (runs under `node --test` with type stripping).

export type Action =
  | "move" | "work" | "speak" | "assign" | "handoff" | "check" | "ci_result" | "gate_touch" | "oracle" | "phase";

export type MarkerKind =
  | "task_assigned" | "pr_opened" | "ci_fail" | "ci_pass" | "gate_touched" | "repair" | "oracle" | "session_end";

export type CheckStatus = "pass" | "fail" | "error";

export interface ReplayPlace {
  id: string;
  label: string;
  kind: "desk" | "room" | "system" | "library" | "gate" | "stage";
  x: number;
  y: number;
  note?: string;
  /** exporter 2: false when nobody uses the place in this run (drawn dimmed) */
  used?: boolean;
  /** exporter 4: the lifecycle column it belongs to (define, build, verify, production) */
  zone?: string;
}

export interface ReplayActor {
  id: string;
  role: string;
  actor_type: "agent" | "human" | "system";
  display_name: string;
  avatar: { style: "human" | "agent" | "system"; seed: string; badge?: string | null };
  home: string;
  simulated?: boolean;
  /** re-cast view only: the model has no member for this role (drawn dimmed) */
  recast_missing?: boolean;
  /** re-cast view only: the Teams member playing this role */
  recast_member?: string;
}

export interface ReplayStep {
  t_ms: number;
  t_real_ms: number;
  seq: number;
  actor: string;
  action: Action;
  target?: string | null;
  place?: string | null;
  text?: string | null;
  key?: string | null;
  check?: { id?: string; status?: CheckStatus; rule?: string | null };
  narration?: string | null;
  /** exporter 2: plain-language subtitle (a template over trace fields), used when there is no narration */
  caption?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface ReplayMarker {
  t_ms: number;
  label: string;
  kind: MarkerKind;
}

export interface ReplayMeta {
  run_id: string;
  /** "illustration": a scene scripted from public documentation (replay/scenes), never a run */
  source: "real" | "mock" | "illustration";
  unit: string;
  model?: string | null;
  date: string;
  ticket: string | null;
  condition: { V?: string; S?: string; W?: string };
  outcome: string | null;
  ticket_done: string | null;
  trace_sha256: string;
  schema: "replay/1";
  legend: string;
  duration_ms?: number;
  duration_real_ms?: number;
  [key: string]: unknown;
}

/** A moment of the run: the trace seq it comes from and its time on the replay clock. */
export interface SceneMoment {
  seq: number;
  t_ms: number;
}

export interface SceneConsumer {
  id: string;
  desk: string;
  /** the contract the consumer holds, as the CI contract checks name it ("OrderPlaced", "GET /orders/{id}") */
  contract?: string | null;
  /** per PR version (gen, final); a failing result carries the oracle's own words: "5 of 5 tests failed", the first
   * failing test's name and its failure head ("billing could not invoice order A") */
  oracle: Record<string, { status: CheckStatus; tests?: string; test?: string; impact?: string } & SceneMoment>;
  reads: ({ tool?: string; path: string } & SceneMoment)[];
  edits: { path: string; seq: number | null; t_ms: number }[];
  /** a fictional code owner for the desk (M1 traces have no consumer people) */
  owner?: { name: string; title: string; seed: string; fictional: true };
  /** or the run's own code-owner actor */
  owner_actor?: string;
}

export interface DiffCard extends SceneMoment {
  session: string;
  file: string;
  added: number;
  removed: number;
  lines: { op: "+" | "-"; text: string }[];
  more: number;
  source: string;
}

/** exporter 2: the run facts staged around the trace (record, diffs, transcript). */
export interface Scene {
  layout: "pr-tray" | "review";
  visibility?: string | null;
  spec?: string | null;
  agent?: string | null;
  context?: ({ file?: string | null; summary?: string | null } & SceneMoment) | null;
  fitness_functions: string[];
  consumers: SceneConsumer[];
  diff_cards: DiffCard[];
  sources: string[];
  /** exporter 4: the lifecycle columns, left to right */
  zones?: SceneZone[];
  /** exporter 4: which AI-SDLC model the run follows */
  lifecycle_model?: { label: string; detail?: string; source?: string;
    kind?: "single-ticket" | "sprint" | "illustration" };
  /** illustrations only: the public model a scripted scene stages */
  illustration?: Illustration;
  /** exporter 4: single-ticket runs: the ticket comes from the product role because the scenario fixes it */
  ticket_origin?: ({ place: string; label: string; ticket?: string | null; title?: string | null; to: string }
    & SceneMoment) | null;
}

/** A scripted scene's model: its source and date, its own stage names, where the architecture rule lives, what
 * blocks the merge and how the scripted case ends. */
export interface Illustration {
  id: string;
  model: string;
  short: string;
  source: string;
  date: string;
  url?: string | null;
  stages: string[];
  rule: { axis: string; place: string; label: string };
  blocks: { axis: string; place: string; label: string };
  ci_arch: boolean;
  outcome: { status: "caught" | "escapes"; axis: string; label: string };
}

export interface SceneZone {
  id: string;
  label: string;
  x0: number;
  x1: number;
  roles: string;
  band: "probabilistic" | "deterministic";
  band_label: string;
}

export interface Replay {
  meta: ReplayMeta;
  places: ReplayPlace[];
  actors: ReplayActor[];
  steps: ReplayStep[];
  markers: ReplayMarker[];
  scene?: Scene;
}

export type BubbleTone = "neutral" | "thought" | "code" | "pass" | "fail";

export interface Bubble {
  text: string;
  at: number;
  seq: number;
  tone: BubbleTone;
}

export interface ActorView {
  place: string;
  from: string;
  movedAt: number;
  bubble: Bubble | null;
  activeAt: number;
  gateMark: string | null;
}

export interface CiView {
  attempt: number | null;
  running: boolean;
  lights: Record<string, CheckStatus>;
  order: string[];
  result: "pass" | "fail" | null;
  attempts: number;
}

export interface StagingView {
  state: string | null;
  results: Record<string, CheckStatus>;
  consumers: string[];
  contradictsCi: boolean;
}

export interface SceneState {
  applied: number;
  actors: Record<string, ActorView>;
  ci: CiView;
  staging: StagingView;
  phase: string | null;
  narration: { text: string; at: number } | null;
  lastStep: number;
}

export const SPEEDS: readonly number[] = [0.5, 1, 2, 5, 10, 20];
export const WALK_MS = 1200;
export const BUBBLE_MS = 4500;
export const ACTIVE_MS = 2500;
export const NARRATION_MS = 8000;

export function duration(r: Replay): number {
  const last = r.steps.length ? r.steps[r.steps.length - 1].t_ms : 0;
  return Math.max(r.meta.duration_ms ?? 0, last);
}

export function initialState(r: Replay): SceneState {
  const actors: Record<string, ActorView> = {};
  for (const a of r.actors) {
    actors[a.id] = { place: a.home, from: a.home, movedAt: -Infinity, bubble: null, activeAt: -Infinity, gateMark: null };
  }
  return {
    applied: 0,
    actors,
    ci: { attempt: null, running: false, lights: {}, order: [], result: null, attempts: 0 },
    staging: { state: null, results: {}, consumers: [], contradictsCi: false },
    phase: null,
    narration: null,
    lastStep: -1,
  };
}

function ensureActor(s: SceneState, id: string): ActorView {
  let a = s.actors[id];
  if (!a) {
    a = { place: "planning-room", from: "planning-room", movedAt: -Infinity, bubble: null, activeAt: -Infinity, gateMark: null };
    s.actors[id] = a;
  }
  return a;
}

function toneFor(step: ReplayStep): BubbleTone {
  const d = step.detail ?? {};
  if (step.action === "check" || step.action === "ci_result" || step.action === "oracle") {
    const st = step.check?.status;
    return st === "fail" || st === "error" ? "fail" : st === "pass" ? "pass" : "code";
  }
  if (step.action === "gate_touch") return "fail";
  if (d["thought"] === true) return "thought";
  if (typeof d["tool_name"] === "string") return "code";
  return "neutral";
}

/**
 * Steps that speak through the stage instead of a speech bubble, so a CI verdict is said once: the CI tower's lights
 * and failing-rule labels carry check and CI results, the staging bench and the other teams' desks carry oracle
 * results, and the CI output sent back to the agent travels as an envelope (its text stays in the events panel).
 */
export function quietStep(step: ReplayStep): boolean {
  if (step.action === "check" || step.action === "ci_result" || step.action === "oracle") return true;
  return step.action === "speak" && (step.detail ?? {})["feedback"] === "ci_output";
}

/** `?bubbles=task_assigned,pr_opened` (the deck clips): speech bubbles only for steps with one of these keys; the
 * agent's tool calls and messages stay in the events panel. null = every step with text speaks (the default). */
let bubbleKeys: Set<string> | null = null;
export function setBubbleKeys(keys: string[] | null): void {
  bubbleKeys = keys && keys.length ? new Set(keys) : null;
}

/** Applies one step to the scene (mutates `s`). Steps must be applied in order. */
export function applyStep(s: SceneState, step: ReplayStep, index: number): void {
  const a = ensureActor(s, step.actor);
  const d = step.detail ?? {};
  const t = step.t_ms;
  a.activeAt = t;
  switch (step.action) {
    case "move":
      if (step.place && step.place !== a.place) {
        a.from = a.place;
        a.place = step.place;
        a.movedAt = t;
      }
      break;
    case "phase":
      if (typeof d["to_phase"] === "string") s.phase = d["to_phase"] as string;
      break;
    case "check":
      if (!step.check) {
        s.ci.attempt = typeof d["run_attempt"] === "number" ? (d["run_attempt"] as number) : s.ci.attempts;
        s.ci.running = true;
        s.ci.lights = {};
        s.ci.result = null;
        s.ci.attempts += 1;
      } else if (step.check.id && step.check.status) {
        s.ci.lights[step.check.id] = step.check.status;
        if (!s.ci.order.includes(step.check.id)) s.ci.order.push(step.check.id);
      }
      break;
    case "ci_result":
      s.ci.running = false;
      s.ci.result = step.check?.status === "pass" ? "pass" : "fail";
      break;
    case "gate_touch":
      a.gateMark = typeof d["detector"] === "string" ? (d["detector"] as string) : "gate";
      break;
    case "oracle": {
      const state = typeof d["state"] === "string" ? (d["state"] as string) : "final";
      if (state !== s.staging.state) {
        s.staging.state = state;
        s.staging.results = {};
        s.staging.contradictsCi = false;
      }
      const consumer = step.check?.id ?? String(d["consumer"] ?? "?");
      if (!s.staging.consumers.includes(consumer)) s.staging.consumers.push(consumer);
      s.staging.results[consumer] = step.check?.status ?? "error";
      if (d["contradicts_ci"] === true) s.staging.contradictsCi = true;
      break;
    }
    default:
      break;
  }
  if (step.text && step.action !== "move" && !quietStep(step) && (!bubbleKeys || (step.key != null && bubbleKeys.has(step.key)))) {
    a.bubble = { text: step.text, at: t, seq: step.seq, tone: toneFor(step) };
  }
  const sub = step.narration || step.caption;
  if (sub) s.narration = { text: sub, at: t };
  s.applied = index + 1;
  s.lastStep = index;
}

/** Number of steps with t_ms <= t (binary search; steps are sorted by t_ms). */
export function stepsUntil(r: Replay, t: number): number {
  let lo = 0;
  let hi = r.steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.steps[mid].t_ms <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The scene at clock t, rebuilt from 0 (used for seek and step back). */
export function stateAt(r: Replay, t: number): SceneState {
  const s = initialState(r);
  const n = stepsUntil(r, t);
  for (let i = 0; i < n; i++) applyStep(s, r.steps[i], i);
  return s;
}

/** Time of the first step strictly after t, or null at the end. */
export function nextStepTime(r: Replay, t: number): number | null {
  const n = stepsUntil(r, t);
  return n < r.steps.length ? r.steps[n].t_ms : null;
}

/** Time of the previous event group: the latest t_ms strictly before the last applied step's time (or 0). */
export function prevStepTime(r: Replay, t: number): number {
  const n = stepsUntil(r, t);
  if (n === 0) return 0;
  const current = r.steps[n - 1].t_ms;
  const ref = current;
  let best = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (r.steps[i].t_ms < ref) {
      best = r.steps[i].t_ms;
      break;
    }
  }
  return best;
}

/** 0..1 walking progress of an actor between `from` and `place` at clock t. */
export function walkProgress(a: ActorView, t: number): number {
  if (!Number.isFinite(a.movedAt)) return 1;
  return Math.max(0, Math.min(1, (t - a.movedAt) / WALK_MS));
}

export function bubbleVisible(a: ActorView, t: number): boolean {
  return !!a.bubble && t - a.bubble.at < BUBBLE_MS && t >= a.bubble.at;
}

export function isActive(a: ActorView, t: number): boolean {
  return t - a.activeAt < ACTIVE_MS && t >= a.activeAt;
}

export function narrationAt(s: SceneState, t: number, end: number): string | null {
  if (!s.narration) return null;
  if (t - s.narration.at < NARRATION_MS || t >= end) return s.narration.text;
  return null;
}

/** Steps that represent trace events (moves are derived and not listed in the events panel). */
export function eventSteps(r: Replay): { step: ReplayStep; index: number }[] {
  const out: { step: ReplayStep; index: number }[] = [];
  r.steps.forEach((step, index) => {
    if (step.action !== "move") out.push({ step, index });
  });
  return out;
}

export function markerTone(m: ReplayMarker, r?: Replay): "pass" | "fail" | "neutral" {
  if (m.kind === "ci_fail" || m.kind === "gate_touched") return "fail";
  if (m.kind === "ci_pass") return "pass";
  if (m.kind === "oracle") return / [1-9]\d* of \d+ consumers fail/.test(m.label) ? "fail" : "pass";
  if (m.kind === "session_end" && r) return "neutral";
  return "neutral";
}

/**
 * Compare view: maps the clock of run A to run B piecewise-linearly through their matching key moments
 * (the k-th marker of a kind in A ↔ the k-th marker of the same kind in B), so both runs reach "CI failed",
 * "repair", "oracle" at the same moment on screen.
 */
export function syncAnchors(a: Replay, b: Replay): [number, number][] {
  const seen = new Map<string, number>();
  const bIndex = new Map<string, number[]>();
  for (const m of b.markers) {
    const list = bIndex.get(m.kind) ?? [];
    list.push(m.t_ms);
    bIndex.set(m.kind, list);
  }
  const anchors: [number, number][] = [[0, 0]];
  for (const m of a.markers) {
    const k = seen.get(m.kind) ?? 0;
    seen.set(m.kind, k + 1);
    const tb = bIndex.get(m.kind)?.[k];
    if (tb === undefined) continue;
    const [pa, pb] = anchors[anchors.length - 1];
    if (m.t_ms > pa && tb > pb) anchors.push([m.t_ms, tb]);
  }
  const [pa, pb] = anchors[anchors.length - 1];
  const da = duration(a);
  const db = duration(b);
  if (da > pa && db > pb) anchors.push([da, db]);
  return anchors;
}

export function syncClock(anchors: [number, number][], ta: number): number {
  if (anchors.length === 0) return ta;
  if (ta <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [a0, b0] = anchors[i - 1];
    const [a1, b1] = anchors[i];
    if (ta <= a1) return b0 + ((ta - a0) / (a1 - a0)) * (b1 - b0);
  }
  const [aL, bL] = anchors[anchors.length - 1];
  return bL + (ta - aL);
}

/** The player: clock, speed, play/pause, seek, step. Incremental while playing; rebuilt from 0 when seeking. */
export class ReplayEngine {
  readonly replay: Replay;
  readonly end: number;
  clock = 0;
  speed = 1;
  playing = false;
  state: SceneState;

  constructor(replay: Replay) {
    this.replay = replay;
    this.end = duration(replay);
    this.state = stateAt(replay, 0);
  }

  /** Advances the clock by real elapsed ms × speed and applies newly due steps. Returns true if anything changed. */
  advance(realMs: number): boolean {
    if (!this.playing || realMs <= 0) return false;
    const target = Math.min(this.end, this.clock + realMs * this.speed);
    this.applyUntil(target);
    this.clock = target;
    if (this.clock >= this.end) this.playing = false;
    return true;
  }

  private applyUntil(t: number): void {
    const n = stepsUntil(this.replay, t);
    for (let i = this.state.applied; i < n; i++) applyStep(this.state, this.replay.steps[i], i);
  }

  seek(t: number): void {
    const c = Math.max(0, Math.min(this.end, t));
    if (c >= this.clock) {
      this.applyUntil(c);
    } else {
      this.state = stateAt(this.replay, c);
    }
    this.clock = c;
  }

  play(): void {
    if (this.clock >= this.end) this.seek(0);
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  next(): void {
    this.pause();
    const t = nextStepTime(this.replay, this.clock);
    this.seek(t ?? this.end);
  }

  prev(): void {
    this.pause();
    this.seek(prevStepTime(this.replay, this.clock));
  }

  setSpeed(x: number): void {
    if (SPEEDS.includes(x)) this.speed = x;
  }
}
