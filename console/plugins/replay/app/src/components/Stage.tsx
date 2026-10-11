// The office floor: pixel-souls' InteriorView (canvas 2D, pseudo-3D floor, characters that walk to their station)
// turned into the AI-SDLC Office stage. Everything drawn is a function of (replay, scene state, clock), so the same
// clock always renders the same frame: idle breathing, blinks, typing, talking and the CI reactions are keyed to the
// replay clock and the actor's seed, never to wall time or Math.random. Watermark and subtitles are painted into the
// canvas so recorded clips carry them too. One light palette (no dark variant, also in presentation mode).
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  ACCENT, FAIL, LIGHT, PASS, PORTRAIT_H, PORTRAIT_W, drawBadge, drawSystemObject, portraitGrid,
  type AvatarSpec, type LightState, type Palette,
} from "../engine/avatarStyles";
import { lastCiResult, poseFor, type CiReaction } from "../engine/motion";
import {
  bubbleVisible, isActive, narrationAt, walkProgress,
  type ActorView, type Bubble, type ReplayActor, type ReplayEngine, type ReplayPlace, type SceneConsumer,
} from "../engine/replay";
import {
  cardAt, editsAt, glassFor, isDimmed, ownerView, readsAt, restingSheets, travels, travelsAt, trayCount,
  type Travel, type TravelFrame,
} from "../engine/scene";
import { placeToFloor, projectFloorPoint, standingSpot } from "../engine/spatial";

export const STAGE_W = 1280;
export const STAGE_H = 720;
const HEADER_H = 40;
const FLOOR_TOP = 40;
const FLOOR_BOTTOM = 610;
const MARGIN_X = 40;
const FAR_WIDTH = 0.74;
export const FONT = '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
export const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';
const DEFAULT_CHECKS = 10;
const DEFAULT_CONSUMERS = ["billing-service", "analytics-ingest", "web-storefront"];
const SYSTEM_PLACES = new Set(["ci-tower", "staging-bench", "dispatch"]);
/** Device pixels per CSS pixel of the stage canvas (it is allocated at 2× STAGE_W). */
const DEVICE = 2;
/** Characters are about this wide at the front of the floor (scale 1), snapped to whole device pixels per grid pixel. */
const ACTOR_W = 124;

interface StageColors extends Palette {
  wall: string;
  floor: string;
  grid: string;
  subtitleBg: string;
  subtitleInk: string;
}

const STAGE_COLORS: StageColors = { ...LIGHT, wall: "#eceff3", floor: "#f6f7f9", grid: "#e3e6eb",
  subtitleBg: "#111827", subtitleInk: "#ffffff" };
/** Floor zones: neutral tints only (cyan and pink are reserved for pass/fail). Warm = before, cool grey = after. */
const ZONE_BEFORE = "#f1eee8";
const ZONE_AFTER = "#e8ecf1";
/** Aerial x of the seam between "before generation" and "after generation", and the aerial y where the back rows end. */
const ZONE_SPLIT_X = 0.5;
const ZONE_END_Y = 0.7;
/** The glass wall between the agent's area and the other teams' desks (aerial coordinates). */
const GLASS_Y = 0.735;
const GLASS_X0 = 0.0;
const GLASS_X1 = 0.53;
const DIM_ALPHA = 0.32;
/** Code owners sit beside their desk (floor x offset). */
const OWNER_DX = 0.062;
const DIFF_ADD_BG = "#e0e7ff";
const DIFF_DEL_BG = "#eef0f3";

export interface StageHandle {
  draw: () => void;
  canvas: () => HTMLCanvasElement | null;
}

/** A caption painted top-center into the frame (the director's cut montage, a presenter slide title). */
export interface StageOverlay {
  title: string;
  lines?: string[];
}

interface Props {
  engine: ReplayEngine;
  largeSubtitles: boolean;
  label?: string;
  overlay?: StageOverlay | null;
}

function floorToPixel(x: number, y: number) {
  const proj = projectFloorPoint({ x, y }, FAR_WIDTH);
  return {
    px: MARGIN_X + proj.screenX * (STAGE_W - MARGIN_X * 2),
    py: FLOOR_TOP + proj.screenY * (FLOOR_BOTTOM - FLOOR_TOP),
    scale: proj.scale,
  };
}

function fmtClock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

export const Stage = forwardRef<StageHandle, Props>(function Stage({ engine, largeSubtitles, label, overlay }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const opts = useRef({ largeSubtitles, label, overlay });
  opts.current = { largeSubtitles, label, overlay };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = STAGE_W * DEVICE;
    canvas.height = STAGE_H * DEVICE;
  }, []);

  function draw() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.setTransform(DEVICE, 0, 0, DEVICE, 0, 0);
    renderFrame(ctx, engine, STAGE_COLORS, opts.current.largeSubtitles, opts.current.label, opts.current.overlay);
  }

  useImperativeHandle(ref, () => ({ draw, canvas: () => canvasRef.current }));

  useEffect(() => {
    draw();
    // fonts arrive asynchronously; redraw once they are ready so canvas text uses IBM Plex Sans
    document.fonts?.ready.then(() => draw()).catch(() => undefined);
  });

  return (
    <canvas
      ref={canvasRef}
      className="stage-canvas"
      role="img"
      aria-label={`Replay stage: ${engine.replay.meta.legend}, run ${engine.replay.meta.run_id}`}
    />
  );
});

interface Drawable {
  depth: number;
  draw: () => void;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface BubbleAnchor {
  x: number;
  y: number;
  bubble: Bubble;
  /** preferred placement; the layout still moves the bubble off labels and other bubbles */
  side?: "up" | "right";
  /** the speaker's own figure, kept clear when the bubble goes beside it */
  self?: Rect;
}

interface PlaceLabel {
  text: string;
  note: string | null;
  x: number;
  /** "bottom" labels sit above their prop (y = text bottom); "top" labels hang under a system object (y = text top) */
  y: number;
  anchor: "bottom" | "top";
  size: number;
  noteSize: number;
  /** nobody uses the place in this run */
  dim?: boolean;
}

/** Per-frame layout state: what is already on screen, so labels and bubbles can avoid it. */
interface Layout {
  obstacles: Rect[];
  figures: Rect[];
  bubbles: BubbleAnchor[];
  labels: PlaceLabel[];
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const travelCache = new WeakMap<object, Travel[]>();

function travelsOf(replay: ReplayEngine["replay"]): Travel[] {
  let t = travelCache.get(replay);
  if (!t) {
    t = travels(replay);
    travelCache.set(replay, t);
  }
  return t;
}

function renderFrame(ctx: CanvasRenderingContext2D, engine: ReplayEngine, c: StageColors, bigSubs: boolean,
  label?: string, overlay?: StageOverlay | null) {
  const { replay, state, clock } = engine;
  const placeById = new Map(replay.places.map((p) => [p.id, p]));
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);
  ctx.fillStyle = c.wall;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  drawFloor(ctx, c);
  const zoneTags = replay.scene ? drawZones(ctx, c) : [];
  drawHeader(ctx, engine, c, label);

  const drawables: Drawable[] = [];
  const layout: Layout = { obstacles: [...zoneTags], figures: [], bubbles: [], labels: [] };
  const ci = lastCiResult(engine);
  const glass = glassFor(replay);
  const consumers = replay.scene?.consumers ?? [];
  // the other teams' desks: behind glass from the agent's desk (M1 only: a scene with a visibility)
  if (replay.scene && glass.v && consumers.some((k) => placeById.has(k.desk))) {
    const gy = placeToFloor({ x: 0, y: GLASS_Y }).y;
    drawables.push({ depth: gy, draw: () => drawGlass(ctx, glass.clear, glass.v as string, c, layout) });
  }
  // fictional code owners seated at the other teams' desks (only where the run has nobody of its own)
  for (const k of consumers) {
    const desk = placeById.get(k.desk);
    if (!k.owner || !desk || isDimmed(replay, k.desk)) continue;
    // seated beside their desk (not in front of it), so the desk and its monitors stay visible
    const spot = standingSpot(desk, 0, 1);
    spot.x += OWNER_DX;
    spot.y -= 0.03;
    const fig = figureGeometry({ ...spot, walking: false, facing: 1 }, clock, null);
    layout.figures.push(fig.rect);
    drawables.push({ depth: spot.y, draw: () => drawOwner(ctx, engine, k, fig, c, layout) });
  }

