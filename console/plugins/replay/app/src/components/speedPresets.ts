import { SPEEDS } from "../engine/replay";

export interface SpeedPreset {
  label: string;
  speed: number;
  key: string;
}

/** 0.5× … 20× on keys 1–6 (spec 22.5 item 5). */
export const SPEED_PRESETS: SpeedPreset[] = SPEEDS.map((speed, i) => ({
  label: `${speed}×`,
  speed,
  key: String(i + 1),
}));
