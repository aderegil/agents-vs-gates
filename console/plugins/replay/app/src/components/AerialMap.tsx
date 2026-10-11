// pixel-souls' AerialMap (DOM/SVG overhead map with plots and avatar tokens that glide between them), now showing
// the AI-SDLC Office places of the replay. System places show their state (CI lights, oracle lights) instead of
// people; route lines show who is walking where right now.
import type { ReplayEngine } from "../engine/replay";
import { isActive, walkProgress } from "../engine/replay";
import { hashString } from "../engine/rng";
import { AvatarCanvas } from "./AvatarCanvas";

interface Props {
  engine: ReplayEngine;
  onOpenPlace: (placeId: string) => void;
}

// Tokens cluster below their place's plot, spread sideways so several tokens stay legible.
function deterministicOffset(id: string): { dx: number; dy: number } {
  const h = hashString(id);
  const lane = (h % 5) - 2;
  return { dx: lane * 3.4, dy: 7.5 };
}

const CONSUMERS = ["billing-service", "analytics-ingest", "web-storefront"];

export function AerialMap({ engine, onOpenPlace }: Props) {
  const { replay, state, clock } = engine;
  const places = new Map(replay.places.map((p) => [p.id, p]));
  const people = replay.actors.filter((a) => a.actor_type !== "system");

  const moving = people
    .map((a) => {
      const v = state.actors[a.id];
      if (!v || v.from === v.place || walkProgress(v, clock) >= 1) return null;
      const from = places.get(v.from);
      const to = places.get(v.place);
      return from && to ? { id: a.id, from, to } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const ciLights = (state.ci.order.length ? state.ci.order : new Array(10).fill("")).map(
    (id: string) => (id ? state.ci.lights[id] : undefined) ?? "idle",
  );
  const stagingKeys = state.staging.consumers.length ? state.staging.consumers : CONSUMERS;

  return (
    <div className="aerial-map" aria-label="Aerial map of the AI-SDLC Office">
      <svg className="aerial-map__routes" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="#2563eb" />
          </marker>
        </defs>
        {moving.map((m) => (
          <line key={m.id} x1={m.from.x * 100} y1={m.from.y * 100} x2={m.to.x * 100} y2={m.to.y * 100}
            stroke="#2563eb" strokeWidth="0.5" strokeDasharray="2 1.6" markerEnd="url(#arrow)" />
        ))}
      </svg>

      {replay.places.map((p) => {
        const owner = replay.actors.find((a) => a.home === p.id && a.actor_type === "system");
        const active = owner ? isActive(state.actors[owner.id], clock) : false;
        return (
          <button key={p.id} type="button" className={`map-plot map-plot--${p.kind} ${active ? "is-active" : ""}`}
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} onClick={() => onOpenPlace(p.id)}
            title={p.note ? `${p.label} — ${p.note}` : p.label}>
            <span className="map-plot__label">{p.label}</span>
            {p.id === "ci-tower" && (
              <span className="map-plot__lights" aria-label="CI checks">
                {ciLights.map((l: string, i: number) => <i key={i} className={`light light--${l}`} />)}
              </span>
            )}
            {p.id === "staging-bench" && (
              <>
                <span className="map-plot__lights" aria-label="Oracle consumers">
                  {stagingKeys.map((k) => <i key={k} className={`light light--${state.staging.results[k] ?? "idle"}`} />)}
                </span>
                <span className="map-plot__note">hidden from the agent</span>
              </>
            )}
          </button>
        );
      })}

      {people.map((a) => {
        const v = state.actors[a.id];
        const base = v ? places.get(v.place) : undefined;
        if (!v || !base) return null;
        const o = deterministicOffset(a.id);
        return (
          <div key={a.id} className={`map-token ${v.gateMark ? "map-token--gate" : ""}`}
            style={{ left: `${base.x * 100 + o.dx}%`, top: `${base.y * 100 + o.dy}%` }} title={a.display_name}>
            <AvatarCanvas spec={{ style: a.avatar.style, seed: a.avatar.seed, badge: a.avatar.badge }} size={30}
              label={a.display_name} />
          </div>
        );
      })}

      <div className={`dom-watermark ${replay.meta.source === "mock" ? "dom-watermark--mock" : ""}`}>
        {replay.meta.source === "mock"
          ? <span>{replay.meta.legend}</span>
          : <span>Replay of a real run · {replay.meta.run_id} · {replay.meta.unit} · {replay.meta.date}</span>}
      </div>
    </div>
  );
}