  // Who stands where (slots per place, deterministic order)
  const byPlace = new Map<string, string[]>();
  for (const a of replay.actors) {
    if (a.actor_type === "system" && SYSTEM_PLACES.has(a.home)) continue;
    const v = state.actors[a.id];
    if (!v) continue;
    const list = byPlace.get(v.place) ?? [];
    list.push(a.id);
    byPlace.set(v.place, list);
  }
  for (const list of byPlace.values()) list.sort();

  // Figures first (positions only), so place labels and bubbles know where people are before anything is drawn.
  for (const a of replay.actors) {
    const v = state.actors[a.id];
    if (!v) continue;
    if (a.actor_type === "system" && SYSTEM_PLACES.has(a.home)) continue;
    const pos = actorPosition(a.id, v, clock, placeById, byPlace);
    if (!pos) continue;
    const fig = figureGeometry(pos, clock, ci);
    layout.figures.push(fig.rect);
    drawables.push({ depth: pos.y, draw: () => drawActor(ctx, a, v, fig, clock, ci, c, layout) });
  }

  // Places (props, system objects); their labels are collected and drawn on top
  for (const place of replay.places) {
    const f = placeToFloor(place);
    drawables.push({ depth: f.y, draw: () => drawPlace(ctx, place, engine, c, layout) });
  }

  drawables.sort((p, q) => p.depth - q.depth);
  for (const d of drawables) d.draw();

  // what the scene adds on top of the floor: reads and edits in another team's folder, sheets and packets
  const agentPos = agentScreenPos(engine, placeById, byPlace);
  for (const k of consumers) drawConsumerMarks(ctx, engine, k, agentPos, placeById, c, layout);
  drawResting(ctx, engine, placeById, c, layout);
  for (const f of travelsAt(travelsOf(replay), clock)) drawTravel(ctx, f, placeById, c);

  for (const l of layout.labels) drawPlaceLabel(ctx, l, c, layout);
  const card = cardAt(replay, clock);
  if (card) drawDiffCard(ctx, engine, card, placeById, c, layout);
  layoutBubbles(ctx, layout, c);

