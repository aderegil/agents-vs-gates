// Re-cast: the SAME simulated sprint replay shown with another AI-SDLC model's team, taken from the Teams plugin
// data (5 models, each member mapped to an AISDLC-Trace 2.1 role by `v21_role`, with a citation). Nothing about the
// run changes: same steps, same times, same verdicts. Only who sits in each role is relabelled, and roles a model
// has no member for are dimmed as "no counterpart". It is a presentation of one run, never a different run, and the
// stage says so. Pure and deterministic. Erasable TypeScript only.
import type { Replay, ReplayActor } from "./replay.ts";

export interface TeamMember {
  id: string;
  role: string;
  v21_role: string | null;
  v21_note?: string | null;
  actor_type: "human" | "agent" | "system";
  display_name: string;
  seed: string;
  citation?: { file: string; section?: string } | null;
}

export interface TeamModel {
  id: string;
  short: string;
  name: string;
  publisher?: string | null;
  date?: string | null;
  url?: string | null;
  label?: string | null;
  members: TeamMember[];
}

export interface RecastInfo {
  id: string;
  short: string;
  name: string;
  publisher?: string | null;
  date?: string | null;
  url?: string | null;
  label?: string | null;
}

/** Per actor after a re-cast: the member that plays the role, or none. */
export interface RecastSeat {
  actor: string;
  role: string;
  member: TeamMember | null;
}

export interface Recast {
  replay: Replay;
  seats: RecastSeat[];
  /** model members that play no role of this sprint (no v21 role, or a role the sprint does not have) */
  unplaced: TeamMember[];
}

/** Only the simulated multi-role sprint can be re-cast (single-ticket runs have one agent and no team). */
export function canRecast(r: Replay): boolean {
  return r.meta.source === "mock" && r.scene?.lifecycle_model?.kind === "sprint";
}

export const RECAST_NOTE = "RE-CAST of the same simulated sprint — not a different run";

/**
 * The sprint with `model`'s roster: each non-system actor of role R is played by the model's members whose v21_role
 * is R (in the model's order, round-robin when the sprint has several actors of R); an actor whose role the model
 * lacks keeps its place but is marked `recast_missing` and drawn dimmed. Steps, markers and scene are untouched.
 */
export function recast(r: Replay, model: TeamModel): Recast {
  const byRole = new Map<string, TeamMember[]>();
  for (const m of model.members) {
    if (!m.v21_role) continue;
    const list = byRole.get(m.v21_role) ?? [];
    list.push(m);
    byRole.set(m.v21_role, list);
  }
  const used = new Set<string>();
  const counter = new Map<string, number>();
  const seats: RecastSeat[] = [];
  const actors: ReplayActor[] = r.actors.map((a) => {
    if (a.actor_type === "system") return a;
    const cands = byRole.get(a.role) ?? [];
    const k = counter.get(a.role) ?? 0;
    counter.set(a.role, k + 1);
    const m = cands.length ? cands[k % cands.length] : null;
    seats.push({ actor: a.id, role: a.role, member: m });
    if (!m) return { ...a, recast_missing: true } as ReplayActor;
    used.add(m.id);
    const style = m.actor_type === "agent" ? "agent" : "human";
    return {
      ...a,
      display_name: m.display_name,
      actor_type: style,
      avatar: { style, seed: m.seed, badge: style === "agent" ? a.avatar.badge ?? "Mock" : null },
      simulated: true,
      recast_member: m.id,
    } as ReplayActor;
  });
  const info: RecastInfo = { id: model.id, short: model.short, name: model.name, publisher: model.publisher ?? null,
    date: model.date ?? null, url: model.url ?? null, label: model.label ?? null };
  const sprintRoles = new Set(r.actors.map((a) => a.role));
  const unplaced = model.members.filter((m) => !used.has(m.id) && !(m.v21_role && sprintRoles.has(m.v21_role)));
  return { replay: { ...r, actors, meta: { ...r.meta, recast: info } }, seats, unplaced };
}

/** The lifecycle model line shown on the stage. */
export function lifecycleLabel(r: Replay): string | null {
  const rc = r.meta["recast"] as RecastInfo | undefined;
  if (rc) return `Lifecycle model: ${rc.short} roster · ${RECAST_NOTE}`;
  const lm = r.scene?.lifecycle_model;
  return lm ? `Lifecycle model: ${lm.label}` : null;
}

/** The citation line for a re-cast (model name, publisher, date, url). */
export function recastCitation(r: Replay): string | null {
  const rc = r.meta["recast"] as RecastInfo | undefined;
  if (!rc) return null;
  return [rc.name, rc.publisher, rc.date, rc.url, rc.label].filter(Boolean).join(" · ");
}
