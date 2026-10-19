// What the stage draws around the trace (exporter 2 `scene` block), as pure functions of (replay, clock): sheets and
// packets that travel between places, the other teams' code owners and their reactions, the agent's reads and edits
// in another team's folder, and the diff card of the key file. Everything comes from replay.json; nothing here reads
// the wall clock or Math.random, so the same clock always gives the same frame. Erasable TypeScript only.
import { ticketPhrase } from "../../../../../web/lib/labels.js";
import type { CheckStatus, DiffCard, Replay, ReplayStep, SceneConsumer } from "./replay.ts";

export const SHEET_MS = 2400;
export const PICKUP_MS = 900;
export const ENVELOPE_MS = 1200;
export const PACKET_MS = 1000;
export const BOUNCE_MS = 700;
export const RELIEF_MS = 3500;
export const CARD_MS = 7000;
export const READ_FLASH_MS = 2500;

export type TravelKind = "sheet" | "pickup" | "envelope" | "packet";

export interface Travel {
  kind: TravelKind;
  from: string;
  to: string;
  t0: number;
  dur: number;
  label: string;
  /** packets: the oracle verdict at the consumer (a failing packet turns pink and bounces back) */
  status?: CheckStatus;
  /** packets: which version of the PR the oracle ran ("gen" first PR, "final") */
  state?: string;
}

export interface TravelFrame {
  travel: Travel;
  /** 0..1 along the way; for a failing packet > 1 while it bounces back (1..2) */
  progress: number;
}

function agentId(r: Replay): string | null {
  return r.scene?.agent ?? r.actors.find((a) => a.role === "code_agent")?.id ?? null;
}

/** The desk of the agent (where context sheets land and the CI output arrives). */
export function agentDesk(r: Replay): string {
  const id = agentId(r);
  return r.actors.find((a) => a.id === id)?.home ?? "desk-orders";
}

function hasPlace(r: Replay, id: string): boolean {
  return r.places.some((p) => p.id === id);
}

/** "ARCH-1…ARCH-8" from the rule ids CI checks (the fitness functions), in their order. */
export function fitnessLabel(rules: string[]): string {
  if (!rules.length) return "fitness functions";
  return `${rules.length > 1 ? `${rules[0]}…${rules[rules.length - 1]}` : rules[0]} · fitness functions`;
}

/** Maya's sheets: in S1/S2 the context rules go to the agent's desk; in every spec the fitness functions go to CI. */
export function architectSheets(r: Replay): Travel[] {
  const sc = r.scene;
  if (!sc || !r.actors.some((a) => a.role === "architect")) return [];
  if (!hasPlace(r, "architecture-library")) return [];
  const t0 = sc.context?.t_ms ?? 0;
  const out: Travel[] = [];
  const spec = sc.spec ?? "";
  if (spec === "S1" || spec === "S2") {
    out.push({ kind: "sheet", from: "architecture-library", to: agentDesk(r), t0, dur: SHEET_MS,
      label: `${sc.context?.file ?? "context"} · ${spec === "S2" ? "the rules" : "architecture notes"}` });
  }
  if (hasPlace(r, "ci-tower")) {
    out.push({ kind: "sheet", from: "architecture-library", to: "ci-tower", t0, dur: SHEET_MS,
      label: fitnessLabel(sc.fitness_functions) });
  }
  return out;
}

function prPlace(r: Replay): string | null {
  if (hasPlace(r, "pr-tray")) return "pr-tray";
  if (hasPlace(r, "review-table")) return "review-table";
  return null;
}

/** Single-ticket runs: the ticket sheet goes from the product desk to the agent's desk when it is assigned. */
export function ticketSheet(r: Replay): Travel | null {
  const o = r.scene?.ticket_origin;
  if (!o || !hasPlace(r, o.place) || !hasPlace(r, o.to)) return null;
  return { kind: "sheet", from: o.place, to: o.to, t0: o.t_ms, dur: SHEET_MS, label: o.ticket ? `ticket: ${ticketPhrase(o.ticket)}` : "ticket" };
}

/** Everything that travels during the run, in a fixed order (deterministic). */
export function travels(r: Replay): Travel[] {
  const ticket = ticketSheet(r);
  const out: Travel[] = [...(ticket ? [ticket] : []), ...architectSheets(r)];
  const tray = prPlace(r);
  const desk = agentDesk(r);
  const contract = new Map((r.scene?.consumers ?? []).map((c) => [c.id, c]));
  for (const s of r.steps) {
    const d = s.detail ?? {};
    if (s.action === "check" && !s.check && tray && hasPlace(r, "ci-tower")) {
      // CI picks the pull request up from the tray (or the review table)
      out.push({ kind: "pickup", from: tray, to: "ci-tower", t0: s.t_ms, dur: PICKUP_MS, label: "PR" });
    } else if (s.action === "speak" && d["feedback"] === "ci_output" && hasPlace(r, "ci-tower")) {
      out.push({ kind: "envelope", from: "ci-tower", to: desk, t0: s.t_ms, dur: ENVELOPE_MS, label: "CI output" });
    } else if (s.action === "oracle") {
      const id = String(d["consumer"] ?? s.check?.id ?? "");
      const c = contract.get(id);
      if (!c || !hasPlace(r, c.desk)) continue;
      out.push({ kind: "packet", from: desk, to: c.desk, t0: s.t_ms, dur: PACKET_MS, label: c.contract ?? "event",
        status: s.check?.status ?? "error", state: typeof d["state"] === "string" ? (d["state"] as string) : "final" });
    }
  }
  return out;
}

