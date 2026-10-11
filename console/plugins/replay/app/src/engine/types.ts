// Core avatar/spatial data model kept from pixel-souls (the needs/traits/decision model was removed: the Replay
// Theater replays traces, it does not simulate behaviour).

export type HairStyle = "short" | "long" | "curly" | "bald" | "bun";

export interface Appearance {
  skinTone: string;
  hairColor: string;
  hairStyle: HairStyle;
  shirtColor: string;
  eyeColor: string;
  accentColor: string;
}

/** Normalized 0..1 coordinate, meaning depends on context (aerial map or room floor). */
export interface Point {
  x: number;
  y: number;
}
