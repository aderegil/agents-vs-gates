// Focus (theater-1016, Alfredo: "what does not take part in an interaction could lose some light"): every beat of the
// replay is an interaction between a few actors and places (the agent and its desk, the agent handing a PR to the
// review table, CI and its tower, the oracle and the other teams' desks). While a beat plays, everything that is not
// part of it is dimmed; when nothing happens for a while the floor returns to full light. A pure function of
// (replay, clock): the same clock always gives the same light. Erasable TypeScript only.
import type { Replay, ReplayStep } from "./replay.ts";

/** How long a beat keeps the light after it starts (unless the next beat takes over first). */
export const FOCUS_MS = 2600;
/** Fade in and out of a beat's light (calm, no flashing). */
export const FOCUS_FADE_MS = 400;
/** Steps closer than this belong to the same beat (a handoff and the move it causes, a check and its lights). */
export const BEAT_GAP_MS = 160;

export interface Interaction {
  t: number;
  end: number;
  /** "actor:<id>" and "place:<id>" keys */
  keys: Set<string>;
}

function stepKeys(r: Replay, s: ReplayStep, homeOf: Map<string, string>): string[] {
  const out = [`actor:${s.actor}`];
  const actorIds = new Set(r.actors.map((a) => a.id));
  const placeIds = new Set(r.places.map((p) => p.id));
  const actor = r.actors.find((a) => a.id === s.actor);
  // a system actor is its object (CI is the tower, the oracle is the staging bench)
  if (actor?.actor_type === "system") out.push(`place:${actor.home}`);
  if (s.place && placeIds.has(s.place)) out.push(`place:${s.place}`);
  if (s.target) {
    if (actorIds.has(s.target)) {
      out.push(`actor:${s.target}`);
      const h = homeOf.get(s.target);
      if (h) out.push(`place:${h}`);
    } else if (placeIds.has(s.target)) out.push(`place:${s.target}`);
  }
  // the oracle's verdict lands at the consumer team's desk
  if (s.action === "oracle") {
    const id = s.check?.id ?? String((s.detail ?? {})["consumer"] ?? "");
    const k = r.scene?.consumers.find((c) => c.id === id);
    if (k) out.push(`place:${k.desk}`);
    if (k?.owner_actor) out.push(`actor:${k.owner_actor}`);
  }
  // CI reads the pull request the agent opened: the PR tray takes part in every CI beat
  if ((s.action === "check" || s.action === "ci_result") && placeIds.has("pr-tray")) out.push("place:pr-tray");
  return out;
}

const cache = new WeakMap<object, Interaction[]>();

/** The beats of a replay, in order, each with the keys that take part in it. */
export function interactions(r: Replay): Interaction[] {
  const hit = cache.get(r);
  if (hit) return hit;
  const homeOf = new Map(r.actors.map((a) => [a.id, a.home]));
  const out: Interaction[] = [];
  for (const s of r.steps) {
    // a phase marker without words is bookkeeping, not an interaction
    if (s.action === "phase" && !s.text) continue;
    const keys = stepKeys(r, s, homeOf);
    if (s.action === "move" && s.place) homeOf.set(s.actor, s.place);
    const last = out[out.length - 1];
    if (last && s.t_ms - last.t <= BEAT_GAP_MS) {
      for (const k of keys) last.keys.add(k);
      continue;
    }
    out.push({ t: s.t_ms, end: s.t_ms + FOCUS_MS, keys: new Set(keys) });
  }
  // a beat hands the light to the next one (with a short cross-fade) instead of lingering over it
  for (let i = 0; i + 1 < out.length; i++) out[i].end = Math.min(out[i].end, out[i + 1].t + FOCUS_FADE_MS);
  cache.set(r, out);
  return out;
}

function envelope(it: Interaction, t: number): number {
  if (t < it.t || t >= it.end) return 0;
  const up = Math.min(1, (t - it.t) / FOCUS_FADE_MS);
  const down = Math.min(1, (it.end - t) / FOCUS_FADE_MS);
  return Math.max(0, Math.min(up, down));
}

export interface FocusFrame {
  /** 0..1: how strongly the current beat holds the light (0 = nobody is dimmed) */
  level: number;
  /** 0..1 per key: how lit it is by the beats playing now */
  lit: Map<string, number>;
}

/** The light at clock t. */
export function focusAt(r: Replay, t: number): FocusFrame {
  const lit = new Map<string, number>();
  let level = 0;
  for (const it of interactions(r)) {
    if (it.t > t) break;
    const w = envelope(it, t);
    if (w <= 0) continue;
    level = Math.max(level, w);
    for (const k of it.keys) lit.set(k, Math.max(lit.get(k) ?? 0, w));
  }
  return { level, lit };
}

/** 0 (full light) .. 1 (fully dimmed) for one actor or place key. */
export function dimAmount(f: FocusFrame, key: string): number {
  return Math.max(0, f.level - (f.lit.get(key) ?? 0));
}

/** The opacity a dimmed thing is drawn with: `floor` when fully out of focus. */
export function focusAlpha(f: FocusFrame, key: string, floor = 0.34): number {
  return 1 - dimAmount(f, key) * (1 - floor);
}