/** The travels on screen at clock t with their progress. */
export function travelsAt(all: Travel[], t: number): TravelFrame[] {
  const out: TravelFrame[] = [];
  for (const tr of all) {
    if (t < tr.t0) continue;
    const bounce = tr.kind === "packet" && tr.status !== "pass" ? BOUNCE_MS : 0;
    const end = tr.t0 + tr.dur + bounce;
    if (t > end) continue;
    const e = t - tr.t0;
    out.push({ travel: tr, progress: e <= tr.dur ? e / tr.dur : 1 + (e - tr.dur) / BOUNCE_MS });
  }
  return out;
}

/** Sheets that have arrived and stay where they landed (a note on the desk, a sheet on the tower). */
export function restingSheets(r: Replay, t: number): Travel[] {
  return architectSheets(r).filter((s) => t >= s.t0 + s.dur);
}

/** Zone of a place (exporter 4); older replays have none. */
export function zoneOf(r: Replay, placeId: string): string | null {
  return r.places.find((p) => p.id === placeId)?.zone ?? null;
}

/** How many versions of the PR sit in the tray at clock t (opened + repairs pushed). */
export function trayCount(r: Replay, t: number): number {
  let n = 0;
  for (const s of r.steps) {
    if (s.t_ms > t) break;
    if (s.key === "pr_opened" || s.key === "repair") n++;
  }
  return n;
}

export type Mood = "neutral" | "worried" | "relieved";

export interface OwnerView {
  mood: Mood;
  /** the oracle verdict shown at the desk: which PR version, pass/fail, the oracle's own message head and, for a
   * failure, what broke in the oracle's own words (impact), when the message names it */
  alert: { state: string; status: CheckStatus; text: string; impact?: string } | null;
}

function oracleMessage(r: Replay, seq: number): string {
  const s = r.steps.find((x: ReplayStep) => x.seq === seq && x.action === "oracle");
  const msg = String((s?.detail ?? {})["message"] ?? "");
  // "5 of 5 tests failed: billing invoices order A…" → "5 of 5 tests failed"
  return msg.split(":")[0].trim();
}

/**
 * A consumer's code owner at clock t: worried with a pink alert once the oracle shows the first PR breaks their
 * service (the packet has arrived), relieved for RELIEF_MS when the final PR passes after a break, worried again if
 * the final PR still breaks it.
 */
export function ownerView(r: Replay, c: SceneConsumer, t: number): OwnerView {
  const gen = c.oracle["gen"];
  const fin = c.oracle["final"];
  const arrived = (m: { t_ms: number } | undefined) => !!m && t >= m.t_ms + PACKET_MS;
  if (fin && arrived(fin)) {
    const text = oracleMessage(r, fin.seq);
    if (fin.status === "pass") {
      const relief = gen && gen.status !== "pass" && t - (fin.t_ms + PACKET_MS) < RELIEF_MS;
      return { mood: relief ? "relieved" : "neutral", alert: { state: "final", status: "pass", text } };
    }
    return { mood: "worried", alert: { state: "final", status: fin.status, text, impact: fin.impact } };
  }
  if (gen && arrived(gen)) {
    const text = oracleMessage(r, gen.seq);
    return gen.status === "pass"
      ? { mood: "neutral", alert: { state: "gen", status: "pass", text } }
      : { mood: "worried", alert: { state: "gen", status: gen.status, text, impact: gen.impact } };
  }
  return { mood: "neutral", alert: null };
}

/** Reads in a consumer's folder up to t: count, last read, and whether the line is flashing (a read just happened). */
export function readsAt(c: SceneConsumer, t: number): { count: number; last: string | null; flash: boolean } {
  const done = c.reads.filter((x) => x.t_ms <= t);
  const last = done.length ? done[done.length - 1] : null;
  return { count: done.length, last: last ? last.path : null, flash: !!last && t - last.t_ms < READ_FLASH_MS };
}

export function editsAt(c: SceneConsumer, t: number): string[] {
  return c.edits.filter((x) => x.t_ms <= t).map((x) => x.path);
}

/** The diff card on screen at t: the latest one shown, for CARD_MS or until the next one. */
export function cardAt(r: Replay, t: number): DiffCard | null {
  const cards = r.scene?.diff_cards ?? [];
  let hit: DiffCard | null = null;
  for (const c of cards) if (c.t_ms <= t) hit = c;
  return hit && t - hit.t_ms < CARD_MS ? hit : null;
}

/** Visibility of the other teams' code from the agent's desk: frosted glass (V0, V1) or clear glass (V2). */
export function glassFor(r: Replay): { clear: boolean; v: string | null; contracts: boolean } {
  const v = r.scene?.visibility ?? r.meta.condition?.V ?? null;
  return { clear: v === "V2", v, contracts: v === "V1" };
}

/** Places nobody uses in this run are dimmed (exporter 2 `used: false`; older replays draw everything). */
export function isDimmed(r: Replay, placeId: string): boolean {
  return r.places.find((p) => p.id === placeId)?.used === false;
}
