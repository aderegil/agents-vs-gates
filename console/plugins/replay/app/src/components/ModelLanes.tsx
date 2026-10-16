// Compare the scripted AI-SDLC scenes side by side (theater-1016 redesign): one lane per public model on a common
// flow (intent → spec → plan → tasks → code → review → CI → release → production), split in the two moments of the
// talk: BEFORE generation the rule is context the agent reads (purple, dashed: probabilistic), AFTER generation only a
// check that runs can block (cyan: deterministic; pink: fails). The same change travels along every lane; in the gate
// lane it fails ARCH-4 in CI and comes back repaired. The closing beats light the rule cells, then the CI column,
// then the whole board. Everything comes from scenes/index.json (replay/scenes) and every frame says "Illustration ·
// scripted from public documentation". ?neutral=1 keeps every per-vendor verdict out: only the gate lane shows an
// outcome. Every opacity and position is computed from the clock (engine/lanes.ts), so a virtual-clock capture is
// exact. Space plays or pauses, Home restarts; ?autoplay=1 starts it, ?t=<ms> opens at a moment.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { loadSceneIndex, type SceneIndex } from "../data";
import { cellOpacity, lanesAt, tokenState, totalMs, type LanesFrame, type TokenState } from "../engine/lanes";
import "./lanes.css";

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
/** ?neutral=1: no per-vendor verdict. Only the gate lane shows an outcome; review, where a model has one, reads the
 * same in every lane; vendor CI cells say only that no architecture check is described. */
const CAPTION_NEUTRAL: Record<string, string> = {
  ...CAPTION,
  review: "Review: where a model has one, it is advisory.",
  production: "The same scripted case in every lane; only the gate lane has a check after generation.",
};
export const BEAT_RULE = "Before generation, every lane has the rule written down: context the agent reads. It helps; it does not guarantee.";
export const BEAT_CI = "After generation, only the gate lane runs a check in CI that reads the other teams' contracts. A check that runs is deterministic.";
const FINAL = "The rule is written down in every model. What differs is whether something checks it after generation.";
const GATE_ID = "aisdlc-gate";
/** Columns before generation (the rule as context). "code" is generation itself; the rest comes after it. */
const BEFORE = new Set(["intent", "spec", "plan", "tasks"]);

function useClock(autoplay: boolean, total: number) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(autoplay);
  const last = useRef<number | null>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      // performance.now(), not the frame timestamp (see Player): extra painted frames do not advance the playhead
      const now = performance.now();
      // the delta is taken now: a lazy state updater runs later, after last.current has moved on
      const d = last.current === null ? 0 : now - last.current;
      if (playing && d > 0) setT((v) => Math.min(total, Math.max(0, v + d)));
      last.current = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);
  return { t, setT, playing, setPlaying };
}

type Lane = SceneIndex["scenes"][number];

