// The player: a presentation clock (Conductor, advanced by requestAnimationFrame deltas) mapped through a Timebase
// onto the ReplayEngine clock(s) — plain playback, the director's cut, presenter "slides" and the synchronized
// compare view are all the same loop with a different mapping (engine/director.ts). Plus the stage(s), controls,
// timeline, events panel, presentation mode (F) and 1920×1080 clip recording.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  Conductor, conditionDiff, currentSlide, makeTimebase, momentLabel, nextSlide, prevSlide, type Timebase,
} from "../engine/director";
import { ReplayEngine, SPEEDS, nextStepTime, prevStepTime, type Replay } from "../engine/replay";
import { AerialMap } from "./AerialMap";
import { EventsPanel } from "./EventsPanel";
import { Icon } from "./Icons";
import "./presenter.css";
import { SpeedControl } from "./SpeedControl";
import { Stage, type StageHandle } from "./Stage";
import { Timeline, fmt } from "./Timeline";
import { plainCondition } from "./labels";
import { UnitTag } from "./UnitTag";

interface Props {
  replay: Replay;
  compare: Replay | null;
  picker: ReactNode;
  comparePicker: ReactNode;
  onCloseCompare: () => void;
  onOpenInExplorer?: () => void;
  /** extra controls next to the picker (e.g. the re-cast roster selector) */
  tools?: ReactNode;
  /** a panel under the controls (e.g. the re-cast roster with citations) */
  footer?: ReactNode;
}

type DiffPart = ReturnType<typeof conditionDiff>[number];

function condition(r: Replay): string {
  const c = r.meta.condition ?? {};
  return [c.V, c.S, c.W].filter(Boolean).join("·");
}

// ------------------------------------------------------------------------------------------------ clip format

interface ClipFormat {
  mime: string;
  label: string;
  ext: "mp4" | "webm";
}

const CLIP_FORMATS: ClipFormat[] = [
  { mime: "video/mp4;codecs=avc1", label: "MP4 (H.264)", ext: "mp4" },
  { mime: "video/mp4;codecs=avc1.42E01E", label: "MP4 (H.264)", ext: "mp4" },
  { mime: "video/mp4", label: "MP4", ext: "mp4" },
  { mime: "video/webm;codecs=vp9", label: "WebM (VP9)", ext: "webm" },
  { mime: "video/webm;codecs=vp8", label: "WebM (VP8)", ext: "webm" },
  { mime: "video/webm", label: "WebM", ext: "webm" },
];

function pickFormat(): ClipFormat | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const f of CLIP_FORMATS) if (MediaRecorder.isTypeSupported(f.mime)) return f;
  return null;
}

const CLIP_W = 1920;
const CLIP_H = 1080;
const INK = "#111827";
const INK_2 = "#5b6474";
const LINE = "#e3e6eb";
const BG = "#f6f7f9";
const FONT = '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

interface ComposeInfo {
  heads: DiffPart[] | null;
  moment: string | null;
}