  if (overlay) drawOverlay(ctx, overlay, c);
  const narration = narrationAt(state, clock, engine.end);
  if (narration) drawSubtitle(ctx, narration, c, bigSubs);
  drawWatermark(ctx, replay.meta, c);
}

/** Pixel position (front of the prop, top of the prop) of a place on the floor. */
function placePixel(p: ReplayPlace) {
  const f = placeToFloor(p);
  return floorToPixel(f.x, f.y);
}

function aerialToPixel(x: number, y: number) {
  return floorToPixel(x, placeToFloor({ x, y }).y);
}

/** Two floor zones (back rows): before generation (spec, context, the agent's desk) and after it (CI, merge gate). */
function drawZones(ctx: CanvasRenderingContext2D, c: StageColors): Rect[] {
  const rects: Rect[] = [];
  const quad = (x0: number, x1: number, y0: number, y1: number, fill: string) => {
    const a = aerialToPixel(x0, y0);
    const b = aerialToPixel(x1, y0);
    const d = aerialToPixel(x1, y1);
    const e = aerialToPixel(x0, y1);
    ctx.beginPath();
    ctx.moveTo(a.px, a.py);
    ctx.lineTo(b.px, b.py);
    ctx.lineTo(d.px, d.py);
    ctx.lineTo(e.px, e.py);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  ctx.save();
  quad(0, ZONE_SPLIT_X, 0.1, ZONE_END_Y, ZONE_BEFORE);
  quad(ZONE_SPLIT_X, 1, 0.1, ZONE_END_Y, ZONE_AFTER);
  // the seam
  const s0 = aerialToPixel(ZONE_SPLIT_X, 0.1);
  const s1 = aerialToPixel(ZONE_SPLIT_X, ZONE_END_Y);
  ctx.strokeStyle = c.lineStrong;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(s0.px, s0.py);
  ctx.lineTo(s1.px, s1.py);
  ctx.stroke();
  ctx.setLineDash([]);
  // labels on the back wall, above each zone
  ctx.textBaseline = "middle";
  const y = FLOOR_TOP + 14;
  const tag = (x: number, align: CanvasTextAlign, title: string, sub: string, fill: string) => {
    ctx.font = `600 12px ${FONT}`;
    const tw = ctx.measureText(title.toUpperCase()).width;
    ctx.font = `400 12px ${FONT}`;
    const sw = ctx.measureText(` · ${sub}`).width;
    const w = 14 + tw + sw;
    const x0 = align === "left" ? x : x - w;
    ctx.fillStyle = fill;
    ctx.fillRect(x0, y - 5, 10, 10);
    ctx.strokeStyle = c.lineStrong;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y - 4.5, 9, 9);
    ctx.textAlign = "left";
    ctx.fillStyle = c.ink2;
    ctx.font = `600 12px ${FONT}`;
    ctx.fillText(title.toUpperCase(), x0 + 14, y + 0.5);
    ctx.font = `400 12px ${FONT}`;
    ctx.fillText(` · ${sub}`, x0 + 14 + tw, y + 0.5);
    rects.push({ x: x0 - 2, y: y - 8, w: w + 4, h: 16 });
  };
  tag(aerialToPixel(0, 0.1).px, "left", "Before generation", "probabilistic: spec, context, the agent's desk",
    ZONE_BEFORE);
  tag(aerialToPixel(1, 0.1).px, "right", "After generation", "deterministic: CI, merge gate", ZONE_AFTER);
  ctx.restore();
  return rects;
}

/** The glass between the agent's area and the other teams' desks: frosted in V0/V1, clear in V2. */
function drawGlass(ctx: CanvasRenderingContext2D, clear: boolean, v: string, c: StageColors, layout: Layout) {
  const a = aerialToPixel(GLASS_X0 + 0.01, GLASS_Y);
  const b = aerialToPixel(GLASS_X1, GLASS_Y);
  const h = 50 * a.scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(a.px, a.py - h, b.px - a.px, h);
  ctx.fillStyle = clear ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.7)";
  ctx.fill();
  ctx.clip();
  if (!clear) {
    // frost: fine diagonal hatching
    ctx.strokeStyle = "rgba(17,24,39,0.07)";
    ctx.lineWidth = 1;
    for (let x = a.px - h; x < b.px; x += 5) {
      ctx.beginPath();
      ctx.moveTo(x, a.py);
      ctx.lineTo(x + h, a.py - h);
      ctx.stroke();
    }
  } else {
    // clear glass: a few glints
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    for (const f of [0.18, 0.21, 0.62]) {
      const x = a.px + (b.px - a.px) * f;
      ctx.beginPath();
      ctx.moveTo(x, a.py - 6);
      ctx.lineTo(x + h * 0.5, a.py - h + 4);
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = clear ? c.ink2 : c.lineStrong;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(a.px + 0.5, a.py - h + 0.5, b.px - a.px - 1, h - 1);
  // posts
  ctx.fillStyle = c.bodyShade;
  for (const f of [0, 1 / 3, 2 / 3, 1]) ctx.fillRect(a.px + (b.px - a.px) * f - 2, a.py - h, 4, h);
  ctx.font = `500 12px ${FONT}`;
  ctx.fillStyle = c.ink2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // the caption sits on the free floor just past the glass's end (the desks' own labels sit on the glass)
  const lines = clear
    ? [`Clear glass (${v})`, "the other teams' repos are in", "the agent's workspace"]
    : [`Frosted glass (${v})`, "the other teams' repos are not", "in the agent's workspace"];
  const tx = b.px + 14;
  const ty = a.py - h + 2;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  let tw = 0;
  lines.forEach((l, i) => {
    ctx.font = i === 0 ? `600 12px ${FONT}` : `400 12px ${FONT}`;
    ctx.fillStyle = i === 0 ? c.ink : c.ink2;
    ctx.fillText(l, tx, ty + i * 15);
    tw = Math.max(tw, ctx.measureText(l).width);
  });
  ctx.strokeStyle = clear ? c.ink2 : c.lineStrong;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(b.px + 6, ty + 2);
  ctx.lineTo(b.px + 6, ty + lines.length * 15 - 2);
  ctx.stroke();
  layout.obstacles.push({ x: tx - 4, y: ty - 2, w: tw + 8, h: lines.length * 15 + 4 });
  ctx.restore();
}

/** The agent's current on-screen anchor (head height), for lines from its desk to another team's desk. */
function agentScreenPos(engine: ReplayEngine, places: Map<string, ReplayPlace>, byPlace: Map<string, string[]>) {
  const { replay, state, clock } = engine;
  const id = replay.scene?.agent ?? replay.actors.find((a) => a.role === "code_agent")?.id;
  const v = id ? state.actors[id] : undefined;
  if (!id || !v) return null;
  const pos = actorPosition(id, v, clock, places, byPlace);
  if (!pos) return null;
  const fig = figureGeometry(pos, clock, null);
  return { x: fig.px, y: fig.y + fig.h * 0.35 };
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function pill(ctx: CanvasRenderingContext2D, cx: number, y: number, text: string, fill: string, ink: string,
  layout: Layout, size = 11): Rect {
  ctx.save();
  ctx.font = `600 ${size}px ${FONT}`;
  const w = ctx.measureText(text).width + 12;
  const h = size + 7;
  const x = Math.round(cx - w / 2);
  ctx.fillStyle = fill;
  ctx.fillRect(x, Math.round(y), Math.round(w), h);
  ctx.fillStyle = ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, y + h / 2 + 0.5);
  ctx.restore();
  const r = { x, y, w, h };
  layout.obstacles.push(r);
  return r;
}

/** A dotted line agent → desk while it reads that team's code (V2); a pink mark when it edits it. */
function drawConsumerMarks(ctx: CanvasRenderingContext2D, engine: ReplayEngine, k: SceneConsumer,
  agent: { x: number; y: number } | null, places: Map<string, ReplayPlace>, _c: StageColors, layout: Layout) {
  const desk = places.get(k.desk);
  if (!desk) return;
  const { px, py, scale } = placePixel(desk);
  const top = py - 4 * scale - 22 * scale - 26 * scale;
  const reads = readsAt(k, engine.clock);
  if (reads.count && agent) {
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = reads.flash ? 2.5 : 1.5;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(agent.x, agent.y);
    ctx.lineTo(px, top);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    const label = `read ${shortPath(reads.last ?? "")}${reads.count > 1 ? ` +${reads.count - 1}` : ""}`;
    pill(ctx, (agent.x + px) / 2, (agent.y + top) / 2 - 9, label, "#ffffff", ACCENT, layout);
  }
  const edits = editsAt(k, engine.clock);
  if (edits.length) {
    ctx.save();
    ctx.strokeStyle = FAIL;
    ctx.lineWidth = 3;
    const w = 140 * scale;
    ctx.strokeRect(px - w / 2, top - 6 * scale, w, py - top + 4 * scale);
    ctx.restore();
    const text = `edited by the agent: ${shortPath(edits[0])}${edits.length > 1 ? ` +${edits.length - 1}` : ""}`;
    pill(ctx, px, py + 2, text, FAIL, "#ffffff", layout);
  }
}

/** Maya's sheets after they land: the spec rules on the agent's desk, the fitness functions on the CI tower. */
function drawResting(ctx: CanvasRenderingContext2D, engine: ReplayEngine, places: Map<string, ReplayPlace>,
  c: StageColors, layout: Layout) {
  for (const s of restingSheets(engine.replay, engine.clock)) {
    const p = places.get(s.to);
    if (!p) continue;
    const { px, py, scale } = placePixel(p);
    const x = s.to === "ci-tower" ? px + 30 * scale : px - 58 * scale;
    const y = s.to === "ci-tower" ? py - 26 * scale : py - 52 * scale;
    drawSheetIcon(ctx, x, y, 0.8 * scale, c);
    ctx.save();
    ctx.font = `500 ${Math.round(10 * Math.max(scale, 0.9))}px ${FONT}`;
    ctx.fillStyle = c.ink2;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const text = s.to === "ci-tower" ? s.label.split(" · ")[0] : s.label.split(" · ").slice(-1)[0];
    ctx.fillText(text, x + 12 * scale, y + 2);
    const tw = ctx.measureText(text).width;
    layout.obstacles.push({ x: x - 8, y: y - 10, w: tw + 24 * scale, h: 22 });
    ctx.restore();
  }
}

function drawSheetIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, c: StageColors) {
  const w = 16 * s;
  const h = 20 * s;
  ctx.save();
  ctx.fillStyle = c.surface;
  ctx.strokeStyle = c.ink2;
  ctx.lineWidth = 1.2;
  ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
  ctx.strokeRect(cx - w / 2 + 0.5, cy - h / 2 + 0.5, w - 1, h - 1);
  ctx.fillStyle = c.bodyShade;
  for (let i = 0; i < 4; i++) ctx.fillRect(cx - w / 2 + 3 * s, cy - h / 2 + (4 + i * 4) * s, w - 6 * s - (i % 2) * 3 * s, 1.5 * s);
  ctx.restore();
}

function drawEnvelopeIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, c: StageColors) {
  const w = 24 * s;
  const h = 16 * s;
  ctx.save();
  ctx.fillStyle = c.surface;
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1.4;
  ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
  ctx.strokeRect(cx - w / 2 + 0.5, cy - h / 2 + 0.5, w - 1, h - 1);
  ctx.beginPath();
  ctx.moveTo(cx - w / 2 + 1, cy - h / 2 + 1);
  ctx.lineTo(cx, cy + 1);
  ctx.lineTo(cx + w / 2 - 1, cy - h / 2 + 1);
  ctx.stroke();
  ctx.restore();
}

