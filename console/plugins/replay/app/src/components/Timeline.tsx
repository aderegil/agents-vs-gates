// Time bar with clickable key-moment markers (spec 22.5 item 5). The key moment reached is highlighted; with the
// director's cut on, the stretches it plays at 1× (key moments) and as montages are shaded on the track.
import { useRef } from "react";
import { markerTone, type Replay } from "../engine/replay";

interface Props {
  replay: Replay;
  clock: number;
  end: number;
  onSeek: (t: number) => void;
  /** replay ranges to shade on the track (director's cut: key moments at 1×, montages) */
  bands?: { from: number; to: number; kind: "key" | "montage"; title?: string }[];
}

export function fmt(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

export function Timeline({ replay, clock, end, onSeek, bands }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const pct = (t: number) => `${end > 0 ? (Math.min(t, end) / end) * 100 : 0}%`;
  let current = -1;
  replay.markers.forEach((m, i) => {
    if (m.t_ms <= clock + 1) current = i;
  });

  function seekFromEvent(clientX: number) {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * end);
  }

  return (
    <div className="timeline">
      <div
        ref={trackRef}
        className="timeline__track"
        role="slider"
        tabIndex={0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.round(end / 1000)}
        aria-valuenow={Math.round(clock / 1000)}
        aria-valuetext={`${fmt(clock)} of ${fmt(end)}`}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          seekFromEvent(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) seekFromEvent(e.clientX);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === "Home") onSeek(0);
          if (e.key === "End") onSeek(end);
        }}
      >
        {bands?.map((b, i) => (
          <div key={`band-${i}`} className={`timeline__band timeline__band--${b.kind}`} title={b.title}
            style={{ left: pct(b.from), width: `calc(${pct(b.to)} - ${pct(b.from)})` }} />
        ))}
        <div className="timeline__fill" style={{ width: pct(clock) }} />
        {replay.markers.map((m, i) => (
          <button
            key={i}
            type="button"
            className={`timeline__marker tone-${markerTone(m)}`}
            style={{ left: pct(m.t_ms) }}
            title={`${m.label} · ${fmt(m.t_ms)}`}
            aria-label={`${m.label} at ${fmt(m.t_ms)}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onSeek(m.t_ms)}
          />
        ))}
        <div className="timeline__head" style={{ left: pct(clock) }} />
      </div>
      <div className="timeline__moments" aria-label="Key moments">
        {replay.markers.map((m, i) => (
          <button
            key={i}
            type="button"
            className={`moment tone-${markerTone(m)} ${clock >= m.t_ms ? "is-past" : ""} ${i === current ? "is-current" : ""}`}
            aria-current={i === current ? "step" : undefined}
            onClick={() => onSeek(m.t_ms)}
          >
            <span className="moment__dot" />
            <span className="moment__label">{m.label}</span>
            <span className="moment__time num">{fmt(m.t_ms)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
