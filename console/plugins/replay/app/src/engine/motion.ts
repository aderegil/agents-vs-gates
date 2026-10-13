// How characters move on the floor, from the replay alone (no wall clock, no Math.random): the pose a character is
// drawn in at clock t, and the CI verdict it reacts to. Erasable TypeScript only (runs under `node --test`).
import type { Pose } from "./identity.ts";
import { BUBBLE_MS, bubbleVisible, isActive, type ActorView, type ReplayEngine } from "./replay.ts";
import { hashString } from "./rng.ts";

/** How long people and agents react (smile / worry) after a CI result. */
export const REACT_MS = 3500;
export const BREATH_MS = 2600;
export const BLINK_EVERY_MS = 5300;
export const BLINK_MS = 140;
export const TYPE_FRAME_MS = 150;
export const TALK_FRAME_MS = 160;

export interface CiReaction {
  at: number;
  result: "pass" | "fail";
}

/** The latest CI verdict at or before the engine clock (scans back from the last applied step). */
export function lastCiResult(engine: Pick<ReplayEngine, "replay" | "state">): CiReaction | null {
  const steps = engine.replay.steps;
  for (let i = engine.state.applied - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.action === "ci_result") return { at: s.t_ms, result: s.check?.status === "pass" ? "pass" : "fail" };
  }
  return null;
}

/**
 * The frame a character is drawn in: typing while it works (tool calls, active steps), mouth moving while its
 * bubble is fresh, looking up while it thinks, and a smile or a worried look for REACT_MS after a CI verdict.
 * Idle characters breathe and blink on a phase taken from their id, so two characters never blink in sync.
 */
export function poseFor(id: string, v: ActorView, clock: number, walking: boolean, ci: CiReaction | null): Pose {
  const seed = hashString(`pose:${id}`);
  const pose: Pose = {};
  if (ci && clock >= ci.at && clock - ci.at < REACT_MS) pose.expression = ci.result === "pass" ? "happy" : "worried";
  const bubble = bubbleVisible(v, clock) ? v.bubble : null;
  const typingFrame = (): 1 | 2 => (Math.floor((clock + (seed % 300)) / TYPE_FRAME_MS) % 2 === 0 ? 1 : 2);
  let idle = false;
  if (!walking) {
    if (bubble && bubble.tone === "code") {
      pose.typing = typingFrame();
      pose.look = "down";
    } else if (bubble && bubble.tone === "thought") {
      pose.look = "up";
    } else if (bubble) {
      const talkMs = Math.min(BUBBLE_MS, 900 + bubble.text.length * 35);
      if (clock - bubble.at < talkMs) pose.mouth = Math.floor((clock - bubble.at) / TALK_FRAME_MS) % 2 === 0 ? "open" : "closed";
    } else if (isActive(v, clock)) {
      pose.typing = typingFrame();
      pose.look = "down";
    } else {
      idle = true;
    }
  }
  if (idle) pose.breath = Math.floor((clock + (seed % BREATH_MS)) / BREATH_MS) % 2 === 0 ? 0 : 1;
  const blinkPhase = (clock + (seed % BLINK_EVERY_MS)) % BLINK_EVERY_MS;
  if (blinkPhase < BLINK_MS && pose.expression !== "happy" && !pose.typing) pose.blink = true;
  return pose;
}