/** Sheets, the PR pickup, the CI output envelope and the event packets, flying in an arc between two places. */
function drawTravel(ctx: CanvasRenderingContext2D, f: TravelFrame, places: Map<string, ReplayPlace>, c: StageColors) {
  const { travel: tr, progress } = f;
  const a = places.get(tr.from);
  const b = places.get(tr.to);
  if (!a || !b) return;
  const pa = placePixel(a);
  const pb = placePixel(b);
  const ax = pa.px;
  // sheets leave from the front of the library's shelves; everything else from the top of its prop
  const ay = pa.py - (tr.kind === "sheet" ? 20 : 50) * pa.scale;
  const bx = pb.px;
  const by = pb.py - 50 * pb.scale;
  const along = (p: number) => {
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const lift = Math.sin(Math.PI * p) * Math.min(90, 30 + Math.hypot(bx - ax, by - ay) * 0.18);
    return { x: ax + (bx - ax) * e, y: Math.max(HEADER_H + 24, ay + (by - ay) * e - lift) };
  };
  const fail = tr.kind === "packet" && tr.status !== "pass";
  let pos;
  let alpha = 1;
  if (progress <= 1) {
    pos = along(progress);
  } else {
    // bounce back from where it broke: back along the path, damped, fading out
    const q = progress - 1;
    const back = Math.abs(Math.sin(q * Math.PI * 1.5)) * (1 - q) * 0.22;
    pos = along(1 - back);
    alpha = Math.max(0, 1 - q * 0.9);
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  const s = 1;
  if (tr.kind === "sheet" || tr.kind === "pickup") {
    drawSheetIcon(ctx, pos.x, pos.y, s, c);
    if (tr.kind === "sheet") {
      ctx.font = `500 11px ${FONT}`;
      ctx.fillStyle = c.ink;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(tr.label, pos.x + 12, pos.y);
    }
  } else if (tr.kind === "envelope") {
    drawEnvelopeIcon(ctx, pos.x, pos.y, s, c);
    ctx.font = `500 11px ${FONT}`;
    ctx.fillStyle = c.ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(tr.label, pos.x + 16, pos.y);
  } else {
    // the event (or request) the consumer receives; it turns pink where it breaks, cyan where it is accepted
    const arrived = progress >= 0.85;
    ctx.font = `600 11px ${MONO}`;
    const text = tr.label;
    const w = ctx.measureText(text).width + 14;
    const h = 18;
    const fill = arrived ? (fail ? FAIL : c.surface) : c.surface;
    const stroke = arrived ? (fail ? FAIL : PASS) : c.ink;
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = arrived ? 2 : 1.4;
    ctx.beginPath();
    ctx.roundRect(pos.x - w / 2, pos.y - h / 2, w, h, 9);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = arrived && fail ? "#ffffff" : c.ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, pos.x, pos.y + 0.5);
  }
  ctx.restore();
}

/** A fictional code owner at their desk, reacting to the oracle's verdict for their service. */
function drawOwner(ctx: CanvasRenderingContext2D, engine: ReplayEngine, k: SceneConsumer, fig: Figure,
  c: StageColors, layout: Layout) {
  const owner = k.owner;
  if (!owner) return;
  const { clock, replay } = engine;
  const view = ownerView(replay, k, clock);
  const idle: ActorView = { place: k.desk, from: k.desk, movedAt: -Infinity, bubble: null, activeAt: -Infinity,
    gateMark: null };
  const pose = poseFor(owner.seed, idle, clock, false, null);
  if (view.mood === "worried") {
    pose.expression = "worried";
    pose.blink = false;
  } else if (view.mood === "relieved") {
    pose.expression = "happy";
  }
  const { px, py, w, h, x, y } = fig;
  ctx.save();
  ctx.fillStyle = "rgba(17,24,39,0.14)";
  ctx.beginPath();
  ctx.ellipse(px, py, w * 0.36, w * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.imageSmoothingEnabled = false;
  const grid = portraitGrid({ style: "human", seed: owner.seed, role: "code_owner", badge: null }, pose);
  ctx.drawImage(grid, x, y, w, h);
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const nameSize = Math.round(13 * Math.max(fig.scale, 0.9));
  ctx.font = `500 ${nameSize}px ${FONT}`;
  ctx.fillStyle = c.ink;
  const name = `${owner.name} · ${owner.title}`;
  ctx.fillText(name, px, py + 6);
  const nw = ctx.measureText(name).width;
  layout.obstacles.push({ x: px - nw / 2 - 2, y: py + 5, w: nw + 4, h: nameSize + 3 });
  const s2 = Math.round(11 * Math.max(fig.scale, 0.9));
  ctx.font = `400 ${s2}px ${FONT}`;
  ctx.fillStyle = c.ink2;
  ctx.fillText("fictional", px, py + 8 + nameSize);
  ctx.restore();

  if (view.alert) {
    const pass = view.alert.status === "pass";
    const version = view.alert.state === "gen" ? "first PR" : "final PR";
    const text = `${pass ? "✓" : "!"} ${version}: ${view.alert.text || (pass ? "pass" : "fail")}`;
    pill(ctx, px, y - 22, text, pass ? "#ffffff" : FAIL, pass ? "#0e7490" : "#ffffff", layout, 11);
    if (pass) {
      ctx.save();
      ctx.font = `600 11px ${FONT}`;
      const tw = ctx.measureText(text).width + 12;
      ctx.strokeStyle = PASS;
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(px - tw / 2) + 0.5, Math.round(y - 22) + 0.5, Math.round(tw) - 1, 17);
      ctx.restore();
    }
  }
}

/** The diff card of the key file, beside the agent's desk, from the run's own diff (diffs/<session>.diff). */
function drawDiffCard(ctx: CanvasRenderingContext2D, engine: ReplayEngine, card: NonNullable<ReturnType<typeof cardAt>>,
  places: Map<string, ReplayPlace>, c: StageColors, layout: Layout) {
  const desk = places.get(engine.replay.actors.find((a) => a.id === engine.replay.scene?.agent)?.home ?? "desk-orders");
  if (!desk) return;
  const { px, py, scale } = placePixel(desk);
  ctx.save();
  const lh = 17;
  ctx.font = `400 12px ${MONO}`;
  const lineW = Math.min(420, Math.max(...card.lines.map((l) => ctx.measureText(`${l.op} ${l.text}`).width)) + 20);
  ctx.font = `600 12px ${FONT}`;
  const title = `${card.file} · ${card.session}`;
  const stat = `+${card.added} −${card.removed}`;
  const w = Math.max(lineW, ctx.measureText(title).width + ctx.measureText(stat).width + 36);
  const h = 30 + card.lines.length * lh + (card.more ? lh : 0) + 6;
  // a fixed spot in the back-left corner (product desk and planning room, unused in M1 runs), clear of the lanes the
  // agent walks; a thin leader line points at the agent's desk
  const corner = aerialToPixel(0.015, 0.17);
  const x = Math.max(12, corner.px - 30);
  const y = HEADER_H + 34;
  ctx.strokeStyle = c.ink2;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(x + Math.min(w - 20, Math.max(20, px - x)), y + h);
  ctx.lineTo(px, py - 52 * scale);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = c.surface;
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1.5;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = c.ink;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(title, x + 10, y + 14);
  ctx.textAlign = "right";
  ctx.font = `500 12px ${FONT}`;
  ctx.fillStyle = c.ink2;
  ctx.fillText(stat, x + w - 10, y + 14);
  ctx.fillStyle = c.line;
  ctx.fillRect(x + 1, y + 27, w - 2, 1);
  ctx.textAlign = "left";
  ctx.font = `400 12px ${MONO}`;
  card.lines.forEach((l, i) => {
    const ly = y + 30 + i * lh;
    ctx.fillStyle = l.op === "+" ? DIFF_ADD_BG : DIFF_DEL_BG;
    ctx.fillRect(x + 1, ly, w - 2, lh - 1);
    ctx.fillStyle = l.op === "+" ? c.ink : c.ink2;
    let text = `${l.op} ${l.text}`;
    while (text.length > 4 && ctx.measureText(text).width > w - 20) text = `${text.slice(0, -2)}…`;
    ctx.fillText(text, x + 10, ly + lh / 2);
    if (l.op === "-") {
      const tw = ctx.measureText(text).width;
      ctx.fillRect(x + 22, ly + lh / 2, tw - 12, 1);
    }
  });
  if (card.more) {
    ctx.font = `400 11px ${FONT}`;
    ctx.fillStyle = c.ink2;
    ctx.fillText(`+${card.more} more changed line${card.more > 1 ? "s" : ""} · ${card.source}`, x + 10,
      y + 30 + card.lines.length * lh + lh / 2);
  }
  ctx.restore();
  layout.obstacles.push({ x, y, w, h });
}

