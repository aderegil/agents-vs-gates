// Compare the scripted AI-SDLC scenes side by side: one lane per public model on a common phase axis (intent → spec
// → plan → tasks → code → review → CI → release → production), with where the architecture rule lives, what blocks
// the merge and how the same scripted case ends. Everything comes from scenes/index.json (replay/scenes); every frame
// says "Illustration · scripted from public documentation". A playhead reveals the columns one by one (Space plays
// or pauses, Home restarts); ?autoplay=1 starts it, which the video capture uses on a virtual clock.
import { useEffect, useMemo, useRef, useState } from "react";
import { loadSceneIndex, type SceneIndex } from "../data";
import "./lanes.css";

const COLUMN_MS = 4600;
const FINAL_MS = 13000;

/** One plain line per column of the axis, the same for every model (the lanes show how they differ). */
const CAPTION: Record<string, string> = {
  intent: "Every model starts from a written intent.",
  spec: "Each writes requirements or a spec before any code exists.",
  plan: "Where does the architecture rule live? In every model, before generation, as something the agent reads.",
  tasks: "The work is broken into tasks.",
  code: "Same scripted case in every lane: the first attempt drops the old field names.",
  review: "Review: a person approves. Anthropic adds an LLM compliance pass, advisory.",
  ci: "CI: only the gate reads the other teams' contracts.",
  release: "Release: a person authorizes it.",
  production: "Downstream: caught before the merge, or the other teams find out.",
};
const FINAL = "The rule is written down in every model. What differs is whether something checks it after generation.";

function useClock(autoplay: boolean, total: number) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(autoplay);
  const last = useRef<number | null>(null);
  useEffect(() => {
    let raf = 0;
    const loop = (ts: number) => {
      if (last.current !== null && playing) setT((v) => Math.min(total, v + (ts - (last.current as number))));
      last.current = ts;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);
  return { t, setT, playing, setPlaying };
}

export function ModelLanes({ onOpen }: { onOpen?: (url: string) => void }) {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [idx, setIdx] = useState<SceneIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadSceneIndex().then(setIdx).catch((e) => setError(String(e)));
  }, []);
  const want = (query.get("lanes") ?? "").split(",").filter((x) => x && x !== "1");
  const scenes = (idx?.scenes ?? []).filter((s) => !want.length || want.includes(s.id) || want.includes(s.id.replace(/^aisdlc-/, "")));
  const axis = idx?.axis ?? [];
  const total = axis.length * COLUMN_MS + FINAL_MS;
  const { t, setT, playing, setPlaying } = useClock(query.get("autoplay") === "1", total);
  // ?t=<ms> opens at a moment (QA stills)
  useEffect(() => {
    const t0 = Number(query.get("t"));
    if (Number.isFinite(t0) && t0 > 0) setT(t0);
  }, [query, setT]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "Home") setT(0);
      else if (e.key === "End") setT(total);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPlaying, setT, total]);

  if (error) return <div className="empty-state"><p className="error">Cannot load the scenes: {error}</p></div>;
  if (!idx) return <div className="empty-state"><p className="muted">Loading…</p></div>;

  const shown = Math.min(axis.length, Math.floor(t / COLUMN_MS) + 1);
  const final = t >= axis.length * COLUMN_MS;
  const col = final ? null : axis[shown - 1];
  const caption = final ? FINAL : CAPTION[col ?? ""] ?? "";

  return (
    <div className={`lanes ${query.get("capture") === "1" ? "is-capture" : ""}`} style={{ ["--cols" as string]: axis.length }}>
      <header className="lanes__head">
        <div>
          <h1>One change, five AI-SDLC models</h1>
          <p className="lanes__feature">{idx.feature} · Meridian Retail (fictional)</p>
        </div>
        <div className="lanes__label">{idx.label}</div>
      </header>
      <div className="lanes__grid" role="table" aria-label="AI-SDLC models compared on a common phase axis">
        <div className="lanes__row lanes__row--axis" role="row">
          <div className="lanes__model" role="columnheader">Model</div>
          {axis.map((a, i) => (
            <div key={a} role="columnheader" className={`lanes__axis ${i < shown ? "is-on" : ""} ${a === col ? "is-now" : ""}`}>
              {idx.axis_label[a] ?? a}
            </div>
          ))}
        </div>
        {scenes.map((s) => (
          <div key={s.id} className="lanes__row" role="row">
            <div className="lanes__model" role="rowheader">
              <strong>{s.short}</strong>
              <span>{s.source}</span>
              {onOpen && <button type="button" className="lanes__open" onClick={() => onOpen(s.url)}>Play scene</button>}
            </div>
            {axis.map((a, i) => {
              const c = s.columns[a];
              const rule = s.rule.axis === a;
              const blocks = s.blocks.axis === a;
              const out = s.outcome.axis === a;
              const ciSilent = a === "ci" && !s.ci_arch;
              const cls = ["lanes__cell", i < shown ? "is-on" : "", a === col ? "is-now" : "", rule ? "is-rule" : "",
                blocks ? "is-blocks" : "", out ? `is-out is-${s.outcome.status}` : ""].join(" ");
              return (
                <div key={a} className={cls} role="cell">
                  {c && c.stages.length > 0 && <div className="lanes__stage">{c.stages.join(" · ")}</div>}
                  {c && c.artifacts.length > 0 && <div className="lanes__art">{c.artifacts.slice(0, 3).join("  ")}</div>}
                  {c && (c.checks ?? []).length > 0 && <div className="lanes__art">checks: {(c.checks ?? []).join(" · ")}</div>}
                  {c && c.who.length > 0 && <div className="lanes__who">{c.who.slice(0, blocks && out ? 1 : (rule || blocks || out) ? 2 : 3).join(", ")}</div>}
                  {(!c || (!c.stages.length && !c.who.length)) && <div className="lanes__none">not described</div>}
                  {ciSilent && <div className="lanes__tag lanes__tag--quiet">no architecture check</div>}
                  {rule && <div className="lanes__tag lanes__tag--rule">rule lives here</div>}
                  {blocks && <div className="lanes__tag lanes__tag--blocks">blocks the merge</div>}
                  {out && <div className={`lanes__tag lanes__tag--${s.outcome.status}`}>{s.outcome.label}</div>}
                  {a === "production" && s.outcome.status === "caught" && (
                    <div className="lanes__tag lanes__tag--caught">the other teams keep working</div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <footer className="lanes__foot">
        <div className="lanes__caption" aria-live="polite">{caption}</div>
        <div className="lanes__controls">
          <button type="button" className="btn btn--quiet" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
          <button type="button" className="btn btn--quiet" onClick={() => setT(0)}>Restart</button>
          <span className="muted small">{idx.premise}</span>
        </div>
        <div className="lanes__legend">
          <span><i className="sw sw--rule" /> where the rule lives</span>
          <span><i className="sw sw--blocks" /> what blocks the merge</span>
          <span><i className="sw sw--pass" /> caught</span>
          <span><i className="sw sw--fail" /> reaches the other teams</span>
          <span className="lanes__src">Sources: replay/scenes/SOURCES.md</span>
        </div>
      </footer>
    </div>
  );
}