/** Draws one 1920×1080 clip frame: the stage scaled, or both compare panes side by side with their labels. */
function composeFrame(ctx: CanvasRenderingContext2D, panes: (HTMLCanvasElement | null)[], info: ComposeInfo) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CLIP_W, CLIP_H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (panes.length === 1) {
    const c = panes[0];
    if (c && c.width && c.height) {
      const s = Math.min(CLIP_W / c.width, CLIP_H / c.height);
      const w = c.width * s;
      const h = c.height * s;
      ctx.drawImage(c, (CLIP_W - w) / 2, (CLIP_H - h) / 2, w, h);
    }
    return;
  }
  const margin = 16;
  const gap = 32;
  const pw = (CLIP_W - margin * 2 - gap) / 2;
  const ph = (pw * 9) / 16;
  const y = Math.round((CLIP_H - ph) / 2);
  panes.forEach((c, i) => {
    const x = margin + i * (pw + gap);
    if (c && c.width) ctx.drawImage(c, x, y, pw, ph);
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, pw, ph);
    const parts = info.heads ?? [];
    let tx = x;
    ctx.textBaseline = "alphabetic";
    ctx.font = `600 28px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.fillText(i === 0 ? "A" : "B", tx, y - 22);
    tx += ctx.measureText(i === 0 ? "A" : "B").width + 16;
    parts.forEach((p, k) => {
      const text = `${k ? " · " : ""}`;
      ctx.font = `400 28px ${FONT}`;
      ctx.fillStyle = INK_2;
      ctx.fillText(text, tx, y - 22);
      tx += ctx.measureText(text).width;
      const v = i === 0 ? p.a : p.b;
      ctx.font = `${p.differs ? 600 : 400} 28px ${FONT}`;
      ctx.fillStyle = p.differs ? INK : INK_2;
      ctx.fillText(v, tx, y - 22);
      const w = ctx.measureText(v).width;
      if (p.differs) ctx.fillRect(tx, y - 14, w, 3);
      tx += w;
    });
  });
  if (info.moment) {
    ctx.font = `500 30px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.fillText(info.moment, CLIP_W / 2, y + ph + 60, CLIP_W - 2 * margin);
    ctx.textAlign = "left";
  }
}

/** Moves an engine to t; float noise a hair behind the clock never triggers a rebuild from 0. */
function follow(e: ReplayEngine, t: number): void {
  if (t === e.clock) return;
  if (t < e.clock && e.clock - t < 0.01) return;
  e.seek(t);
}

const query = () => new URLSearchParams(window.location.search);