function drawOverlay(ctx: CanvasRenderingContext2D, o: StageOverlay, c: StageColors) {
  ctx.save();
  ctx.font = `600 16px ${FONT}`;
  const lines = (o.lines ?? []).slice(0, 3);
  const tw = Math.max(ctx.measureText(o.title).width, ...lines.map((l) => {
    ctx.font = `400 13px ${FONT}`;
    return ctx.measureText(l).width;
  }));
  const w = Math.min(STAGE_W - 80, tw + 32);
  const h = 30 + lines.length * 19;
  const x = (STAGE_W - w) / 2;
  const y = HEADER_H + 6;
  ctx.fillStyle = c.surface;
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = 1.5;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = c.ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 16px ${FONT}`;
  ctx.fillText(o.title, STAGE_W / 2, y + 16);
  ctx.font = `400 13px ${FONT}`;
  ctx.fillStyle = c.ink2;
  lines.forEach((l, i) => ctx.fillText(l, STAGE_W / 2, y + 34 + i * 19));
  ctx.restore();
}

function drawFloor(ctx: CanvasRenderingContext2D, c: StageColors) {
  ctx.fillStyle = c.floor;
  const tl = floorToPixel(0, 0);
  const tr = floorToPixel(1, 0);
  const br = floorToPixel(1, 1);
  const bl = floorToPixel(0, 1);
  ctx.beginPath();
  ctx.moveTo(tl.px, tl.py);
  ctx.lineTo(tr.px, tr.py);
  ctx.lineTo(br.px, br.py);
  ctx.lineTo(bl.px, bl.py);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 1;
  ctx.stroke();
  // Depth gridlines (rows) and lanes (perspective) for a sense of ground plane.
  for (let i = 1; i < 6; i++) {
    const t = i / 6;
    const l = floorToPixel(0, t);
    const r = floorToPixel(1, t);
    ctx.beginPath();
    ctx.moveTo(l.px, l.py);
    ctx.lineTo(r.px, r.py);
    ctx.stroke();
  }
  for (let i = 1; i < 8; i++) {
    const x = i / 8;
    const a = floorToPixel(x, 0);
    const b = floorToPixel(x, 1);
    ctx.beginPath();
    ctx.moveTo(a.px, a.py);
    ctx.lineTo(b.px, b.py);
    ctx.stroke();
  }
}

function drawHeader(ctx: CanvasRenderingContext2D, engine: ReplayEngine, c: StageColors, label?: string) {
  const m = engine.replay.meta;
  const cond = ["V", "S", "W"].map((k) => m.condition?.[k as "V" | "S" | "W"]).filter(Boolean).join("·");
  ctx.save();
  ctx.fillStyle = c.ink;
  ctx.font = `600 15px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const title = label ?? `AI-SDLC Office · ${m.ticket ?? m.run_id}${cond ? ` · ${cond}` : ""}`;
  ctx.fillText(title, MARGIN_X - 16, HEADER_H / 2 + 2);
  ctx.textAlign = "right";
  ctx.font = `500 13px ${FONT}`;
  ctx.fillStyle = c.ink2;
  const phase = engine.state.phase ? `Phase: ${engine.state.phase}` : "";
  ctx.fillText(`${phase}${phase ? "   " : ""}${fmtClock(engine.clock)} / ${fmtClock(engine.end)}`,
    STAGE_W - MARGIN_X + 16, HEADER_H / 2 + 2);
  ctx.restore();
}

function actorPosition(id: string, v: ActorView, clock: number, places: Map<string, ReplayPlace>,
  byPlace: Map<string, string[]>) {
  const to = places.get(v.place);
  if (!to) return null;
  const list = byPlace.get(v.place) ?? [id];
  const spotTo = standingSpot(to, Math.max(0, list.indexOf(id)), list.length);
  // at a system object (the agent walking into the CI tower) stand beside it, so its lights stay visible
  // (with a PR tray on the tower's left, step to the tower's right instead)
  if (SYSTEM_PLACES.has(v.place)) spotTo.x += v.place === "ci-tower" && places.has("pr-tray") ? 0.1 : -0.115;
  // at the PR tray stand beside it, so the tray and its label stay visible
  if (v.place === "pr-tray") spotTo.x -= 0.07;
  const prog = walkProgress(v, clock);
  if (prog >= 1 || v.from === v.place) return { ...spotTo, walking: false, facing: 1 as 1 | -1 };
  const from = places.get(v.from);
  if (!from) return { ...spotTo, walking: false, facing: 1 as 1 | -1 };
  const spotFrom = standingSpot(from, 0, 1);
  // ease in-out so the walk reads as a walk, not a slide
  const e = prog < 0.5 ? 2 * prog * prog : 1 - Math.pow(-2 * prog + 2, 2) / 2;
  return {
    x: spotFrom.x + (spotTo.x - spotFrom.x) * e,
    y: spotFrom.y + (spotTo.y - spotFrom.y) * e,
    walking: true,
    facing: (spotTo.x >= spotFrom.x ? 1 : -1) as 1 | -1,
  };
}


interface Figure {
  px: number;
  py: number;
  scale: number;
  /** drawn size of the bust (CSS px) and its top-left corner */
  w: number;
  h: number;
  x: number;
  y: number;
  gridPx: number;
  facing: 1 | -1;
  walking: boolean;
  rect: Rect;
}

function figureGeometry(pos: { x: number; y: number; walking: boolean; facing: 1 | -1 }, clock: number,
  ci: CiReaction | null): Figure {
  const { px, py, scale } = floorToPixel(pos.x, pos.y);
  // whole device pixels per grid pixel keeps the pixel art crisp at every depth
  const k = Math.max(1, Math.round((ACTOR_W * scale * DEVICE) / PORTRAIT_W));
  const w = (k * PORTRAIT_W) / DEVICE;
  const h = (w * PORTRAIT_H) / PORTRAIT_W;
  const gridPx = k / DEVICE;
  let lift = 0;
  if (pos.walking) lift = Math.round(Math.abs(Math.sin(clock / 140)) * 2) * gridPx;
  else if (ci && ci.result === "pass" && clock >= ci.at && clock - ci.at < 900) {
    // a small deterministic hop when CI turns green
    lift = Math.round(Math.abs(Math.sin(((clock - ci.at) / 900) * Math.PI * 2)) * 3) * gridPx;
  }
  const x = Math.round((px - w / 2) * DEVICE) / DEVICE;
  const y = Math.round((py - 2 - h - lift) * DEVICE) / DEVICE;
  return {
    px, py, scale, w, h, x, y, gridPx, facing: pos.facing, walking: pos.walking,
    rect: { x: x + w * 0.12, y: y + h * 0.12, w: w * 0.76, h: h * 0.88 },
  };
}

