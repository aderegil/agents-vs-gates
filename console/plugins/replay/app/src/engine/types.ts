// Spatial data model kept from pixel-souls (the needs/traits/decision model and pixel-souls' Appearance were
// removed: the Replay Theater replays traces, and avatars are painted by human.ts / agent.ts).

/** Normalized 0..1 coordinate, meaning depends on context (aerial map or room floor). */
export interface Point {
  x: number;
  y: number;
}
