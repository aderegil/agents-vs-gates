// Human appearance generator, kept verbatim from pixel-souls' engine/character.ts (generateAppearance), plus the
// AI-agent variant: same pixel family, cool synthetic palette (the helmet/visor/outline are added in avatarStyles.ts).
import type { Appearance, HairStyle } from "./types";
import { pick, rngFromSeed } from "./rng";

const SKIN_TONES = ["#ffe0bd", "#f1c27d", "#e0ac69", "#c68642", "#8d5524", "#5a3825"];

const HAIR_COLORS = ["#1c1410", "#3b2417", "#6b4226", "#a9642c", "#d6b370", "#2b2b2b", "#8a2b1f"];

const EYE_COLORS = ["#3b2417", "#1c1410", "#41573c", "#3d5a80", "#5b4636"];

const HAIR_STYLES: HairStyle[] = ["short", "long", "curly", "bald", "bun"];

export function generateAppearance(seed: string, accentColor: string): Appearance {
  const rng = rngFromSeed(`appearance:${seed}`);
  return {
    skinTone: pick(rng, SKIN_TONES),
    hairColor: pick(rng, HAIR_COLORS),
    hairStyle: pick(rng, HAIR_STYLES),
    shirtColor: pick(rng, ["#3d5a80", "#e07a5f", "#81b29a", "#f2cc8f", "#9381ff", "#c9184a", "#4a5859"]),
    eyeColor: pick(rng, EYE_COLORS),
    accentColor,
  };
}

const AGENT_SKIN = ["#c9d2dc", "#b7c3cf", "#aebdcc", "#d5dce4"];
const AGENT_SHELL = ["#334155", "#1e3a5f", "#2f3d50", "#3b4a5e"];
const AGENT_SHIRT = ["#1e3a5f", "#2b4c6f", "#334155", "#3d5a80", "#22405e"];

export function agentAppearance(seed: string, accentColor: string): Appearance {
  const rng = rngFromSeed(`agent:${seed}`);
  return {
    skinTone: pick(rng, AGENT_SKIN),
    hairColor: pick(rng, AGENT_SHELL),
    hairStyle: "bald",
    shirtColor: pick(rng, AGENT_SHIRT),
    eyeColor: "#0f172a",
    accentColor,
  };
}