function drawActor(ctx: CanvasRenderingContext2D, a: ReplayActor, v: ActorView, fig: Figure, clock: number,
  ci: CiReaction | null, c: StageColors, layout: Layout) {
  const { px, py, w, h, x, y, gridPx } = fig;
  const isAgent = a.avatar.style === "agent";

  // feet shadow, or the pink ring when this actor touched the gate (spec 13.2: "marked in pink")
  ctx.save();
  ctx.fillStyle = "rgba(17,24,39,0.14)";
  ctx.beginPath();
  ctx.ellipse(px, py, w * 0.36, w * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();
  if (v.gateMark) {
    ctx.strokeStyle = FAIL;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(px, py, w * 0.48, w * 0.14, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  const spec: AvatarSpec = {
    style: isAgent ? "agent" : "human", seed: a.avatar.seed, role: a.role, badge: a.avatar.badge ?? null,
  };
  const grid = portraitGrid(spec, poseFor(a.id, v, clock, fig.walking, ci));
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (fig.walking && fig.facing < 0) {
    ctx.translate(x + w, y);
    ctx.scale(-1, 1);
    ctx.drawImage(grid, 0, 0, w, h);
  } else {
    ctx.drawImage(grid, x, y, w, h);
  }
  ctx.restore();

  let ny = py + 6;
  if (isAgent) {
    const bs = Math.max(fig.scale, 0.8);
    const badgeY = y + h - 2 * gridPx;
    drawBadge(ctx, px, badgeY, a.avatar.badge, bs, FONT);
    ny = Math.max(ny, badgeY + Math.max(13, 15 * bs) + 3);
  }
  if (v.gateMark) ny = Math.max(ny, py + w * 0.14 + 3); // below the pink ring

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const nameSize = Math.round(13 * Math.max(fig.scale, 0.9));
  ctx.font = `500 ${nameSize}px ${FONT}`;
  ctx.fillStyle = c.ink;
  ctx.fillText(a.display_name, px, ny);
  const nw = ctx.measureText(a.display_name).width;
  layout.obstacles.push({ x: px - nw / 2 - 2, y: ny - 1, w: nw + 4, h: nameSize + 3 });
  ny += nameSize + 3;
  if (a.simulated) {
    const s2 = Math.round(12 * Math.max(fig.scale, 0.9));
    ctx.font = `400 ${s2}px ${FONT}`;
    ctx.fillStyle = c.ink2;
    ctx.fillText("simulated by policy", px, ny);
    const sw = ctx.measureText("simulated by policy").width;
    layout.obstacles.push({ x: px - sw / 2 - 2, y: ny - 1, w: sw + 4, h: s2 + 3 });
    ny += s2 + 2;
  }
  if (v.gateMark) {
    ctx.font = `600 11px ${FONT}`;
    const t = `Gate touched · ${v.gateMark}`;
    const tw = ctx.measureText(t).width + 10;
    ctx.fillStyle = FAIL;
    ctx.fillRect(Math.round(px - tw / 2), Math.round(ny), Math.round(tw), 16);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(t, px, ny + 8.5);
    layout.obstacles.push({ x: px - tw / 2, y: ny, w: tw, h: 16 });
  }
  ctx.restore();

  if (bubbleVisible(v, clock) && v.bubble) {
    layout.bubbles.push({ x: px, y: y + 4 * gridPx, bubble: v.bubble, self: fig.rect });
  }
}

function drawPlace(ctx: CanvasRenderingContext2D, place: ReplayPlace, engine: ReplayEngine, c: StageColors,
  layout: Layout) {
  const f = placeToFloor(place);
  const { px, py, scale } = floorToPixel(f.x, f.y);
  const { state, clock, replay } = engine;
  let top = py - 40 * scale;
  let owner: ActorView | undefined;
  let note = place.note && place.kind === "stage" ? place.note : null;
  const dim = isDimmed(replay, place.id);
  ctx.save();
  if (dim) ctx.globalAlpha = DIM_ALPHA;

  if (place.id === "pr-tray") {
    top = drawTray(ctx, px, py, scale, trayCount(replay, clock), c);
    note = place.note ?? null;
  } else if (place.id === "ci-tower") {
    const order = state.ci.order;
    const n = Math.max(order.length, DEFAULT_CHECKS);
    const lights: LightState[] = [];
    for (let i = 0; i < n; i++) lights.push(order[i] ? state.ci.lights[order[i]] ?? "idle" : "idle");
    owner = actorFor(replay.actors, state.actors, "ci");
    top = drawSystemObject(ctx, "tower", px, py, scale, {
      lights, beacon: state.ci.result, running: state.ci.running, active: owner ? isActive(owner, clock) : false,
    }, c);
    // label failing checks next to their light so "which rule" is readable at a glance
    const failing = order.filter((id) => state.ci.lights[id] === "fail" || state.ci.lights[id] === "error");
    if (failing.length) {
      ctx.save();
      const fs = Math.round(12 * scale);
      ctx.font = `600 ${fs}px ${FONT}`;
      ctx.fillStyle = FAIL;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      failing.slice(0, 4).forEach((id, i) => {
        const ly = top + 40 * scale + i * 15 * scale;
        ctx.fillText(id, px - 34 * scale, ly);
        const tw = ctx.measureText(id).width;
        layout.obstacles.push({ x: px - 34 * scale - tw - 2, y: ly - fs / 2 - 1, w: tw + 4, h: fs + 2 });
      });
      ctx.restore();
    }
    layout.obstacles.push({ x: px - 34 * scale, y: top, w: 68 * scale, h: py - top });
    if (state.ci.attempts > 0) note = `attempt ${state.ci.attempt ?? state.ci.attempts - 1}${state.ci.running ? " · running" : ""}`;
  } else if (place.id === "staging-bench") {
    const consumers = state.staging.consumers.length ? state.staging.consumers : DEFAULT_CONSUMERS;
    const lights: LightState[] = consumers.map((k) => state.staging.results[k] ?? "idle");
    owner = actorFor(replay.actors, state.actors, "staging");
    top = drawSystemObject(ctx, "bench", px, py, scale, { lights, active: owner ? isActive(owner, clock) : false }, c);
    ctx.save();
    ctx.font = `500 ${Math.round(10 * scale)}px ${FONT}`;
    ctx.fillStyle = c.ink2;
    ctx.textAlign = "center";
    const slot = (130 * scale) / consumers.length;
    consumers.forEach((k, i) => ctx.fillText(k.split("-")[0], px - 65 * scale + slot * (i + 0.5), top - 4));
    ctx.restore();
    layout.obstacles.push({ x: px - 65 * scale, y: top - 16 * scale, w: 130 * scale, h: py - top + 16 * scale });
    if (state.staging.state) note = `hidden from the agent · ${state.staging.state}`;
  } else if (place.id === "dispatch") {
    owner = actorFor(replay.actors, state.actors, "flow_engine");
    top = drawSystemObject(ctx, "board", px, py, scale, { active: owner ? isActive(owner, clock) : false }, c);
  } else {
    top = drawProp(ctx, place, px, py, scale, c);
    const agentHome = replay.actors.find((a) => a.id === replay.scene?.agent)?.home;
    if (place.id === agentHome && glassFor(replay).contracts) {
      // V1: the consumers' contracts were copied into the agent's repo; a stack of sheets on its desk
      const sx = px + 46 * scale;
      const sy = py - 30 * scale;
      for (let i = 2; i >= 0; i--) drawSheetIcon(ctx, sx + i * 3, sy - i * 3, 0.85 * scale, c);
      ctx.font = `500 ${Math.round(10 * Math.max(scale, 0.9))}px ${FONT}`;
      ctx.fillStyle = c.ink2;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("consumer contracts (V1)", sx + 14, sy + 14 * scale);
      layout.obstacles.push({ x: sx - 8, y: sy - 18, w: 150, h: 36 });
    }
  }
  ctx.restore();

  const size = Math.round(14 * Math.max(scale, 0.9));
  const noteSize = Math.round(12 * Math.max(scale, 0.9));
  const anchored = SYSTEM_PLACES.has(place.id) || place.id === "pr-tray";
  layout.labels.push(anchored
    ? { text: place.label, note, x: px, y: py + 6, anchor: "top", size, noteSize, dim }
    : { text: place.label, note: null, x: px, y: top - 6, anchor: "bottom", size, noteSize, dim });

  if (owner && bubbleVisible(owner, clock) && owner.bubble) {
    layout.bubbles.push(place.id === "ci-tower"
      ? { x: px + 36 * scale, y: top + 50 * scale, bubble: owner.bubble, side: "right" }
      : { x: px, y: top - 8, bubble: owner.bubble });
  }
}

/**
 * Place labels are drawn above everything on the floor; one that would sit behind a person's head moves up just
 * above that head instead, so a desk label is never hidden by whoever is working there.
 */
function drawPlaceLabel(ctx: CanvasRenderingContext2D, l: PlaceLabel, c: StageColors, layout: Layout) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = `600 ${l.size}px ${FONT}`;
  const w = ctx.measureText(l.text).width;
  let top = l.anchor === "bottom" ? l.y - l.size : l.y;
  for (let pass = 0; pass < 3; pass++) {
    const r = { x: l.x - w / 2 - 3, y: top - 1, w: w + 6, h: l.size + 3 };
    const hit = layout.figures.find((f) => overlap(r, f) > 0);
    if (!hit) break;
    top = hit.y - l.size - 4;
  }
  ctx.textBaseline = "top";
  ctx.fillStyle = c.ink2;
  if (l.dim) ctx.globalAlpha = 0.5;
  ctx.fillText(l.text, l.x, top);
  layout.obstacles.push({ x: l.x - w / 2 - 3, y: top - 1, w: w + 6, h: l.size + 3 });
  if (l.note) {
    ctx.font = `400 ${l.noteSize}px ${FONT}`;
    const ny = top + l.size + 2;
    ctx.fillText(l.note, l.x, ny);
    const nw = ctx.measureText(l.note).width;
    layout.obstacles.push({ x: l.x - nw / 2 - 3, y: ny - 1, w: nw + 6, h: l.noteSize + 3 });
  }
  ctx.restore();
}

function actorFor(actors: ReplayActor[], views: Record<string, ActorView>, role: string): ActorView | undefined {
  const a = actors.find((x) => x.role === role);
  return a ? views[a.id] : undefined;
}

/** The PR tray beside the CI tower (no reviewer in the run): a stand with one sheet per PR version pushed. */
function drawTray(ctx: CanvasRenderingContext2D, px: number, py: number, s: number, count: number,
  c: StageColors): number {
  ctx.save();
  const by = py - 4 * s;
  ctx.fillStyle = c.bodyShade;
  ctx.fillRect(px - 3 * s, by - 34 * s, 6 * s, 34 * s);
  ctx.fillRect(px - 16 * s, by - 3 * s, 32 * s, 3 * s);
  const tw = 54 * s;
  const ty = by - 40 * s;
  ctx.fillStyle = c.body;
  ctx.strokeStyle = c.lineStrong;
  ctx.lineWidth = 1.5;
  ctx.fillRect(px - tw / 2, ty, tw, 8 * s);
  ctx.strokeRect(px - tw / 2 + 0.5, ty + 0.5, tw - 1, 8 * s - 1);
  const n = Math.min(count, 4);
  for (let i = 0; i < n; i++) {
    const x = px - 16 * s + i * 3 * s;
    const y = ty - 4 * s - i * 3 * s;
    ctx.fillStyle = c.surface;
    ctx.strokeStyle = c.ink2;
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, 30 * s, 6 * s);
    ctx.strokeRect(x + 0.5, y + 0.5, 30 * s - 1, 6 * s - 1);
  }
  if (count > 0) {
    ctx.font = `600 ${Math.round(11 * Math.max(s, 0.9))}px ${FONT}`;
    ctx.fillStyle = c.ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(count === 1 ? "PR" : `PR v${count}`, px + 20 * s, ty - 8 * s);
  }
  ctx.restore();
  return ty - 4 * s - n * 3 * s;
}

function drawProp(ctx: CanvasRenderingContext2D, place: ReplayPlace, px: number, py: number, s: number,
  c: StageColors): number {
  ctx.save();
  let top = py;
  const by = py - 4 * s; // the prop sits just behind the standing spot
  if (place.kind === "desk") {
    const w = 120 * s;
    const h = 22 * s;
    ctx.fillStyle = c.bodyShade;
    ctx.fillRect(px - w / 2 + 6 * s, by, 5 * s, 18 * s);
    ctx.fillRect(px + w / 2 - 11 * s, by, 5 * s, 18 * s);
    ctx.fillStyle = c.body;
    ctx.fillRect(px - w / 2, by - h, w, h);
    ctx.strokeStyle = c.lineStrong;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px - w / 2 + 0.5, by - h + 0.5, w - 1, h - 1);
    // two monitors
    for (const dx of [-24, 24]) {
      ctx.fillStyle = c.surface;
      ctx.fillRect(px + dx * s - 17 * s, by - h - 26 * s, 34 * s, 22 * s);
      ctx.strokeRect(px + dx * s - 17 * s + 0.5, by - h - 26 * s + 0.5, 34 * s - 1, 22 * s - 1);
      ctx.fillStyle = c.bodyShade;
      ctx.fillRect(px + dx * s - 2 * s, by - h - 4 * s, 4 * s, 4 * s);
    }
    top = by - h - 26 * s;
  } else if (place.kind === "room") {
    const w = 150 * s;
    const h = 38 * s;
    ctx.fillStyle = c.body;
    ctx.strokeStyle = c.lineStrong;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(px, by - h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // sheets on the table
    ctx.fillStyle = c.surface;
    ctx.fillRect(px - 26 * s, by - h / 2 - 7 * s, 18 * s, 13 * s);
    ctx.fillRect(px + 8 * s, by - h / 2 - 5 * s, 18 * s, 13 * s);
    top = by - h;
  } else if (place.kind === "library") {
    const w = 128 * s;
    const h = 70 * s;
    ctx.fillStyle = c.body;
    ctx.fillRect(px - w / 2, by - h, w, h);
    ctx.strokeStyle = c.lineStrong;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px - w / 2 + 0.5, by - h + 0.5, w - 1, h - 1);
    const shades = [c.ink2, c.bodyShade, c.lineStrong, c.ink2, c.bodyShade];
    for (let r = 0; r < 3; r++) {
      const sy = by - h + 6 * s + r * 21 * s;
      ctx.fillStyle = c.lineStrong;
      ctx.fillRect(px - w / 2 + 4 * s, sy + 16 * s, w - 8 * s, 2 * s);
      let x = px - w / 2 + 8 * s;
      let i = r;
      while (x < px + w / 2 - 14 * s) {
        const bw = (6 + ((i * 7) % 5)) * s;
        ctx.fillStyle = shades[i % shades.length];
        ctx.fillRect(x, sy + (i % 3) * s, bw, 16 * s - (i % 3) * s);
        x += bw + 2 * s;
        i++;
      }
    }
    top = by - h;
  } else if (place.kind === "gate") {
    const w = 110 * s;
    const h = 64 * s;
    ctx.fillStyle = c.bodyShade;
    ctx.fillRect(px - w / 2, by - h, 10 * s, h);
    ctx.fillRect(px + w / 2 - 10 * s, by - h, 10 * s, h);
    ctx.fillStyle = c.body;
    ctx.strokeStyle = c.lineStrong;
    ctx.lineWidth = 1.5;
    ctx.fillRect(px - w / 2 + 10 * s, by - h * 0.62, w - 20 * s, 10 * s);
    ctx.strokeRect(px - w / 2 + 10 * s + 0.5, by - h * 0.62 + 0.5, w - 20 * s - 1, 10 * s - 1);
    top = by - h;
  } else {
    ctx.fillStyle = c.body;
    ctx.fillRect(px - 40 * s, by - 30 * s, 80 * s, 30 * s);
    top = by - 30 * s;
  }
  ctx.restore();
  return top;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const out: string[] = [];
  const paragraphs = text.replace(/```/g, "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  for (const para of paragraphs) {
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width <= maxW) {
        line = test;
      } else {
        if (line) out.push(line);
        line = w;
        while (ctx.measureText(line).width > maxW && line.length > 4) {
          let cut = line.length - 1;
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxW) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      if (out.length >= maxLines) break;
    }
    if (out.length >= maxLines) break;
    if (line) out.push(line);
    if (out.length >= maxLines) break;
  }
  const truncated = out.length > maxLines || paragraphs.join(" ").length > out.join(" ").length + 1;
  const lines = out.slice(0, maxLines);
  if (truncated && lines.length) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}


interface BubbleBox {
  lines: string[];
  w: number;
  h: number;
  lh: number;
  code: boolean;
}

function measureBubble(ctx: CanvasRenderingContext2D, b: Bubble): BubbleBox | null {
  const code = b.tone === "code" || b.tone === "pass" || b.tone === "fail";
  const fontSize = 13;
  ctx.font = `400 ${fontSize}px ${code ? MONO : FONT}`;
  const maxW = code ? 330 : 300;
  const lines = wrap(ctx, b.text, maxW, code ? 4 : 3);
  if (!lines.length) return null;
  const lh = fontSize + 4;
  return { lines, code, lh, w: Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width))) + 20,
    h: lines.length * lh + 14 };
}

/**
 * Places every bubble where it covers the fewest labels, names, figures and earlier bubbles: above the speaker
 * first (sliding sideways and upwards), then beside it. Deterministic: candidates are tried in a fixed order.
 */
function layoutBubbles(ctx: CanvasRenderingContext2D, layout: Layout, c: StageColors) {
  const placed: Rect[] = [];
  const minY = HEADER_H + 4;
  const maxY = STAGE_H - 96;
  for (const b of layout.bubbles) {
    ctx.save();
    const box = measureBubble(ctx, b.bubble);
    ctx.restore();
    if (!box) continue;
    const { w, h } = box;
    // a label that moved above the speaker's head sits between head and bubble: aim the tail above it
    for (let pass = 0; pass < 2; pass++) {
      for (const o of layout.obstacles) {
        if (b.x >= o.x && b.x <= o.x + o.w && o.y < b.y && o.y + o.h >= b.y - 6) b.y = o.y - 3;
      }
    }
    const clampX = (x: number) => Math.max(8, Math.min(STAGE_W - w - 8, x));
    const clampY = (y: number) => Math.max(minY, Math.min(maxY - h, y));
    const cands: Rect[] = [];
    const sideGap = b.self ? b.self.w / 2 + 14 : 24;
    const beside = (dir: 1 | -1, dy: number): Rect => ({
      x: clampX(dir > 0 ? b.x + sideGap : b.x - sideGap - w), y: clampY(b.y - h / 2 + dy), w, h,
    });
    if (b.side === "right") for (const dy of [0, -30, 30, -60, 60]) cands.push(beside(1, dy));
    for (const dy of [0, 14, 28, 42, 56, 74]) {
      for (const dx of [-w / 2, -w + 34, -34]) cands.push({ x: clampX(b.x + dx), y: clampY(b.y - h - 12 - dy), w, h });
    }
    for (const dy of [-20, 0, -44]) {
      cands.push(beside(1, dy));
      cands.push(beside(-1, dy));
    }
    let best = cands[0];
    let bestScore = Infinity;
    cands.forEach((r, i) => {
      let score = i * 0.5; // prefer earlier candidates on a tie
      for (const o of layout.obstacles) score += overlap(r, o) * 4;
      for (const f of layout.figures) if (f !== b.self) score += overlap(r, f) * 1.5;
      if (b.self) score += overlap(r, b.self) * 6;
      for (const p of placed) score += overlap(r, p) * 8;
      if (score < bestScore) {
        bestScore = score;
        best = r;
      }
    });
    placed.push(best);
    drawBubble(ctx, b, box, best, c);
  }
}

function drawBubble(ctx: CanvasRenderingContext2D, b: BubbleAnchor, box: BubbleBox, r: Rect, c: StageColors) {
  const tone = b.bubble.tone;
  const { x, y, w, h } = r;
  ctx.save();
  ctx.font = `400 13px ${box.code ? MONO : FONT}`;
  const border = tone === "pass" ? PASS : tone === "fail" ? FAIL : c.lineStrong;
  ctx.fillStyle = c.surface;
  ctx.strokeStyle = border;
  ctx.lineWidth = tone === "pass" || tone === "fail" ? 2 : 1.5;
  if (tone === "thought") ctx.setLineDash([4, 3]);
  // tail on the edge facing the speaker, pointing at it (capped in length when the bubble had to move away)
  const L = x + 0.5;
  const R = x + w - 0.5;
  const T = y + 0.5;
  const B = y + h - 0.5;
  const tip = (bx: number, by: number): [number, number] => {
    const dx = b.x - bx;
    const dy = b.y - by;
    const d = Math.hypot(dx, dy) || 1;
    const len = Math.min(d, 22);
    return [bx + (dx / d) * len, by + (dy / d) * len];
  };
  const pts: [number, number][] = [];
  if (b.y > B) {
    const tx = Math.max(L + 12, Math.min(R - 12, b.x));
    pts.push([L, T], [R, T], [R, B], [tx + 7, B], tip(tx, B), [tx - 7, B], [L, B]);
  } else if (b.x < L) {
    const ty = Math.max(T + 10, Math.min(B - 10, b.y));
    pts.push([L, T], [R, T], [R, B], [L, B], [L, ty + 7], tip(L, ty), [L, ty - 7]);
  } else if (b.x > R) {
    const ty = Math.max(T + 10, Math.min(B - 10, b.y));
    pts.push([L, T], [R, T], [R, ty - 7], tip(R, ty), [R, ty + 7], [R, B], [L, B]);
  } else {
    const tx = Math.max(L + 12, Math.min(R - 12, b.x));
    pts.push([L, T], [tx - 7, T], tip(tx, T), [tx + 7, T], [R, T], [R, B], [L, B]);
  }
  ctx.beginPath();
  pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = c.ink;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  box.lines.forEach((l, i) => ctx.fillText(l, x + 10, y + 8 + i * box.lh));
  ctx.restore();
}

function drawSubtitle(ctx: CanvasRenderingContext2D, text: string, c: StageColors, big: boolean) {
  ctx.save();
  const size = big ? 26 : 18;
  ctx.font = `500 ${size}px ${FONT}`;
  const lines = wrap(ctx, text, big ? 1000 : 860, 2);
  const lh = size + 8;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 32;
  const h = lines.length * lh + 16;
  const x = (STAGE_W - w) / 2;
  const y = STAGE_H - 44 - h;
  ctx.fillStyle = c.subtitleBg;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = c.subtitleInk;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, STAGE_W / 2, y + 10 + i * lh));
  ctx.restore();
}

/** Permanent watermark, bottom-left, painted into every frame (and so into every recorded clip). */
function drawWatermark(ctx: CanvasRenderingContext2D, meta: ReplayEngine["replay"]["meta"], c: StageColors) {
  ctx.save();
  const h = 30;
  const y = STAGE_H - h - 8;
  const x = 8;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  if (meta.source === "mock") {
    ctx.font = `600 14px ${FONT}`;
    const legend = meta.legend || "SIMULATED (mock agent) — not a real run";
    const inner = ctx.measureText(legend).width + 20;
    const stripe = 26;
    const w = inner + stripe * 2;
    // amber/ink diagonal stripes = "attention: simulated"
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = "#f59e0b";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#111827";
    for (let sx = x - h; sx < x + w + h; sx += 12) {
      ctx.beginPath();
      ctx.moveTo(sx, y + h);
      ctx.lineTo(sx + 6, y + h);
      ctx.lineTo(sx + 6 + h, y);
      ctx.lineTo(sx + h, y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = "#111827";
    ctx.fillRect(x + stripe, y + 3, inner, h - 6);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(legend, x + stripe + 10, y + h / 2 + 0.5);
    ctx.font = `500 12px ${FONT}`;
    ctx.fillStyle = c.ink2;
    ctx.fillText(`${meta.run_id} · ${meta.unit} · ${meta.date}`, x + w + 10, y + h / 2 + 0.5);
  } else {
    ctx.font = `500 13px ${FONT}`;
    const text = `Replay of a real run · ${meta.run_id} · ${meta.unit} · ${meta.date}`;
    const w = ctx.measureText(text).width + 20;
    ctx.fillStyle = c.surface;
    ctx.fillRect(x, y + 3, w, h - 6);
    ctx.strokeStyle = c.lineStrong;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 3.5, w - 1, h - 7);
    ctx.fillStyle = c.ink;
    ctx.fillText(text, x + 10, y + h / 2 + 0.5);
  }
  ctx.restore();
}
