// What the stage shows at once and how big people are (theater-1016), as pure functions the canvas code and the node
// tests share: the avatar size, the speech-bubble cap and the bubbles' fade. Erasable TypeScript only.
import { BUBBLE_MS, type Bubble } from "./replay.ts";
import { PORTRAIT_W } from "./identity.ts";

/** Avatars v2 drew people about 124 stage px wide at the front of the floor. */
export const ACTOR_W_V2 = 124;
/** theater-1016: 25% smaller (Alfredo), so the floor has room for labels and bubbles. */
export const ACTOR_W = Math.round(ACTOR_W_V2 * 0.75);

/** Grid pixels → device pixels for a figure: the nearest whole number, never below 1 (crisp pixel art). */
export function figureGridScale(scale: number, crowd: number, device: number): number {
  return Math.max(1, Math.round((ACTOR_W * crowd * scale * device) / PORTRAIT_W));
}

/** Speech bubbles on screen at once: the newest is read, the one before it steps back (one line, half the light). */
export const MAX_BUBBLES = 2;
/** Opacity of the older bubble when two are up. */
export const OLDER_BUBBLE_ALPHA = 0.5;

/** The bubbles to draw, oldest first: at most MAX_BUBBLES, the newest ones. */
export function shownBubbles<T extends { bubble: Bubble }>(list: T[], max = MAX_BUBBLES): T[] {
  return [...list].sort((p, q) => q.bubble.at - p.bubble.at || q.bubble.seq - p.bubble.seq)
    .slice(0, max).sort((p, q) => p.bubble.at - q.bubble.at || p.bubble.seq - q.bubble.seq);
}

/** A bubble fades in over 200 ms and out over its last 600 ms (no pop, no bounce). */
export function bubbleAlpha(b: Bubble, clock: number): number {
  const age = clock - b.at;
  if (age < 0 || age >= BUBBLE_MS) return 0;
  return Math.max(0, Math.min(1, age / 200, (BUBBLE_MS - age) / 600));
}