/** "Priya · Originator" → "Originator"; "Developer Agent · orders-service" → "Developer Agent" (roles, not names). */
function roleOf(who: string): string {
  const [a, b] = who.split(" · ");
  if (!b) return a;
  return /service|\(/.test(b) ? a : b;
}

function roles(who: string[], max: number): string {
  return [...new Set(who.map(roleOf))].slice(0, max).join(", ");
}

function tokenText(st: TokenState, s: Lane): string {
  if (st === "fail") return "ARCH-4 fails";
  if (st === "repaired") return "repaired · passes";
  if (st === "caught") return "caught";
  if (st === "escapes") return s.outcome.label.replace(/^Escapes:\s*/i, "");
  return "";
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
  const total = totalMs(axis.length);
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

  const f = lanesAt(t, axis.length);
  const neutral = query.get("neutral") === "1";
  const col = f.now >= 0 ? axis[f.now] : null;
  const caption = f.beat === "rule" ? BEAT_RULE : f.beat === "ci" ? BEAT_CI : f.beat === "final" ? FINAL
    : (neutral ? CAPTION_NEUTRAL : CAPTION)[col ?? ""] ?? "";
  const ciCol = axis.indexOf("ci");
  const nBefore = axis.filter((a) => BEFORE.has(a)).length;
  const bandOp = (before: boolean) => (f.beat === "rule" ? (before ? 1 : 0.3) : f.beat === "ci" ? (before ? 0.3 : 1) : 1);

  return (
    <div className={`lanes ${query.get("capture") === "1" ? "is-capture" : ""}`}
      style={{ ["--cols" as string]: axis.length } as CSSProperties}>
      <header className="lanes__head">
        <div>
          <h1>One change, five AI-SDLC models</h1>
          <p className="lanes__feature">{idx.feature} · Meridian Retail (fictional)</p>
        </div>
        <div className="lanes__label">{idx.label}</div>
      </header>

      <div className="lanes__grid" role="table" aria-label="AI-SDLC models compared on a common phase axis">
        {/* the two moments of verification, over the axis */}
        <div className="lanes__row lanes__row--band" aria-hidden="true">
          <div />
          <div className="lanes__band lanes__band--before" style={{ gridColumn: `2 / span ${nBefore}`, opacity: bandOp(true) }}>
            <b>Before generation</b> · the rule is context the agent reads · probabilistic
          </div>
          <div className="lanes__band lanes__band--gen" style={{ gridColumn: `${2 + nBefore} / span 1`, opacity: f.beat === "columns" || f.beat === "final" ? 1 : 0.3 }}>
            generation
          </div>
          <div className="lanes__band lanes__band--after"
            style={{ gridColumn: `${3 + nBefore} / span ${axis.length - nBefore - 1}`, opacity: bandOp(false) }}>
            <b>After generation</b> · only a check that runs can block · deterministic
          </div>
        </div>
        <div className="lanes__row lanes__row--axis" role="row">
          <div className="lanes__model" role="columnheader">Model</div>
          {axis.map((a, i) => (
            <div key={a} role="columnheader"
              className={`lanes__axis ${i < f.shown ? "is-on" : ""} ${i === f.now ? "is-now" : ""}`}>
              <span>{idx.axis_label[a] ?? a}</span>
            </div>
          ))}
        </div>

        {scenes.map((s) => {
          const gate = s.id === GATE_ID;
          const tok = tokenState(f, axis, { gate, outcomeAxis: s.outcome.axis, outcome: s.outcome.status }, neutral);
          const text = tokenText(tok, s);
          const left = `calc(var(--mw) + var(--gap) + (100% - var(--mw) - var(--gap)) * ${((f.pos + 0.5) / axis.length).toFixed(4)})`;
          return (
            <div key={s.id} className={`lanes__row ${gate ? "is-gate" : ""}`} role="row">
              <div className="lanes__model" role="rowheader">
                <strong>{s.short}</strong>
                <span>{s.source}</span>
                {onOpen && <button type="button" className="lanes__open" onClick={() => onOpen(s.url)}>Play scene</button>}
              </div>
              {axis.map((a, i) => (
                <Cell key={a} lane={s} a={a} i={i} gate={gate} neutral={neutral} f={f} ciCol={ciCol}
                  op={cellOpacity(f, i, { rule: s.rule.axis === a || (gate && a === "ci"), ci: a === "ci" })} />
              ))}
              {/* the change, travelling along the lane */}
              <div className="lanes__track" aria-hidden="true" />
              <div className={`lanes__token is-${tok} ${f.pos > axis.length - 2.5 ? "is-right" : ""}`} style={{ left }} aria-hidden="true">
                <i />{text && <span>{text}</span>}
              </div>
            </div>
          );
        })}
      </div>

      <footer className="lanes__foot">
        <div className="lanes__caption" aria-live="polite">{caption}</div>
        <div className="lanes__controls">
          <button type="button" className="btn btn--quiet" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
          <button type="button" className="btn btn--quiet" onClick={() => setT(0)}>Restart</button>
          <span className="muted small">{idx.premise}</span>
        </div>
        <div className="lanes__legend">
          <span><i className="sw sw--rule" /> the rule as context (before generation · probabilistic)</span>
          <span><i className="sw sw--pass" /> a check in CI (after generation · deterministic)</span>
          <span><i className="sw sw--fail" /> fails</span>
          {!neutral && <span><i className="sw sw--blocks" /> what blocks the merge</span>}
          <span><i className="sw sw--token" /> the change</span>
          <span className="lanes__src">Sources: replay/scenes/SOURCES.md</span>
        </div>
      </footer>
    </div>
  );
}

interface CellProps {
  lane: Lane;
  a: string;
  i: number;
  gate: boolean;
  neutral: boolean;
  f: LanesFrame;
  ciCol: number;
  op: number;
}

/** One stop of a lane: the model's own stage name, its artifact, who acts (roles), and the tags that matter. */
function Cell({ lane: s, a, i, gate, neutral, f, ciCol, op }: CellProps) {
  const c = s.columns[a];
  const rule = s.rule.axis === a;
  const reached = f.beat !== "columns" || f.now >= i;
  const blocks = !neutral && s.blocks.axis === a && !(gate && a === "ci");
  const out = !neutral && !gate && s.outcome.axis === a && reached;
  const isCi = a === "ci";
  // a review exists when somebody besides the author acts on the pull request
  const review = neutral && !gate && a === "review" && !!c && c.who.length > 1;
  // the gate lane's CI cell: the check fails first, then passes after the repair
  let gateCi: "idle" | "fail" | "pass" = "idle";
  if (gate && isCi && reached) {
    const st = tokenState(f, fakeAxis(ciCol), { gate: true, outcomeAxis: "ci", outcome: "caught" }, false);
    gateCi = st === "repaired" ? "pass" : st === "fail" ? "fail" : "idle";
  }
  const empty = !c || (!c.stages.length && !c.who.length);
  const cls = ["lanes__cell", i === f.now ? "is-now" : "", rule ? "is-rule" : "", gateCi !== "idle" ? `is-gate-${gateCi}` : "",
    gate && isCi ? "is-check" : "", out ? `is-out is-${s.outcome.status}` : ""].join(" ");
  return (
    <div className={cls} role="cell" style={{ opacity: op }}>
      {c && c.stages.length > 0 && <div className="lanes__stage">{c.stages.join(" · ")}</div>}
      {isCi && !gate ? (
        <>
          {!neutral && c && (c.checks ?? []).length > 0 && <div className="lanes__art">{(c.checks ?? []).join(" · ")}</div>}
          <div className="lanes__tag lanes__tag--quiet">{neutral ? "no architecture check in CI (not described)"
            : empty ? "no CI step described" : "no architecture check"}</div>
        </>
      ) : (
        <>
          {c && c.artifacts.length > 0 && <div className="lanes__art">{c.artifacts[0].split("/").pop()}</div>}
          {gate && isCi && <div className="lanes__art">{(c?.checks ?? []).join(" · ")}</div>}
          {c && c.who.length > 0 && !(gate && isCi) && !(blocks && out) && (
            <div className="lanes__who">{roles(c.who, rule || blocks || out ? 2 : 3)}</div>
          )}
          {empty && <div className="lanes__none">not described</div>}
          {rule && <div className="lanes__tag lanes__tag--rule"><i className="doc" />rule · context</div>}
          {gate && isCi && (
            <div className={`lanes__tag lanes__tag--check is-${gateCi}`}>
              {gateCi === "fail" ? "ARCH-4 fails · blocks the merge" : gateCi === "pass" ? "ARCH-4 passes after the repair"
                : "ARCH-4 · a check in CI"}
            </div>
          )}
          {review && <div className="lanes__tag lanes__tag--quiet">review (advisory)</div>}
          {blocks && <div className="lanes__tag lanes__tag--blocks">blocks the merge</div>}
          {out && <div className={`lanes__tag lanes__tag--${s.outcome.status}`}>{s.outcome.label}</div>}
          {a === "production" && reached && (gate || (!neutral && s.outcome.status === "caught")) && (
            <div className="lanes__tag lanes__tag--caught">the other teams keep working</div>
          )}
        </>
      )}
    </div>
  );
}

/** An axis whose CI column sits at `ci` (tokenState only reads the position of "ci"). */
function fakeAxis(ci: number): string[] {
  return [...Array(ci).fill("·"), "ci"];
}
