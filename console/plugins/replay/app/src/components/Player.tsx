// The player: the ReplayEngine clock driven by requestAnimationFrame (pixel-souls' interval loop + speed control,
// now deterministic over replay.json), the stage(s), controls, timeline, events panel, presentation mode, compare
// view and clip recording.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ReplayEngine, SPEEDS, syncAnchors, syncClock, type Replay } from "../engine/replay";
import { AerialMap } from "./AerialMap";
import { EventsPanel } from "./EventsPanel";
import { Icon } from "./Icons";
import { SpeedControl } from "./SpeedControl";
import { Stage, type StageHandle } from "./Stage";
import { Timeline, fmt } from "./Timeline";

interface Props {
  replay: Replay;
  compare: Replay | null;
  picker: ReactNode;
  comparePicker: ReactNode;
  onCloseCompare: () => void;
  onOpenInExplorer?: () => void;
}

function condition(r: Replay): string {
  const c = r.meta.condition ?? {};
  return [c.V, c.S, c.W].filter(Boolean).join("·");
}

function pickMime(): string {
  const options = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  for (const m of options) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  return "video/webm";
}

export function Player({ replay, compare, picker, comparePicker, onCloseCompare, onOpenInExplorer }: Props) {
  const engine = useMemo(() => {
    const e = new ReplayEngine(replay);
    // ?t=<ms> opens the replay at a moment (deep links to a key moment; also used for QA screenshots)
    const t0 = Number(new URLSearchParams(window.location.search).get("t"));
    if (Number.isFinite(t0) && t0 > 0) e.seek(t0);
    return e;
  }, [replay]);
  const engineB = useMemo(() => (compare ? new ReplayEngine(compare) : null), [compare]);
  const anchors = useMemo(() => (compare ? syncAnchors(replay, compare) : []), [replay, compare]);
  const stageRef = useRef<StageHandle>(null);
  const stageBRef = useRef<StageHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [, setFrame] = useState(0);
  const [view, setView] = useState<"floor" | "map">(() =>
    new URLSearchParams(window.location.search).get("view") === "map" ? "map" : "floor");
  const [panel, setPanel] = useState(true);
  // ?present=1 opens in presentation mode (dark, large subtitles) without fullscreen, e.g. for screenshots
  const [presenting, setPresenting] = useState(() => new URLSearchParams(window.location.search).get("present") === "1");
  const [chrome, setChrome] = useState(true);
  const [recording, setRecording] = useState<{ since: number } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const lastUi = useRef(0);

  const refresh = useCallback(() => setFrame((n) => n + 1), []);

  // Main loop
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      const dt = last ? Math.min(100, ts - last) : 0;
      last = ts;
      engine.advance(dt);
      if (engineB) engineB.seek(syncClock(anchors, engine.clock));
      stageRef.current?.draw();
      stageBRef.current?.draw();
      if (ts - lastUi.current > 100) {
        lastUi.current = ts;
        refresh();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, engineB, anchors, refresh]);

  const seek = useCallback((t: number) => {
    engine.seek(t);
    refresh();
  }, [engine, refresh]);

  const togglePresent = useCallback(() => {
    setPresenting((p) => {
      const next = !p;
      if (next) rootRef.current?.requestFullscreen?.().catch(() => undefined);
      else if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
      return next;
    });
  }, []);

  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Controls appear on mouse move in presentation mode
  useEffect(() => {
    if (!presenting) {
      setChrome(true);
      return;
    }
    let timer = window.setTimeout(() => setChrome(false), 2500);
    const onMove = () => {
      setChrome(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setChrome(false), 2500);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.clearTimeout(timer);
    };
  }, [presenting]);

  const toggleRecord = useCallback(() => {
    if (recorderRef.current) {
      recorderRef.current.stop();
      return;
    }
    const canvas = stageRef.current?.canvas();
    if (!canvas || typeof MediaRecorder === "undefined") return;
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 6_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `replay-${replay.meta.run_id}${replay.meta.source === "mock" ? "-SIMULATED" : ""}.webm`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      recorderRef.current = null;
      setRecording(null);
    };
    rec.start(500);
    recorderRef.current = rec;
    setRecording({ since: performance.now() });
  }, [replay]);

  useEffect(() => () => recorderRef.current?.stop(), []);

  // Keyboard (spec 22.5 item 5): Space, 1–6, ← →, F; plus Esc, E (events), M (map/floor)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      const k = e.key;
      if (k === " " || k === "Spacebar") {
        e.preventDefault();
        engine.toggle();
      } else if (k >= "1" && k <= "6") {
        engine.setSpeed(SPEEDS[Number(k) - 1]);
      } else if (k === "ArrowRight") {
        e.preventDefault();
        engine.next();
      } else if (k === "ArrowLeft") {
        e.preventDefault();
        engine.prev();
      } else if (k === "f" || k === "F") {
        togglePresent();
      } else if (k === "Escape" && presenting) {
        togglePresent();
      } else if (k === "e" || k === "E") {
        setPanel((p) => !p);
      } else if (k === "m" || k === "M") {
        setView((v) => (v === "floor" ? "map" : "floor"));
      } else {
        return;
      }
      refresh();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [engine, presenting, togglePresent, refresh]);

  const m = replay.meta;
  const showPanel = panel && !presenting && !compare;
  const recSecs = recording ? Math.floor((performance.now() - recording.since) / 1000) : 0;

  return (
    <div ref={rootRef} className={`player ${presenting ? "is-presenting" : ""} ${chrome ? "" : "chrome-hidden"}`}>
      {!presenting && (
        <header className="topbar">
          <div className="topbar__left">
            {picker}
            <div className="meta" aria-label="Run">
              <strong>{m.ticket ?? m.run_id}</strong>
              {condition(replay) && <span>{condition(replay)}</span>}
              <span>{m.unit}</span>
              {m.model && m.model !== m.unit && <span>{m.model}</span>}
              <span className="num">{m.date}</span>
              {m.outcome && <span className="chip">{m.outcome.replace(/_/g, " ")}</span>}
              {m.ticket_done && <span className="chip">ticket {m.ticket_done.replace(/_/g, " ")}</span>}
              {m.source === "mock" && <span className="chip chip--sim">SIMULATED</span>}
            </div>
          </div>
          <div className="topbar__right">
            <div className="seg" role="group" aria-label="View">
              <button type="button" className={`seg-btn ${view === "floor" ? "seg-btn--active" : ""}`}
                aria-pressed={view === "floor"} onClick={() => setView("floor")} title="Office floor (M)">
                <Icon name="floor" /> Floor
              </button>
              <button type="button" className={`seg-btn ${view === "map" ? "seg-btn--active" : ""}`}
                aria-pressed={view === "map"} onClick={() => setView("map")} title="Aerial map (M)">
                <Icon name="map" /> Map
              </button>
            </div>
            {comparePicker}
            <button type="button" className={`btn ${recording ? "btn--rec" : ""}`} onClick={toggleRecord}
              disabled={view !== "floor" || typeof MediaRecorder === "undefined"}
              title="Record the stage canvas to a WebM clip (the watermark is part of the clip)">
              <Icon name={recording ? "stop" : "record"} />
              {recording ? `Stop · ${recSecs}s` : "Record clip"}
            </button>
            <button type="button" className={`btn ${showPanel ? "" : "btn--quiet"}`} onClick={() => setPanel((p) => !p)}
              aria-pressed={panel} title="Events panel (E)" disabled={!!compare}>
              <Icon name="panel" /> Events
            </button>
            {onOpenInExplorer && (
              <button type="button" className="btn btn--quiet" onClick={onOpenInExplorer} title="Open in Run Explorer">
                <Icon name="link" /> Run Explorer
              </button>
            )}
            <button type="button" className="btn btn--primary" onClick={togglePresent} title="Presentation mode (F)">
              <Icon name="expand" /> Present
            </button>
          </div>
        </header>
      )}

      <div className={`body ${showPanel ? "with-panel" : ""}`}>
        <div className="main-col">
        <div className="stage-area">
          {compare && engineB ? (
            <div className="compare">
              <div className="compare__pane">
                <Stage ref={stageRef} engine={engine} dark={presenting} largeSubtitles={presenting}
                  label={`${m.run_id} · ${m.ticket ?? ""} ${condition(replay)}`} />
              </div>
              <div className="compare__pane">
                <Stage ref={stageBRef} engine={engineB} dark={presenting} largeSubtitles={presenting}
                  label={`${compare.meta.run_id} · ${compare.meta.ticket ?? ""} ${condition(compare)}`} />
                <button type="button" className="btn btn--quiet compare__close" onClick={onCloseCompare}>
                  <Icon name="close" /> Close compare
                </button>
              </div>
            </div>
          ) : view === "floor" ? (
            <div className="stage-frame">
              <Stage ref={stageRef} engine={engine} dark={presenting} largeSubtitles={presenting} />
            </div>
          ) : (
            <div className="stage-frame stage-frame--map">
              <AerialMap engine={engine} onOpenPlace={() => setView("floor")} />
            </div>
          )}
        </div>
      <footer className="controls">
        <Timeline replay={replay} clock={engine.clock} end={engine.end} onSeek={seek} />
        <div className="controls__row">
          <div className="transport">
            <button type="button" className="icon-btn" onClick={() => { engine.prev(); refresh(); }}
              aria-label="Previous event (Left arrow)" title="Previous event (←)">
              <Icon name="prev" size={18} />
            </button>
            <button type="button" className="icon-btn icon-btn--main" onClick={() => { engine.toggle(); refresh(); }}
              aria-label={engine.playing ? "Pause (Space)" : "Play (Space)"} title="Play / pause (Space)">
              <Icon name={engine.playing ? "pause" : "play"} size={18} />
            </button>
            <button type="button" className="icon-btn" onClick={() => { engine.next(); refresh(); }}
              aria-label="Next event (Right arrow)" title="Next event (→)">
              <Icon name="next" size={18} />
            </button>
            <span className="clock num" aria-live="off">
              {fmt(engine.clock)} <span className="muted">/ {fmt(engine.end)}</span>
            </span>
            {typeof m.duration_real_ms === "number" && (
              <span className="muted small" title="Gaps longer than 3 s are compressed to 1.5 s">
                real {fmt(m.duration_real_ms)}
              </span>
            )}
          </div>
          <SpeedControl value={engine.speed} onChange={(s) => { engine.setSpeed(s); refresh(); }} />
          <div className="keys muted small" aria-hidden="true">
            Space play · 1–6 speed · ← → event · F present · E events · M map
          </div>
        </div>
      </footer>
        </div>
        {showPanel && <EventsPanel replay={replay} applied={engine.state.applied} follow={engine.playing}
          onSeek={seek} />}
      </div>
    </div>
  );
}
