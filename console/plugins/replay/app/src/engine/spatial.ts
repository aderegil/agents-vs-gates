// Pseudo-3D floor projection kept from pixel-souls' engine/spatial.ts (projectFloorPoint). The tag-driven room
// generator (getInterior/pickStation) belonged to the needs/decision engine and was removed: the AI-SDLC Office
// layout comes from replay.json `places` instead (see officeLayout below).
import type { Point } from "./types";
import { hashString } from "./rng";

export interface Projected {
  screenX: number; // 0..1
  screenY: number; // 0..1
  scale: number;
}

/**
 * Fakes a third dimension on a flat canvas: points nearer the door (y -> 1)
 * spread wider and render bigger; points near the back wall (y -> 0) huddle
 * toward the center and render smaller.
 * `farWidth` (added) is the relative width of the back row; pixel-souls used 0.5.
 */
export function projectFloorPoint(p: Point, farWidth = 0.5): Projected {
  const depthT = clampUnit(p.y);
  const rowWidthFrac = lerp(farWidth, 1, depthT);
  const screenX = 0.5 + (p.x - 0.5) * rowWidthFrac;
  const screenY = lerp(0.12, 0.98, depthT);
  const scale = lerp(0.6, 1, depthT);
  return { screenX, screenY, scale };
}

/** Map a place's aerial (x, y) to a floor point: y spreads over the floor depth. */
export function placeToFloor(p: Point): Point {
  return { x: p.x, y: clampUnit((p.y - 0.1) / 0.82) };
}

/**
 * Stable standing spot for an actor at a place: in front of the prop, spread sideways by slot so several people
 * at one table stay legible (deterministic: slot order is the sorted actor ids present).
 */
export function standingSpot(place: Point, slot: number, count: number): Point {
  const f = placeToFloor(place);
  const spread = 0.05;
  const offset = count <= 1 ? 0 : (slot - (count - 1) / 2) * spread;
  return { x: f.x + offset, y: Math.min(1, f.y + 0.1) };
}

export function stableJitter(id: string): number {
  return ((hashString(`jitter:${id}`) % 1000) / 1000 - 0.5) * 0.01;
}

function clampUnit(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
