// Spec → pixels for human and agent portraits (no DOM). The theater and the Teams plugin both draw from here, so a
// seed paints the same 40×48 pixels everywhere; the tests hash these grids.
import { PixelGrid, gridHash } from "./pixels.ts";
import { paintHuman } from "./human.ts";
import { paintAgent } from "./agent.ts";
import { PORTRAIT_H, PORTRAIT_W, type IdentitySpec, type Pose } from "./identity.ts";

export interface PortraitSpec extends IdentitySpec {
  style: "human" | "agent" | "system";
}

export function portraitPixels(spec: PortraitSpec, pose: Pose = {}): PixelGrid {
  const g = new PixelGrid(PORTRAIT_W, PORTRAIT_H);
  if (spec.style === "agent") paintAgent(g, spec, pose);
  else if (spec.style === "human") paintHuman(g, spec, pose);
  return g;
}

export function portraitHash(spec: PortraitSpec, pose: Pose = {}): string {
  return gridHash(portraitPixels(spec, pose));
}