export function Player({ replay, compare, picker, comparePicker, onCloseCompare, onOpenInExplorer, tools, footer }: Props) {
  const engine = useMemo(() => {
    const e = new ReplayEngine(replay);
    // ?t=<ms> opens the replay at a moment (deep links to a key moment; also used for QA screenshots)
    const t0 = Number(query().get("t"));
    if (Number.isFinite(t0) && t0 > 0) e.seek(t0);
    return e;
  }, [replay]);
  const engineB = useMemo(() => (compare ? new ReplayEngine(compare) : null), [compare]);
  // ?cut=1 opens with the director's cut on, ?slides=1 in presenter mode (QA deep links)
  const [cut, setCut] = useState(() => query().get("cut") === "1");
  const [slidesOn, setSlidesOn] = useState(() => query().get("slides") === "1");
  const tb = useMemo(() => makeTimebase(replay, compare, { cut }), [replay, compare, cut]);
  const tbRef = useRef<Timebase>(tb);
  const cutLength = useMemo(() => (cut ? tb.end : makeTimebase(replay, compare, { cut: true }).end), [replay, compare, cut, tb]);
  const conductorRef = useRef<Conductor | null>(null);
  if (!conductorRef.current) conductorRef.current = new Conductor(tb.end);
  const c = conductorRef.current;
  const stageRef = useRef<StageHandle>(null);
  const stageBRef = useRef<StageHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [, setFrame] = useState(0);
  const [view, setView] = useState<"floor" | "map">(() => (query().get("view") === "map" ? "map" : "floor"));
  const [panel, setPanel] = useState(true);
  // ?present=1 opens in presentation mode (large subtitles, auto-hiding controls) without fullscreen, e.g. for screenshots
  const [presenting, setPresenting] = useState(() => query().get("present") === "1");
  const [chrome, setChrome] = useState(true);
  const [recording, setRecording] = useState<{ since: number } | null>(null);
  const recRef = useRef<{ rec: MediaRecorder; ctx: CanvasRenderingContext2D } | null>(null);
  const composeInfo = useRef<ComposeInfo>({ heads: null, moment: null });
  const lastUi = useRef(0);
  const format = useMemo(pickFormat, []);

  const refresh = useCallback(() => setFrame((n) => n + 1), []);

  // A new mapping (cut toggled, compare opened/closed) keeps the replay position of pane A.
  useLayoutEffect(() => {
    tbRef.current = tb;
    c.end = tb.end;
    c.seek(tb.fromA(engine.clock));
  }, [tb, c, engine]);

  /** Maps the presentation clock onto the engine(s) now (after a seek or a key), then redraws the UI. */
  const apply = useCallback(() => {
    const pos = tbRef.current.at(c.p);
    follow(engine, pos.a);
    if (engineB && pos.b !== null) follow(engineB, pos.b);
    refresh();
  }, [c, engine, engineB, refresh]);

  // Main loop
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      // time from performance.now(), not the frame timestamp: a frame the browser paints for another reason (a
      // screenshot, a recording) must not advance the clock, so a virtual clock drives playback exactly
      const now = performance.now();
      const dt = last ? Math.min(100, now - last) : 0;
      last = now;
      c.tick(dt);
      const pos = tbRef.current.at(c.p);
      follow(engine, pos.a);
      if (engineB && pos.b !== null) follow(engineB, pos.b);
      stageRef.current?.draw();
      stageBRef.current?.draw();
      const rec = recRef.current;
      if (rec) {
        const panes = engineB
          ? [stageRef.current?.canvas() ?? null, stageBRef.current?.canvas() ?? null]
          : [stageRef.current?.canvas() ?? null];
        composeFrame(rec.ctx, panes, composeInfo.current);
      }
      if (ts - lastUi.current > 100) {
        lastUi.current = ts;
        refresh();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [c, engine, engineB, refresh]);

  /** Seek to a replay time of pane A (timeline, events panel). */
  const seekReplay = useCallback((t: number) => {
    c.seek(tbRef.current.fromA(t));
    apply();
  }, [c, apply]);

  const stepEvent = useCallback((dir: 1 | -1) => {
    c.pause();
    const t = dir > 0 ? (nextStepTime(replay, engine.clock) ?? engine.end) : prevStepTime(replay, engine.clock);
    c.seek(tbRef.current.fromA(t));
    apply();
  }, [c, replay, engine, apply]);

  /** Presenter: play forward to the next key moment (~2–4 s) and stop there; a second press skips ahead. */
  const nextMoment = useCallback(() => {
    const list = tbRef.current.slides;
    const from = c.approach ? c.approach.to : c.p;
    const i = nextSlide(list, from);
    if (i === null) return;
    c.goTo(list[i].t);
    apply();
  }, [c, apply]);

  /** Presenter: jump back to the previous key moment (instant). */
  const prevMoment = useCallback(() => {
    const list = tbRef.current.slides;
    const i = prevSlide(list, c.p);
    c.pause();
    c.seek(i === null ? 0 : list[i].t);
    apply();
  }, [c, apply]);

  /** Go to the start / the end of the simulation (Home / End), in every mode (presenter, cut, compare). */
  const goStart = useCallback(() => {
    c.pause();
    c.seek(0);
    apply();
  }, [c, apply]);

  const goEnd = useCallback(() => {
    c.pause();
    c.seek(tbRef.current.end);
    apply();
  }, [c, apply]);

  const toggleSlides = useCallback(() => {
    setSlidesOn((s) => {
      if (!s) c.pause();
      return !s;
    });
  }, [c]);

  const toggleCut = useCallback(() => setCut((v) => !v), []);

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
    if (recRef.current) {
      recRef.current.rec.stop();
      return;
    }
    if (!format || !stageRef.current?.canvas()) return;
    const canvas = document.createElement("canvas");
    canvas.width = CLIP_W;
    canvas.height = CLIP_H;
    // kept in the document (off-screen) so every browser keeps producing frames for captureStream
    canvas.style.cssText = "position:fixed;left:-10000px;top:0;width:192px;height:108px;pointer-events:none;";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      canvas.remove();
      return;
    }
    const panes = engineB
      ? [stageRef.current?.canvas() ?? null, stageBRef.current?.canvas() ?? null]
      : [stageRef.current?.canvas() ?? null];
    composeFrame(ctx, panes, composeInfo.current);
    const stream = canvas.captureStream(30);
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 8_000_000 });
    } catch {
      canvas.remove();
      return;
    }
    const chunks: Blob[] = [];
    const mock = replay.meta.source === "mock" || compare?.meta.source === "mock";
    const name = `replay-${replay.meta.run_id}${compare ? `-vs-${compare.meta.run_id}` : ""}${cut ? "-cut" : ""}`
      + `${mock ? "-SIMULATED" : ""}.${format.ext}`;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: (rec.mimeType || format.mime).split(";")[0] });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      stream.getTracks().forEach((t) => t.stop());
      canvas.remove();
      recRef.current = null;
      setRecording(null);
    };
    rec.start(500);
    recRef.current = { rec, ctx };
    setRecording({ since: performance.now() });
  }, [format, engineB, replay, compare, cut]);

  useEffect(() => () => recRef.current?.rec.stop(), []);

  // the stage keeps 16:9 inside whatever height the top bar and the controls leave (they wrap on narrow screens)
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const top = root.querySelector<HTMLElement>(".topbar")?.offsetHeight ?? 0;
      const ctl = root.querySelector<HTMLElement>(".controls")?.offsetHeight ?? 0;
      const foot = root.querySelector<HTMLElement>(".recast")?.offsetHeight ?? 0;
      root.style.setProperty("--chrome-h", `${top + ctl + foot + 44}px`);
    };
    fit();
    const ro = new ResizeObserver(fit);
    root.querySelectorAll(".topbar, .controls, .recast").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [presenting, compare, footer]);

  // Keyboard (spec 22.5 item 5): Space, 1–6, ← →, F; plus Esc, E (events), M (map/floor), P (presenter slides),
  // D (director's cut). Presentation clickers send PageDown/PageUp (and arrows): next/previous key moment.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      const k = e.key;
      if (k === " " || k === "Spacebar") {
        e.preventDefault();
        if (slidesOn) nextMoment();
        else c.toggle();
      } else if (k >= "1" && k <= "6") {
        c.speed = SPEEDS[Number(k) - 1];
      } else if (k === "Home") {
        e.preventDefault();
        goStart();
      } else if (k === "End") {
        e.preventDefault();
        goEnd();
      } else if (k === "PageDown" || (k === "ArrowRight" && slidesOn)) {
        e.preventDefault();
        nextMoment();
      } else if (k === "PageUp" || (k === "ArrowLeft" && slidesOn)) {
        e.preventDefault();
        prevMoment();
      } else if (k === "ArrowRight") {
        e.preventDefault();
        stepEvent(1);
      } else if (k === "ArrowLeft") {
        e.preventDefault();
        stepEvent(-1);
      } else if (k === "f" || k === "F") {
        togglePresent();
      } else if (k === "Escape" && presenting) {
        togglePresent();
      } else if (k === "e" || k === "E") {
        setPanel((p) => !p);
      } else if (k === "m" || k === "M") {
        setView((v) => (v === "floor" ? "map" : "floor"));
      } else if (k === "p" || k === "P") {
        toggleSlides();
      } else if (k === "d" || k === "D") {
        toggleCut();
      } else {
        return;
      }
      apply();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [c, slidesOn, presenting, nextMoment, prevMoment, stepEvent, togglePresent, toggleSlides, toggleCut, apply,
    goStart, goEnd]);

  const onStageClick = (e: MouseEvent<HTMLDivElement>) => {
    if (slidesOn && (e.target as HTMLElement).tagName === "CANVAS") nextMoment();
  };

  const m = replay.meta;
  const showPanel = panel && !presenting && !compare;
  const recSecs = recording ? Math.floor((performance.now() - recording.since) / 1000) : 0;
  const montage = tb.montageAt(c.p);
  const overlayFor = (side: number) => (montage && montage.side === side ? { title: montage.title, lines: montage.lines } : null);
  const slideList = tb.slides;
  const slideIdx = currentSlide(slideList, c.p);
  const slide = slideList[slideIdx];
  const heads = compare ? conditionDiff(replay, compare) : null;
  const shared = compare ? tb.momentAt(c.p) : null;
  const sharedLabel = shared ? momentLabel(shared) : null;
  composeInfo.current = {
    heads,
    moment: compare ? (sharedLabel ? `Key moment · ${sharedLabel}` : null) : null,
  };
  const bands = tb.cut && !compare
    ? tb.cut.segments.filter((s) => s.kind !== "fast").map((s) => ({
      from: s.r0, to: s.r1, kind: s.kind as "key" | "montage",
      title: s.kind === "montage" ? s.montage?.text : "Director's cut: key moment at 1×",
    }))
    : undefined;
  const moving = c.moving;
  const recTitle = format
    ? `Record a 1920×1080 ${format.label} clip of ${compare ? "both stages" : "the stage"} (the watermark is part of the clip)`
    : "Clip recording is not supported in this browser";

  const sideHead = (side: 0 | 1) => (
    <div className={`compare-head__side compare-head__side--${side ? "b" : "a"}`}>
      <span className="compare-head__tag">{side ? "B" : "A"}</span>
      <span className="compare-head__parts">
        {heads?.map((p, i) => (
          <span key={p.key}>
            {i > 0 && <span className="compare-head__sep"> · </span>}
            <span className={p.differs ? "is-diff" : ""} title={p.differs ? `${p.key} differs` : undefined}>
              {side ? p.b : p.a}
            </span>
          </span>
        ))}
      </span>
    </div>
  );

  return (
    <div ref={rootRef}
      className={`player ${presenting ? "is-presenting" : ""} ${chrome ? "" : "chrome-hidden"} ${slidesOn ? "is-slides" : ""}`}>
      {!presenting && (
        <header className="topbar">
          <div className="topbar__left">
            {picker}
            {tools}
            <div className="meta" aria-label="Run">
              <strong>{m.source === "illustration" ? String(m["title"] ?? m.run_id) : m.ticket ?? m.run_id}</strong>
              {condition(replay) && (
                <span className="cond" title={plainCondition(m.condition ?? {}).title}>
                  {plainCondition(m.condition ?? {}).text} <code className="cond__code">{condition(replay)}</code>
                </span>
              )}
              <UnitTag unit={m.unit} />
              {m.model && m.model !== m.unit && <span>{m.model}</span>}
              <span className="num">{m.date}</span>
              {m.outcome && <span className="chip">{m.outcome.replace(/_/g, " ")}</span>}
              {m.ticket_done && <span className="chip">ticket {m.ticket_done.replace(/_/g, " ")}</span>}
              {m.source === "mock" ? <span className="chip chip--sim">SIMULATED</span>
                : m.source === "illustration"
                  ? <span className="chip chip--ill" title={m.legend}>ILLUSTRATION · scripted</span>
                  : <span className="chip chip--real" title={m.legend}>REAL</span>}
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
            <button type="button" className={`btn ${cut ? "btn--on" : "btn--quiet"}`} onClick={toggleCut}
              aria-pressed={cut}
              title={`Director's cut: the whole run in ${fmt(cutLength)}, key moments at 1×, the rest compressed (D)`}>
              <Icon name="next" /> Director's cut
            </button>
            <button type="button" className={`btn ${slidesOn ? "btn--on" : "btn--quiet"}`} onClick={toggleSlides}
              aria-pressed={slidesOn}
              title="Presenter mode: click the stage, →, PgDn or Space for the next key moment; ←, PgUp for the previous (P)">
              <Icon name="chevron" /> Presenter
            </button>
            <button type="button" className={`btn ${recording ? "btn--rec" : ""}`} onClick={toggleRecord}
              disabled={(!compare && view !== "floor") || !format} title={recTitle}>
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
        <div className="stage-area" onClick={onStageClick}>
          {compare && engineB ? (
            <div className="compare-wrap">
              <div className="compare-head" aria-label="Compared runs">
                {sideHead(0)}
                <div className="compare-head__moment" aria-live="polite">
                  {sharedLabel ? <><span className="muted">Key moment · </span>{sharedLabel}</> : <span className="muted">Start</span>}
                </div>
                {sideHead(1)}
              </div>
              <div className="compare">
                <div className="compare__pane">
                  <Stage ref={stageRef} engine={engine} largeSubtitles={presenting} overlay={overlayFor(0)}
                    label={`${m.run_id} · ${m.ticket ?? ""} ${condition(replay)}`} />
                </div>
                <div className="compare__pane">
                  <Stage ref={stageBRef} engine={engineB} largeSubtitles={presenting} overlay={overlayFor(1)}
                    label={`${compare.meta.run_id} · ${compare.meta.ticket ?? ""} ${condition(compare)}`} />
                  <button type="button" className="btn btn--quiet compare__close" onClick={onCloseCompare}>
                    <Icon name="close" /> Close compare
                  </button>
                </div>
              </div>
            </div>
          ) : view === "floor" ? (
            <div className="stage-frame">
              <Stage ref={stageRef} engine={engine} largeSubtitles={presenting} overlay={overlayFor(0)} />
            </div>
          ) : (
            <div className="stage-frame stage-frame--map">
              <AerialMap engine={engine} onOpenPlace={() => setView("floor")} />
            </div>
          )}
        </div>
      <footer className="controls">
        <Timeline replay={replay} clock={engine.clock} end={engine.end} onSeek={seekReplay} bands={bands} />
        <div className="controls__row">
          <div className="transport">
            <button type="button" className="icon-btn" onClick={goStart}
              aria-label="Go to the start (Home)" title="Go to the start (Home)">
              <Icon name="first" size={18} />
            </button>
            <button type="button" className="icon-btn"
              onClick={() => (slidesOn ? prevMoment() : stepEvent(-1))}
              aria-label={slidesOn ? "Previous key moment (Left arrow)" : "Previous event (Left arrow)"}
              title={slidesOn ? "Previous key moment (← / PgUp)" : "Previous event (←)"}>
              <Icon name="prev" size={18} />
            </button>
            <button type="button" className="icon-btn icon-btn--main" onClick={() => { c.toggle(); apply(); }}
              aria-label={moving ? "Pause (Space)" : "Play (Space)"} title="Play / pause (Space)">
              <Icon name={moving ? "pause" : "play"} size={18} />
            </button>
            <button type="button" className="icon-btn"
              onClick={() => (slidesOn ? nextMoment() : stepEvent(1))}
              aria-label={slidesOn ? "Next key moment (Right arrow)" : "Next event (Right arrow)"}
              title={slidesOn ? "Next key moment (→ / PgDn / Space / click)" : "Next event (→)"}>
              <Icon name="next" size={18} />
            </button>
            <button type="button" className="icon-btn" onClick={goEnd}
              aria-label="Go to the end (End)" title="Go to the end (End)">
              <Icon name="last" size={18} />
            </button>
            <span className="clock num" aria-live="off">
              {fmt(engine.clock)} <span className="muted">/ {fmt(engine.end)}</span>
            </span>
            {typeof m.duration_real_ms === "number" && (
              <span className="muted small" title="Gaps longer than 3 s are compressed to 1.5 s">
                real {fmt(m.duration_real_ms)}
              </span>
            )}
            {tb.cut && (
              <span className="cut-chip num" title="Director's cut: presentation clock">
                cut {fmt(c.p)} / {fmt(tb.end)}
              </span>
            )}
          </div>
          {slidesOn && slide && (
            <div className={`slide-counter tone-${slide.tone}`} aria-live="polite" title={slide.label}>
              <span className="slide-counter__dot" />
              <span className="num">{slideIdx} / {slideList.length - 1}</span>
              <span className="slide-counter__sep">·</span>
              <span className="slide-counter__label">{slide.label}</span>
            </div>
          )}
          <SpeedControl value={c.speed} onChange={(s) => { c.speed = s; refresh(); }} />
          <div className="keys muted small" aria-hidden="true">
            {slidesOn
              ? "→ PgDn Space click next moment · ← PgUp previous · Home End start/end · P exit slides · D cut · F present"
              : "Space play · 1–6 speed · ← → event · Home End start/end · P slides · D cut · F present · E events · M map"}
          </div>
        </div>
      </footer>
      {footer}
        </div>
        {showPanel && <EventsPanel replay={replay} applied={engine.state.applied} playing={moving}
          onSeek={seekReplay} />}
      </div>
    </div>
  );
}

