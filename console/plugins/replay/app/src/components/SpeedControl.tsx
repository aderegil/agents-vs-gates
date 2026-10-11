// pixel-souls' SpeedControl: same preset buttons, now driving the replay clock (and keyboard keys 1–6).
import { SPEED_PRESETS } from "./speedPresets";

interface Props {
  value: number;
  onChange: (speed: number) => void;
}

export function SpeedControl({ value, onChange }: Props) {
  return (
    <div className="speed-control" role="group" aria-label="Playback speed">
      {SPEED_PRESETS.map((preset) => (
        <button
          key={preset.label}
          type="button"
          className={`seg-btn ${value === preset.speed ? "seg-btn--active" : ""}`}
          aria-pressed={value === preset.speed}
          title={`${preset.label} (key ${preset.key})`}
          onClick={() => onChange(preset.speed)}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}
