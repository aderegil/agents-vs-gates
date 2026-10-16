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
  type ActorView, type Bubble, type Illustration, type ReplayActor, type ReplayEngine, type ReplayPlace,
  type SceneConsumer, type SceneZone,
} from "../engine/replay";
import {
  cardAt, editsAt, glassFor, isDimmed, ownerView, readsAt, restingSheets, travels, travelsAt, trayCount,
  type Travel, type TravelFrame,
} from "../engine/scene";
import { lifecycleLabel, recastCitation } from "../engine/recast";
import { placeToFloor, projectFloorPoint, standingSpot } from "../engine/spatial";
import { unitText } from "./UnitTag";
import { runHeadline, runSource } from "./labels";
import type { QaBox, QaKind } from "../engine/overlap";
import { dimAmount, focusAt, type FocusFrame } from "../engine/focus";
import { OLDER_BUBBLE_ALPHA, bubbleAlpha, figureGridScale, shownBubbles } from "../engine/stagePolicy";

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
/** Device pixels per stage pixel when the canvas is not on screen (offscreen, size unknown). */
const DEVICE = 2;
/**
 * Device pixels per stage pixel this frame: the canvas is allocated at its displayed size × devicePixelRatio, so the
 * pixel art lands on whole device pixels (crisp at every integer grid scale) instead of being resampled by CSS.
 */
let device = DEVICE;
/** Presentation mode this frame: larger type, fewer labels (see fz). */
let present = false;
/** Font size for the stage: presentation mode scales every label up and never goes below 12 stage px (18 px on a
 * projected 1080p frame). */
function fz(n: number): number {
  return present ? Math.round(Math.max(12, n * 1.18)) : n;
}
/** QA (theater-1016): every text box and figure drawn in the last frame, for the overlap sweep and tests. */
let qaBoxes: QaBox[] = [];
export function stageQaBoxes(): QaBox[] {
  return qaBoxes;
}
function qa(kind: QaKind, r: { x: number; y: number; w: number; h: number }, owner?: string, text?: string) {
  qaBoxes.push({ kind, x: r.x, y: r.y, w: r.w, h: r.h, owner, text });
}
/** Characters are about this wide at the front of the floor (scale 1), snapped to whole device pixels per grid pixel.
 * theater-1016: 25% smaller than before (124 → 93), so the floor has room for the labels and the bubbles. */
// ACTOR_W and figureGridScale live in engine/stagePolicy.ts (tested in node)
/** The light of the current beat (engine/focus.ts), set per frame. */
let focus: FocusFrame = { level: 0, lit: new Map() };
/** Opacity for something that belongs to `key` ("actor:<id>", "place:<id>"): `floor` when fully out of focus. */
function fa(key: string | undefined, floor = 0.4): number {
  if (!key) return 1;
  return 1 - dimAmount(focus, key) * (1 - floor);
}
/** Out of focus, people also lose most of their colour (a calm grey, not a flash). */
function dimFilter(key: string): string {
  const d = dimAmount(focus, key);
  return d > 0.02 ? `saturate(${(1 - 0.75 * d).toFixed(3)})` : "none";
}
/** Smaller figures when the floor is crowded (the M2b sprint has ~20 people and agents); set per frame. */
let crowdScale = 1;

interface StageColors extends Palette {
  wall: string;
  floor: string;
  grid: string;
  subtitleBg: string;
  subtitleInk: string;
}

const STAGE_COLORS: StageColors = { ...LIGHT, wall: "#eceff3", floor: "#f6f7f9", grid: "#e3e6eb",
  subtitleBg: "#111827", subtitleInk: "#ffffff" };
/** Lifecycle columns: neutral tints only (cyan and pink are reserved for pass/fail). */
const ZONE_TINTS: Record<string, string> = {
  define: "#f3f0ea", build: "#eef0f2", verify: "#e8ecf1", production: "#f1efeb",
};
/** The glass wall between Build/Verify and the teams in Production: aerial x and its depth span. */
const GLASS_X = 0.69;
const GLASS_Y0 = 0.24;
const GLASS_Y1 = 0.8;
/** Zone titles are laid out on this floor row (aerial y), where the columns are wide enough to read. */
const TITLE_ROW = 0.55;
/** Floor rows where the lifecycle columns are tinted (aerial y). */
const ZONE_Y0 = 0.1;
const ZONE_Y1 = 0.98;
const DIM_ALPHA = 0.32;
/** The consumer teams sit behind their service's counter (floor y offset). */
const OWNER_BEHIND = 0.045;
const DIFF_ADD_BG = "#e0e7ff";
/** Where the rule lives as context (read before generation; probabilistic): the deck's purple, dashed. */
const RULE = "#7500c0";
/** Text on a cyan (pass / deterministic) surface. */
const PASS_INK = "#0e7490";
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

  // backing store = displayed size × devicePixelRatio (whole device pixels for the pixel art); 2× while unknown
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      const css = canvas.getBoundingClientRect().width;
      const ratio = css > 0 ? Math.min(3, Math.max(1, (css * (window.devicePixelRatio || 1)) / STAGE_W)) : DEVICE;
      const w = Math.round(STAGE_W * ratio);
      if (canvas.width !== w) {
        canvas.width = w;
        canvas.height = Math.round(STAGE_H * ratio);
        draw();
      }
    };
    fit();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    ro?.observe(canvas);
    return () => ro?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draw() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    device = canvas.width / STAGE_W || DEVICE;
    ctx.setTransform(device, 0, 0, device, 0, 0);
    ctx.imageSmoothingEnabled = true;
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
      aria-label={`Replay stage: ${engine.replay.meta.legend}, ${runSource(engine.replay.meta)}`}
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
  /** who speaks ("actor:<id>" or "place:<id>") */
  owner?: string;
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
  /** the place id */
  place?: string;
}

/** Per-frame layout state: what is already on screen, so labels and bubbles can avoid it. */
interface Layout {
  obstacles: Rect[];
  figures: Rect[];
  bubbles: BubbleAnchor[];
  labels: PlaceLabel[];
  /** the frame has lifecycle zone titles at the top */
  zones?: boolean;
  /** the glass caption, placed after the people are known (drawGlassCaption) */
  glass?: { lines: string[]; x: number; y: number; scale: number };
  /** drawn after every figure, before the place labels (the teams' labels and verdict pills) */
  late: (() => void)[];
  /** places where somebody of the run stands now (presentation mode drops their place label: the names say it) */
  occupied?: Set<string>;
  /** never covered by a label or a bubble (the subtitle of this frame) */
  reserved: Rect[];
}

/** Text with a halo in the surface color, so a label stays readable over lines, props and people. */
function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width = 3.5) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.globalAlpha = Math.min(1, ctx.globalAlpha * 1.4);
  ctx.strokeStyle = "rgba(255,255,255,0.94)";
  ctx.lineWidth = width;
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

/**
 * Collision avoidance for labels: of the candidate boxes (in order of preference), the one that covers the least.
 * Off the floor is out; other labels, pills and name tags weigh most, then people, then `extra` boxes.
 */
function bestRect(cands: Rect[], layout: Layout, extra: Rect[] = [], figW = 3, obstW = 4): Rect {
  let best = cands[0];
  let bestScore = Infinity;
  const pad = 5;
  cands.forEach((r, i) => {
    let score = i * 3;
    if (r.x < 4 || r.x + r.w > STAGE_W - 4 || r.y < HEADER_H + 2 || r.y + r.h > STAGE_H - 4) score += 1e6;
    for (const o of layout.reserved) if (overlap(r, o) > 0) score += 1e5;
    // a little air around every label: boxes that only touch still read as one block
    const q = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
    for (const o of layout.obstacles) score += overlap(q, o) * obstW;
    for (const f of layout.figures) score += overlap(r, f) * figW;
    for (const o of extra) score += overlap(q, o) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  });
  return best;
}

/**
 * More places to try around an anchor, nearest first: rings of 8 directions at growing distances. Callers put their
 * preferred spots first; these are the fallbacks when every preferred spot covers somebody.
 */
function ring(cx: number, cy: number, w: number, h: number, radii = [40, 80, 120, 170, 230, 300]): Rect[] {
  const out: Rect[] = [];
  for (const r of radii) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      out.push({ x: cx + Math.cos(a) * r * 1.4 - w / 2, y: cy + Math.sin(a) * r * 0.8 - h / 2, w, h });
    }
  }
  return out;
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
  present = bigSubs;
  qaBoxes = [];
  focus = focusAt(replay, clock);
  crowdScale = replay.actors.filter((a) => a.actor_type !== "system").length > 12 ? 0.82 : 1;
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);
  ctx.fillStyle = c.wall;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  drawFloor(ctx, c);
  const zones = replay.scene?.zones ?? [];
  if (zones.length) drawZones(ctx, zones, c);
  drawHeader(ctx, engine, c, label);

  const drawables: Drawable[] = [];
  const layout: Layout = { obstacles: [], figures: [], bubbles: [], labels: [], late: [], reserved: [] };
  // the subtitle's box is known before anything is placed: labels, callouts and bubbles stay out of it
  const sub = narrationAt(state, clock, engine.end);
  if (sub) layout.reserved.push(subtitleBox(ctx, sub, bigSubs).rect);
  if (zones.length) {
    layout.obstacles.push(...zoneTitleRects(ctx, zones));
    layout.zones = true;
  }
  const ci = lastCiResult(engine);
  const glass = glassFor(replay);
  const consumers = replay.scene?.consumers ?? [];
  // the other teams' desks: behind glass from the agent's desk (M1 only: a scene with a visibility)
  if (replay.scene && glass.v && consumers.some((k) => placeById.has(k.desk))) {
    const gy = placeToFloor({ x: 0, y: GLASS_Y0 }).y;
    drawables.push({ depth: gy, draw: () => drawGlass(ctx, glass.clear, glass.v as string, c, layout) });
  }
  // fictional code owners seated at the other teams' desks (only where the run has nobody of its own)
  for (const k of consumers) {
    const desk = placeById.get(k.desk);
    if (!k.owner || !desk || isDimmed(replay, k.desk)) continue;
    // seated behind their service's counter (drawn before it), facing the audience
    const f = placeToFloor(desk);
    const spot = { x: f.x, y: f.y - OWNER_BEHIND };
    const fig = figureGeometry({ ...spot, walking: false, facing: 1 }, clock, null);
    layout.figures.push(fig.rect);
    qa("figure", fig.rect, `place:${k.desk}`);
    drawables.push({ depth: spot.y, draw: () => drawOwner(ctx, engine, k, fig, desk, c, layout) });
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
  layout.occupied = new Set([...byPlace.keys()].filter((k) => !SYSTEM_PLACES.has(k) && k !== "pr-tray"));

  // Figures first (positions only), so place labels and bubbles know where people are before anything is drawn.
  for (const a of replay.actors) {
    const v = state.actors[a.id];
    if (!v) continue;
    if (a.actor_type === "system" && SYSTEM_PLACES.has(a.home)) continue;
    const pos = actorPosition(a.id, v, clock, placeById, byPlace);
    if (!pos) continue;
    const fig = figureGeometry(pos, clock, ci);
    layout.figures.push(fig.rect);
    qa("figure", fig.rect, `actor:${a.id}`);
    drawables.push({ depth: pos.y, draw: () => drawActor(ctx, a, v, fig, clock, ci, c, layout) });
  }

  // Places (props, system objects); their labels are collected and drawn on top
  for (const place of replay.places) {
    const f = placeToFloor(place);
    drawables.push({ depth: f.y, draw: () => drawPlace(ctx, place, engine, c, layout) });
  }

  drawables.sort((p, q) => p.depth - q.depth);
  for (const d of drawables) d.draw();
  // the diff card first (a fixed corner), then everything that is placed around what is already there
  const card = cardAt(replay, clock);
  if (card) drawDiffCard(ctx, engine, card, placeById, c, layout);
  // the illustration callouts are the message of a scene: placed first (clear of every person), and the name tags,
  // labels and bubbles then go around them
  const ill = replay.scene?.illustration;
  if (ill) drawIllustrationCallouts(ctx, engine, ill, placeById, c, layout);
  for (const f of layout.late) f();

  // what the scene adds on top of the floor: reads and edits in another team's folder, sheets and packets
  const agentPos = agentScreenPos(engine, placeById, byPlace);
  for (const k of consumers) drawConsumerMarks(ctx, engine, k, agentPos, placeById, c, layout);
  drawResting(ctx, engine, placeById, c, layout);
  drawTicketOrigin(ctx, engine, placeById, c, layout);
  for (const f of travelsAt(travelsOf(replay), clock)) drawTravel(ctx, f, placeById, c);

  // place labels first (they belong to an object); the glass caption takes whatever room is left beside the glass
  for (const l of layout.labels) drawPlaceLabel(ctx, l, c, layout);
  if (layout.glass) drawGlassCaption(ctx, layout.glass, c, layout);
  if (zones.length) drawZoneTitles(ctx, zones, c);
  // a bubble said by the same step as the subtitle would say it twice: the subtitle wins
  const narr = state.narration;
  if (narr && narrationAt(state, clock, engine.end)) layout.bubbles = layout.bubbles.filter((b) => b.bubble.at !== narr.at);
  layoutBubbles(ctx, layout, c, clock);

  if (overlay) drawOverlay(ctx, overlay, c);
  const narration = narrationAt(state, clock, engine.end);
  if (narration) drawSubtitle(ctx, narration, c, bigSubs);
  drawWatermark(ctx, replay.meta, c);
  drawLegend(ctx, c);
  const cite = recastCitation(replay);
  if (cite) drawCitation(ctx, cite, c);
}

/** The colour legend, bottom-right in every frame: cyan = pass, pink = fail (as in the deck). */
function drawLegend(ctx: CanvasRenderingContext2D, c: StageColors) {
  ctx.save();
  const size = fz(12);
  ctx.font = `500 ${size}px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const items: [string, string][] = [[PASS, "pass"], [FAIL, "fail"]];
  const sw = size - 2;
  const widths = items.map(([, t]) => ctx.measureText(t).width);
  const w = widths.reduce((a, b) => a + b, 0) + items.length * (sw + 6) + (items.length - 1) * 14 + 20;
  const h = size + 12;
  const x = STAGE_W - w - 8;
  const y = STAGE_H - h - 11;
  qa("chrome", { x, y, w, h }, "legend");
  ctx.fillStyle = c.surface;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = c.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  let tx = x + 10;
  items.forEach(([col, t], i) => {
    ctx.fillStyle = col;
    ctx.fillRect(tx, y + (h - sw) / 2, sw, sw);
    tx += sw + 6;
    ctx.fillStyle = c.ink;
    ctx.fillText(t, tx, y + h / 2 + 0.5);
    tx += widths[i] + 14;
  });
  ctx.restore();
}

/** Re-cast: the roster's source, bottom-right, painted into the frame (so clips carry it). */
function drawCitation(ctx: CanvasRenderingContext2D, text: string, c: StageColors) {
  ctx.save();
  ctx.font = `400 11px ${FONT}`;
  let t = `Roster source: ${text}`;
  while (t.length > 20 && ctx.measureText(t).width > 640) t = `${t.slice(0, -2)}…`;
  const w = ctx.measureText(t).width + 14;
  const x = STAGE_W - w - 8;
  const y = STAGE_H - 30 - fz(12) - 18;
  qa("chrome", { x, y, w, h: 20 }, "citation");
  ctx.fillStyle = c.surface;
  ctx.fillRect(x, y, w, 20);
  ctx.strokeStyle = c.lineStrong;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 19);
  ctx.fillStyle = c.ink2;
  ctx.textBaseline = "middle";
  ctx.fillText(t, x + 7, y + 10.5);
  ctx.restore();
}

/** Pixel position (front of the prop, top of the prop) of a place on the floor. */
function placePixel(p: ReplayPlace) {
  const f = placeToFloor(p);
  return floorToPixel(f.x, f.y);
}

function aerialToPixel(x: number, y: number) {
  return floorToPixel(x, placeToFloor({ x, y }).y);
}

/**
 * The floor as a lifecycle, left to right: one tinted column per zone (Define, Build, Verify & release, Production),
 * dashed seams between them. Titles are drawn last (drawZoneTitles) so props never hide them.
 */
function drawZones(ctx: CanvasRenderingContext2D, zones: SceneZone[], c: StageColors) {
  ctx.save();
  for (const z of zones) {
    const a = aerialToPixel(z.x0, ZONE_Y0);
    const b = aerialToPixel(z.x1, ZONE_Y0);
    const d = aerialToPixel(z.x1, ZONE_Y1);
    const e = aerialToPixel(z.x0, ZONE_Y1);
    ctx.beginPath();
    ctx.moveTo(a.px, a.py);
    ctx.lineTo(b.px, b.py);
    ctx.lineTo(d.px, d.py);
    ctx.lineTo(e.px, e.py);
    ctx.closePath();
    ctx.fillStyle = ZONE_TINTS[z.id] ?? c.floor;
    ctx.fill();
  }
  ctx.strokeStyle = c.lineStrong;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  for (const z of zones.slice(1)) {
    const s0 = aerialToPixel(z.x0, ZONE_Y0);
    const s1 = aerialToPixel(z.x0, ZONE_Y1);
    ctx.beginPath();
    ctx.moveTo(s0.px, s0.py);
    ctx.lineTo(s1.px, s1.py);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

const TITLE_Y = HEADER_H + 10;
/** the sub-band sits under the zone titles (lower in presentation mode, where the titles are larger) */
const bandY = () => TITLE_Y + fz(13) + fz(11) + 14;

function zoneTitleRects(ctx: CanvasRenderingContext2D, zones: SceneZone[]): Rect[] {
  const out: Rect[] = [];
  ctx.save();
  for (const z of zones) {
    const x0 = aerialToPixel(z.x0, TITLE_ROW).px;
    const x1 = aerialToPixel(z.x1, TITLE_ROW).px;
    out.push({ x: x0 + 4, y: TITLE_Y - 2, w: x1 - x0 - 8, h: fz(13) + fz(11) + 10 });
  }
  ctx.restore();
  out.push({ x: aerialToPixel(0, TITLE_ROW).px, y: bandY() - 8, w: aerialToPixel(1, TITLE_ROW).px - aerialToPixel(0, TITLE_ROW).px, h: 16 });
  return out;
}

/** Zone titles with the roles each zone holds, and the v2 idea as a sub-band: probabilistic vs deterministic. */
function drawZoneTitles(ctx: CanvasRenderingContext2D, zones: SceneZone[], c: StageColors) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const z of zones) {
    const x0 = aerialToPixel(z.x0, TITLE_ROW).px;
    const x1 = aerialToPixel(z.x1, TITLE_ROW).px;
    const cx = (x0 + x1) / 2;
    const ts = fz(13);
    const rs = fz(11);
    ctx.font = `700 ${ts}px ${FONT}`;
    const title = z.label.toUpperCase();
    ctx.font = `400 ${rs}px ${FONT}`;
    const rw = ctx.measureText(z.roles).width;
    ctx.font = `700 ${ts}px ${FONT}`;
    const w = Math.min(x1 - x0 - 8, Math.max(ctx.measureText(title).width, rw) + 16);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillRect(cx - w / 2, TITLE_Y - 2, w, ts + rs + 10);
    qa("chrome", { x: cx - w / 2, y: TITLE_Y - 2, w, h: ts + rs + 10 }, "zones", title);
    ctx.fillStyle = ZONE_TINTS[z.id] ?? c.floor;
    ctx.fillRect(cx - w / 2, TITLE_Y - 2, w, 3);
    ctx.fillStyle = c.ink;
    ctx.fillText(title, cx, TITLE_Y + 3);
    ctx.font = `400 ${rs}px ${FONT}`;
    ctx.fillStyle = c.ink2;
    ctx.fillText(z.roles, cx, TITLE_Y + 5 + ts);
  }
  // sub-band: contiguous zones that share a band
  let i = 0;
  while (i < zones.length) {
    let j = i;
    while (j + 1 < zones.length && zones[j + 1].band === zones[i].band) j++;
    const x0 = aerialToPixel(zones[i].x0, TITLE_ROW).px + 6;
    const x1 = aerialToPixel(zones[j].x1, TITLE_ROW).px - 6;
    ctx.strokeStyle = c.lineStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, bandY());
    ctx.lineTo(x1, bandY());
    ctx.moveTo(x0, bandY() - 4);
    ctx.lineTo(x0, bandY() + 4);
    ctx.moveTo(x1, bandY() - 4);
    ctx.lineTo(x1, bandY() + 4);
    ctx.stroke();
    ctx.font = `500 ${fz(11)}px ${FONT}`;
    const text = zones[i].band_label;
    const tw = ctx.measureText(text).width + 12;
    ctx.fillStyle = c.wall;
    ctx.fillRect((x0 + x1) / 2 - tw / 2, bandY() - fz(11) / 2 - 1, tw, fz(11) + 3);
    qa("chrome", { x: (x0 + x1) / 2 - tw / 2, y: bandY() - fz(11) / 2 - 1, w: tw, h: fz(11) + 3 }, "zones", text);
    ctx.fillStyle = c.ink2;
    ctx.textBaseline = "middle";
    ctx.fillText(text, (x0 + x1) / 2, bandY() + 0.5);
    ctx.textBaseline = "top";
    i = j + 1;
  }
  ctx.restore();
}

/** The glass between the agent's side (Build, Verify) and the teams in Production: frosted in V0/V1, clear in V2. */
function drawGlass(ctx: CanvasRenderingContext2D, clear: boolean, _v: string, c: StageColors, layout: Layout) {
  const b0 = aerialToPixel(GLASS_X, GLASS_Y0);
  const b1 = aerialToPixel(GLASS_X, GLASS_Y1);
  const h0 = 54 * b0.scale;
  const h1 = 54 * b1.scale;
  const quad = () => {
    ctx.beginPath();
    ctx.moveTo(b0.px, b0.py);
    ctx.lineTo(b1.px, b1.py);
    ctx.lineTo(b1.px, b1.py - h1);
    ctx.lineTo(b0.px, b0.py - h0);
    ctx.closePath();
  };
  ctx.save();
  quad();
  ctx.fillStyle = clear ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.72)";
  ctx.fill();
  ctx.clip();
  if (!clear) {
    ctx.strokeStyle = "rgba(17,24,39,0.08)";
    ctx.lineWidth = 1;
    for (let y = b0.py - h0; y < b1.py + 40; y += 5) {
      ctx.beginPath();
      ctx.moveTo(b0.px - 40, y);
      ctx.lineTo(b0.px + 40, y + 30);
      ctx.stroke();
    }
  } else {
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 3;
    for (const f of [0.2, 0.26, 0.66]) {
      const x = b0.px + (b1.px - b0.px) * f;
      const y = b0.py + (b1.py - b0.py) * f;
      ctx.beginPath();
      ctx.moveTo(x - 2, y - 6);
      ctx.lineTo(x + 4, y - 40 * b0.scale);
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.save();
  quad();
  ctx.strokeStyle = clear ? c.ink2 : c.lineStrong;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  // caption on the Verify side of the glass, placed once the people on the floor are known (drawGlassCaption)
  const mid = aerialToPixel(GLASS_X, (GLASS_Y0 + GLASS_Y1) / 2 + 0.06);
  layout.glass = {
    lines: clear
      ? ["Clear glass", "the teams' repos are in", "the agent's workspace"]
      : ["Frosted glass", "the teams' repos are not", "in the agent's workspace"],
    x: mid.px - 14, y: mid.py - 70 * mid.scale, scale: mid.scale,
  };
}

/** The glass caption beside the glass, where it covers nobody: at its middle, lower, higher, or across the glass. */
function drawGlassCaption(ctx: CanvasRenderingContext2D, g: NonNullable<Layout["glass"]>, c: StageColors,
  layout: Layout) {
  ctx.save();
  const size = fz(12);
  const lh = size + 3;
  let tw = 0;
  g.lines.forEach((l, i) => {
    ctx.font = `${i === 0 ? 600 : 400} ${size}px ${FONT}`;
    tw = Math.max(tw, ctx.measureText(l).width);
  });
  const h = g.lines.length * lh + 4;
  const left = (dy: number): Rect => ({ x: g.x - tw - 4, y: g.y - 2 + dy, w: tw + 8, h });
  const right = (dy: number): Rect => ({ x: g.x + 24, y: g.y - 2 + dy, w: tw + 8, h });
  const cands = [left(0), left(70), left(-60), left(130), right(0), right(70)];
  const r = bestRect(cands, layout);
  const alignRight = r.x < g.x;
  ctx.textAlign = alignRight ? "right" : "left";
  ctx.textBaseline = "top";
  const tx = alignRight ? r.x + r.w - 4 : r.x + 4;
  g.lines.forEach((l, i) => {
    ctx.font = `${i === 0 ? 600 : 400} ${size}px ${FONT}`;
    ctx.fillStyle = i === 0 ? c.ink : c.ink2;
    haloText(ctx, l, tx, r.y + 2 + i * lh);
  });
  layout.obstacles.push(r);
  qa("caption", r, "glass", g.lines[0]);
  ctx.restore();
}

/** Single-ticket runs: the product desk says where the ticket came from (the scenario fixes it). */
function drawTicketOrigin(ctx: CanvasRenderingContext2D, engine: ReplayEngine, places: Map<string, ReplayPlace>,
  c: StageColors, layout: Layout) {
  const o = engine.replay.scene?.ticket_origin;
  const p = o ? places.get(o.place) : undefined;
  if (!o || !p) return;
  const { px, py } = placePixel(p);
  const r = pill(ctx, px, py + 2, o.label, c.surface, c.ink, layout, 11, `place:${o.place}`);
  ctx.save();
  ctx.strokeStyle = c.lineStrong;
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, r.h - 1);
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
  layout: Layout, size = 11, owner?: string): Rect {
  ctx.save();
  size = fz(size);
  ctx.globalAlpha *= fa(owner, 0.5);
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
  qa("pill", r, owner, text);
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
    ctx.globalAlpha = fa(`place:${k.desk}`, 0.45);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = reads.flash ? 2.5 : 1.5;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(agent.x, agent.y);
    ctx.lineTo(px, top);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    const parts = (reads.last ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
    const label = `read ${parts.slice(-2).join("/")}${reads.count > 1 ? ` +${reads.count - 1}` : ""}`;
    // the file label only while the read is fresh; the dotted line stays as the trace of it
    if (reads.flash) pill(ctx, (agent.x + px) / 2, (agent.y + top) / 2 - 9, label, "#ffffff", ACCENT, layout, 11, `place:${k.desk}`);
  }
  const edits = editsAt(k, engine.clock);
  if (edits.length) {
    ctx.save();
    ctx.globalAlpha = fa(`place:${k.desk}`, 0.5);
    ctx.strokeStyle = FAIL;
    ctx.lineWidth = 3;
    const w = 140 * scale;
    ctx.strokeRect(px - w / 2, top - 6 * scale, w, py - top + 4 * scale);
    ctx.restore();
    const text = `edited by the agent: ${shortPath(edits[0])}${edits.length > 1 ? ` +${edits.length - 1}` : ""}`;
    pill(ctx, px, py + 2, text, FAIL, "#ffffff", layout, 11, `place:${k.desk}`);
  }
}

/** Maya's sheets after they land: the spec rules on the agent's desk, the fitness functions on the CI tower. */
function drawResting(ctx: CanvasRenderingContext2D, engine: ReplayEngine, places: Map<string, ReplayPlace>,
  c: StageColors, layout: Layout) {
  // the place labels are drawn later; keep the sheets off where they will sit
  const labels = layout.labels.map((l) => labelBox(ctx, l));
  for (const s of restingSheets(engine.replay, engine.clock)) {
    const p = places.get(s.to);
    if (!p) continue;
    const { px, py, scale } = placePixel(p);
    ctx.save();
    ctx.globalAlpha = fa(`place:${s.to}`, 0.45);
    ctx.font = `500 ${fz(11)}px ${FONT}`;
    const text = s.to === "ci-tower" ? s.label.split(" · ")[0] : s.label.split(" · ").slice(-1)[0];
    const tw = ctx.measureText(text).width;
    const bw = tw + 24 * scale + 4;
    const bh = 22;
    // the icon's centre is (box.x + 8, box.y + 10)
    const box = (ix: number, iy: number): Rect => ({ x: ix - 8, y: iy - 10, w: bw, h: bh });
    const cands = s.to === "ci-tower"
      ? [box(px + 30 * scale, py - 26 * scale), box(px + 30 * scale, py - 56 * scale),
        box(px - 34 * scale - bw, py - 26 * scale), box(px - 34 * scale - bw, py - 56 * scale),
        box(px + 30 * scale, py - 86 * scale), box(px - bw / 2 + 8, py + 44)]
      : [box(px - 58 * scale, py - 52 * scale), box(px + 66 * scale, py - 40 * scale),
        box(px - 58 * scale - bw / 2, py - 20 * scale), box(px - bw / 2 + 8, py - 84 * scale)];
    cands.push(...ring(px, py - 40 * scale, bw, bh, [50, 80, 110]));
    const r = bestRect(cands, layout, labels, 6);
    const x = r.x + 8;
    const y = r.y + 10;
    drawSheetIcon(ctx, x, y, 0.8 * scale, c);
    ctx.fillStyle = c.ink2;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    haloText(ctx, text, x + 12 * scale, y + 2);
    layout.obstacles.push(r);
    qa("sheet", r, `place:${s.to}`, text);
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
    // turned back where it broke: eases a short way back along its path and fades out (no bounce)
    const q = Math.min(1, progress - 1);
    const back = (1 - Math.pow(1 - q, 3)) * 0.12;
    pos = along(1 - back);
    alpha = Math.max(0, 1 - q);
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
  desk: ReplayPlace, c: StageColors, layout: Layout) {
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
  ctx.globalAlpha = fa(`place:${k.desk}`);
  ctx.filter = dimFilter(`place:${k.desk}`);
  ctx.fillStyle = "rgba(17,24,39,0.14)";
  ctx.beginPath();
  ctx.ellipse(px, py, w * 0.36, w * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.imageSmoothingEnabled = false;
  const grid = portraitGrid({ style: "human", seed: owner.seed, role: "code_owner", badge: null }, pose);
  ctx.drawImage(grid, x, y, w, h);
  ctx.restore();
  layout.late.push(() => drawOwnerTags(ctx, k, owner, view, px, desk, c, layout));
}

/** Under a team's counter: who they are, and the oracle's verdict for their service (drawn over passers-by). */
function drawOwnerTags(ctx: CanvasRenderingContext2D, k: SceneConsumer, owner: NonNullable<SceneConsumer["owner"]>,
  view: ReturnType<typeof ownerView>, px: number, desk: ReplayPlace, c: StageColors, layout: Layout) {
  void k;
  ctx.save();
  ctx.globalAlpha = fa(`place:${desk.id}`, 0.5);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  // under the counter: the team, not a user and not the oracle ("Billing team (consumer)"), then the service it
  // runs and the fictional stand-in
  const dp = placePixel(desk);
  const ly = dp.py + 2;
  const nameSize = fz(12);
  const s2 = fz(11);
  const name = owner.title;
  const sub = `${desk.label} · ${owner.name} (fictional)`;
  ctx.font = `600 ${nameSize}px ${FONT}`;
  const nw = ctx.measureText(name).width;
  ctx.font = `400 ${s2}px ${FONT}`;
  const sw = ctx.measureText(sub).width;
  const bw = Math.max(nw, sw) + 4;
  const bh = nameSize + s2 + 5;
  const box = (cx: number): Rect => ({ x: cx - bw / 2, y: ly - 1, w: bw, h: bh });
  const r = bestRect([box(px), box(px + bw * 0.45), box(px - bw * 0.45)], layout);
  px = r.x + bw / 2;
  ctx.font = `600 ${nameSize}px ${FONT}`;
  ctx.fillStyle = c.ink;
  haloText(ctx, name, px, ly);
  ctx.font = `400 ${s2}px ${FONT}`;
  ctx.fillStyle = c.ink2;
  haloText(ctx, sub, px, ly + nameSize + 2);
  layout.obstacles.push(r);
  qa("tag", r, `place:${desk.id}`, name);
  ctx.restore();

  if (view.alert) {
    ctx.save();
    ctx.globalAlpha = fa(`place:${desk.id}`, 0.55);
    const pass = view.alert.status === "pass";
    const version = view.alert.state === "gen" ? "first PR" : "final PR";
    const text = `${pass ? "✓" : "!"} ${version}: ${view.alert.text || (pass ? "pass" : "fail")}`;
    // under the team's name: what broke, in the oracle's own words, then the verdict
    let ay = dp.py + 6 + fz(12) + fz(11) + 8;
    if (!pass && view.alert.impact) {
      const r = pill(ctx, px, ay, view.alert.impact, FAIL, "#ffffff", layout, 12, `place:${desk.id}`);
      ay += r.h + 3;
    }
    const r = pill(ctx, px, ay, text, pass ? "#ffffff" : FAIL, pass ? "#0e7490" : "#ffffff", layout, 11, `place:${desk.id}`);
    if (pass) {
      ctx.save();
      ctx.strokeStyle = PASS;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 0.5, Math.round(r.y) + 0.5, Math.round(r.w) - 1, r.h - 1);
      ctx.restore();
    }
    ctx.restore();
  }
}

/** The diff card of the key file, beside the agent's desk, from the run's own diff (diffs/<session>.diff). */
function drawDiffCard(ctx: CanvasRenderingContext2D, engine: ReplayEngine, card: NonNullable<ReturnType<typeof cardAt>>,
  places: Map<string, ReplayPlace>, c: StageColors, layout: Layout) {
  const desk = places.get(engine.replay.actors.find((a) => a.id === engine.replay.scene?.agent)?.home ?? "desk-orders");
  if (!desk) return;
  const { px, py, scale } = placePixel(desk);
  ctx.save();
  ctx.globalAlpha = fa(`actor:${engine.replay.scene?.agent ?? ""}`, 0.5);
  const lh = 17;
  ctx.font = `400 12px ${MONO}`;
  // no wider than the DEFINE column it sits over, so it never covers the agent's desk
  const maxW = Math.max(260, aerialToPixel(0.22, 0.27).px - Math.max(12, aerialToPixel(0.0, 0.27).px - 30) - 8);
  const lineW = Math.min(maxW, Math.max(...card.lines.map((l) => ctx.measureText(`${l.op} ${l.text}`).width)) + 20);
  ctx.font = `600 12px ${FONT}`;
  const title = `${card.file} · ${card.session}`;
  const stat = `+${card.added} −${card.removed}`;
  const w = Math.min(maxW, Math.max(lineW, ctx.measureText(title).width + ctx.measureText(stat).width + 36));
  const h = 30 + card.lines.length * lh + (card.more ? lh : 0) + 6;
  // a fixed spot in the back-left corner (product desk and planning room, unused in M1 runs), clear of the lanes the
  // agent walks; a thin leader line points at the agent's desk
  const corner = aerialToPixel(0.0, 0.27);
  const x = Math.max(12, corner.px - 30);
  const y = corner.py;
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
  qa("card", { x, y, w, h }, `actor:${engine.replay.scene?.agent ?? ""}`, title);
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
  qa("chrome", { x, y, w, h }, "overlay", o.title);
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
  ctx.save();
  ctx.fillStyle = c.ink;
  ctx.font = `600 ${fz(15)}px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const ill = engine.replay.scene?.illustration;
  if (ill && !label) {
    drawIllustrationHeader(ctx, engine, ill, c);
    ctx.restore();
    return;
  }
  // plain words only: "AI-SDLC Office · Rename two fields · Own repo · No rule" (no ticket or condition codes)
  const title = label ?? `AI-SDLC Office · ${runHeadline(m)}`;
  ctx.fillText(title, MARGIN_X - 16, HEADER_H / 2 + 2);
  const tw = ctx.measureText(title).width;
  // which AI-SDLC model the floor shows (and, for a re-cast, that it is the same run with another roster)
  // the clock on the right keeps its room: the box drops the phase first, then shortens its own text with "…"
  const clock = `${fmtClock(engine.clock)} / ${fmtClock(engine.end)}`;
  let right = engine.state.phase ? `Phase: ${engine.state.phase}   ${clock}` : clock;
  let life = lifecycleLabel(engine.replay);
  if (life) {
    const recast = !!engine.replay.meta["recast"];
    ctx.font = `500 ${fz(13)}px ${FONT}`;
    const roomFor = (text: string) => STAGE_W - MARGIN_X + 16 - ctx.measureText(text).width - 16;
    let limit = roomFor(right);
    ctx.font = `600 ${fz(13)}px ${FONT}`;
    let lw = ctx.measureText(life).width + 16;
    const lx0 = MARGIN_X - 16 + tw + 16;
    let lx = Math.max(lx0, STAGE_W / 2 - lw / 2 - 40);
    if (lx + lw > limit && right !== clock) {
      right = clock;
      ctx.font = `500 ${fz(13)}px ${FONT}`;
      limit = roomFor(right);
      ctx.font = `600 ${fz(13)}px ${FONT}`;
    }
    if (lx + lw > limit) {
      lx = lx0;
      while (life.length > 1 && lx + ctx.measureText(`${life}…`).width + 16 > limit) life = life.slice(0, -1);
      life = `${life.trimEnd()}…`;
      lw = ctx.measureText(life).width + 16;
    }
    ctx.fillStyle = recast ? c.ink : c.surface;
    ctx.fillRect(lx, 8, lw, 24);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1;
    ctx.strokeRect(lx + 0.5, 8.5, lw - 1, 23);
    ctx.fillStyle = recast ? "#ffffff" : c.ink;
    ctx.textAlign = "left";
    ctx.fillText(life, lx + 8, HEADER_H / 2 + 1);
  }
  ctx.textAlign = "right";
  ctx.font = `500 ${fz(13)}px ${FONT}`;
  ctx.fillStyle = c.ink2;
  ctx.fillText(right, STAGE_W - MARGIN_X + 16, HEADER_H / 2 + 2);
  ctx.restore();
}

/** The stage a scripted scene is in: the model's own name for it, from the latest applied step that has one. */
function currentStage(engine: ReplayEngine): string | null {
  const steps = engine.replay.steps;
  for (let i = engine.state.applied - 1; i >= 0; i--) {
    const st = (steps[i].detail ?? {})["stage"];
    if (typeof st === "string") return st;
  }
  return null;
}

/** Illustration header: the model (left), its own stage names with the current one marked (right). */
function drawIllustrationHeader(ctx: CanvasRenderingContext2D, engine: ReplayEngine, ill: Illustration, c: StageColors) {
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = `600 ${fz(15)}px ${FONT}`;
  ctx.fillStyle = c.ink;
  const x0 = MARGIN_X - 16;
  ctx.fillText(ill.model, x0, HEADER_H / 2 + 2);
  const tw = ctx.measureText(ill.model).width;
  ctx.font = `400 ${fz(13)}px ${FONT}`;
  ctx.fillStyle = c.ink2;
  ctx.fillText("· Meridian Retail (fictional)", x0 + tw + 8, HEADER_H / 2 + 2);
  const cur = currentStage(engine);
  const size = fz(12);
  ctx.font = `600 ${size}px ${FONT}`;
  const pad = 8;
  const widths = ill.stages.map((s) => ctx.measureText(s).width + pad * 2);
  let x = STAGE_W - MARGIN_X + 16 - widths.reduce((a, b) => a + b + 4, -4);
  const h = size + 10;
  const y = (HEADER_H - h) / 2 + 1;
  ill.stages.forEach((s, i) => {
    const on = s === cur;
    ctx.fillStyle = on ? c.ink : c.surface;
    ctx.fillRect(x, y, widths[i], h);
    ctx.strokeStyle = on ? c.ink : c.lineStrong;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, widths[i] - 1, h - 1);
    ctx.fillStyle = on ? "#ffffff" : c.ink2;
    ctx.fillText(s, x + pad, y + h / 2 + 0.5);
    x += widths[i] + 4;
  });
}

/** The first step at or before the clock that carries a flag (the rule beat, the merge-blocker beat). */
function flagAt(engine: ReplayEngine, key: string): boolean {
  const steps = engine.replay.steps;
  for (let i = 0; i < engine.state.applied; i++) if ((steps[i].detail ?? {})[key]) return true;
  return false;
}

/**
 * Illustration callouts on the floor, placed where they cover least: where the architecture rule lives (accent
 * outline) once the scene has put it there, what blocks the merge (ink) once that beat happened, and at the CI tower
 * whether the model's CI checks architecture at all.
 */
function drawIllustrationCallouts(ctx: CanvasRenderingContext2D, engine: ReplayEngine, ill: Illustration,
  places: Map<string, ReplayPlace>, c: StageColors, layout: Layout) {
  // rule = purple dashed (context: the agent reads it, probabilistic); gate = cyan (a check in CI, deterministic);
  // block = ink (what blocks the merge otherwise); quiet = grey dashed ("no architecture check in CI")
  const callout = (placeId: string, head: string, text: string, style: "rule" | "block" | "quiet" | "gate",
    foot?: string) => {
    const p = places.get(placeId);
    if (!p) return;
    const { px, py, scale } = placePixel(p);
    ctx.save();
    ctx.globalAlpha = fa(`place:${placeId}`, 0.6);
    const hs = fz(10);
    const ts = fz(12);
    ctx.font = `500 ${ts}px ${FONT}`;
    const lines = wrap(ctx, text, present ? 220 : 200, 3);
    ctx.font = `700 ${hs}px ${FONT}`;
    const hw = ctx.measureText(head).width;
    ctx.font = `500 ${ts}px ${FONT}`;
    const w = Math.max(hw, ...lines.map((l) => ctx.measureText(l).width)) + 18;
    const fs = fz(10);
    ctx.font = `600 ${fs}px ${FONT}`;
    const footW = foot ? ctx.measureText(foot).width + 18 : 0;
    ctx.font = `500 ${ts}px ${FONT}`;
    const w2 = Math.max(w, footW);
    const h = hs + 6 + lines.length * (ts + 3) + 8 + (foot ? fs + 6 : 0);
    const top = py - 60 * scale;
    const cands: Rect[] = [
      { x: px - w2 / 2, y: top - h - 6, w: w2, h }, { x: px - w2 / 2, y: py + 30, w: w2, h },
      { x: px + 60 * scale, y: top - h / 2, w: w2, h }, { x: px - 60 * scale - w2, y: top - h / 2, w: w2, h },
      { x: px - w2 / 2, y: top - h - 46, w: w2, h }, { x: px - w2 / 2, y: py + 70, w: w2, h },
      { x: px + 60 * scale, y: py + 10, w: w2, h }, { x: px - 60 * scale - w2, y: py + 10, w: w2, h },
      { x: px + 60 * scale, y: top - h - 20, w: w2, h }, { x: px - 60 * scale - w2, y: top - h - 20, w: w2, h },
      { x: px + 90 * scale, y: py - h / 2, w: w2, h }, { x: px - 90 * scale - w2, y: py - h / 2, w: w2, h },
      { x: px - w2 / 2, y: py + 110, w: w2, h }, { x: px + 90 * scale, y: py + 60, w: w2, h }, { x: px - 90 * scale - w2, y: py + 60, w: w2, h },
      { x: px + 120 * scale, y: top - h - 40, w: w2, h }, { x: px - 120 * scale - w2, y: top - h - 40, w: w2, h },
    ];
    cands.push(...ring(px, py - 30 * scale, w2, h));
    // a callout is big: it may sit over the floor and props, never over a person
    const r = bestRect(cands, layout, [], 16, 12);
    const fill = style === "block" ? c.ink : style === "gate" ? "#e6f8fb" : c.surface;
    const ink = style === "block" ? "#ffffff" : c.ink;
    const edge = style === "rule" ? RULE : style === "gate" ? PASS : style === "block" ? c.ink : c.lineStrong;
    ctx.fillStyle = fill;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = edge;
    ctx.lineWidth = style === "rule" || style === "gate" ? 2.5 : 1.5;
    if (style === "quiet") ctx.setLineDash([4, 3]);
    if (style === "rule") ctx.setLineDash([7, 4]);
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.setLineDash([]);
    // a hairline to the place
    ctx.strokeStyle = style === "rule" ? RULE : style === "gate" ? PASS : c.ink2;
    ctx.lineWidth = style === "rule" || style === "gate" ? 1.5 : 1;
    ctx.beginPath();
    const ex = Math.max(r.x + 6, Math.min(r.x + r.w - 6, px));
    const ey = r.y > py ? r.y : r.y + r.h;
    ctx.moveTo(ex, ey);
    ctx.lineTo(px, r.y > py ? py + 4 : top + 30 * scale);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `700 ${hs}px ${FONT}`;
    ctx.fillStyle = style === "rule" ? RULE : style === "gate" ? PASS_INK : style === "block" ? "#d9c2f0" : c.ink2;
    ctx.fillText(head, r.x + 9, r.y + 5);
    ctx.font = `500 ${ts}px ${FONT}`;
    ctx.fillStyle = ink;
    lines.forEach((l, i) => ctx.fillText(l, r.x + 9, r.y + hs + 9 + i * (ts + 3)));
    if (foot) {
      ctx.font = `600 ${fs}px ${FONT}`;
      ctx.fillStyle = style === "rule" ? RULE : style === "gate" ? PASS_INK : style === "block" ? "#d9c2f0" : c.ink2;
      ctx.fillText(foot, r.x + 9, r.y + hs + 9 + lines.length * (ts + 3) + 3);
    }
    ctx.restore();
    layout.obstacles.push(r);
    qa("callout", r, `place:${placeId}`, head);
  };
  if (flagAt(engine, "rule")) {
    callout(ill.rule.place, "WHERE THE RULE LIVES", ill.rule.label, "rule",
      "BEFORE GENERATION · CONTEXT · NO GUARANTEE");
  }
  if (flagAt(engine, "blocks")) {
    const inCi = ill.ci_arch && ill.blocks.place === "ci-tower";
    callout(ill.blocks.place, inCi ? "WHAT BLOCKS THE MERGE · IN CI" : "WHAT BLOCKS THE MERGE", ill.blocks.label,
      inCi ? "gate" : "block", inCi ? "AFTER GENERATION · A CHECK · DETERMINISTIC" : undefined);
  }
  const pr = engine.replay.steps.slice(0, engine.state.applied).some((s) => s.key === "pr_opened");
  // CI that runs says "no architecture check in CI" in the tower's own label (drawPlace); a model whose docs describe
  // no CI step gets the quiet callout at the idle tower
  const ciUsed = engine.replay.steps.slice(0, engine.state.applied).some((s) => s.place === "ci-tower");
  if (pr && !ill.ci_arch && places.has("ci-tower") && !ciUsed) {
    callout("ci-tower", "CI", "no CI step in this model's docs", "quiet");
  }
}

function actorPosition(id: string, v: ActorView, clock: number, places: Map<string, ReplayPlace>,
  byPlace: Map<string, string[]>) {
  const to = places.get(v.place);
  if (!to) return null;
  const list = byPlace.get(v.place) ?? [id];
  const spotTo = standingSpot(to, Math.max(0, list.indexOf(id)), list.length);
  // at a system object (the agent walking into the CI tower) stand beside it, so its lights stay visible
  // (with a PR tray on the tower's left, step to the tower's right instead)
  if (SYSTEM_PLACES.has(v.place)) spotTo.x += v.place === "ci-tower" && places.has("pr-tray") ? 0.075 : -0.115;
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
  const k = figureGridScale(scale, crowdScale, device);
  const w = (k * PORTRAIT_W) / device;
  const h = (w * PORTRAIT_H) / PORTRAIT_W;
  const gridPx = k / device;
  // a calm one-grid-pixel step while walking; no hops (CI's verdict shows on the tower and on faces)
  const lift = pos.walking ? (Math.floor(clock / 260) % 2) * gridPx : 0;
  void ci;
  const x = Math.round((px - w / 2) * device) / device;
  const y = Math.round((py - 2 - h - lift) * device) / device;
  return {
    px, py, scale, w, h, x, y, gridPx, facing: pos.facing, walking: pos.walking,
    rect: { x: x + w * 0.12, y: y + h * 0.04, w: w * 0.76, h: h * 0.96 },
  };
}

function drawActor(ctx: CanvasRenderingContext2D, a: ReplayActor, v: ActorView, fig: Figure, clock: number,
  ci: CiReaction | null, c: StageColors, layout: Layout) {
  const { px, py, w, h, x, y, gridPx } = fig;
  const isAgent = a.avatar.style === "agent";
  // re-cast view: a role the chosen model has no member for stays in place, dimmed
  ctx.save();
  const key = `actor:${a.id}`;
  ctx.globalAlpha = (a.recast_missing ? 0.3 : 1) * fa(key);

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
  ctx.filter = dimFilter(key);
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
    const bs = Math.max(fig.scale, 0.8) * 0.85;
    const badgeY = y + h - 2 * gridPx;
    drawBadge(ctx, px, badgeY, a.avatar.badge, bs, FONT);
    ny = Math.max(ny, badgeY + Math.max(13, 15 * bs) + 3);
  }
  if (v.gateMark) ny = Math.max(ny, py + w * 0.14 + 3); // below the pink ring

  // the name tag is placed after every figure is drawn, where it covers least (two people at one desk side by side)
  const ny0 = ny;
  layout.late.push(() => {
    // a crowded floor (the sprint) keeps only the names of the people in the current beat: the others fade out
    const crowdDim = crowdScale < 1 ? dimAmount(focus, key) : 0;
    if (crowdDim > 0.5) return;
    ctx.save();
    ctx.globalAlpha = (a.recast_missing ? 0.3 : 1) * fa(key, 0.5) * Math.max(0, 1 - 2 * crowdDim);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const nameSize = fz(Math.round(13 * Math.max(fig.scale, 0.9)));
    const s2 = fz(Math.round(12 * Math.max(fig.scale, 0.9)));
    const gs = fz(11);
    const shown = a.recast_missing ? `${a.role.replace(/_/g, " ")} · no counterpart` : a.display_name;
    const gateText = v.gateMark ? `Gate touched · ${v.gateMark}` : "";
    ctx.font = `${present ? 600 : 500} ${nameSize}px ${FONT}`;
    const nw = ctx.measureText(shown).width;
    ctx.font = `400 ${s2}px ${FONT}`;
    const sw = a.simulated ? ctx.measureText("simulated by policy").width : 0;
    ctx.font = `600 ${gs}px ${FONT}`;
    const tw = gateText ? ctx.measureText(gateText).width + 10 : 0;
    const bw = Math.max(nw, sw, tw) + 4;
    const bh = nameSize + 3 + (a.simulated ? s2 + 2 : 0) + (gateText ? gs + 5 : 0);
    const at = (cx: number, top: number): Rect => ({ x: cx - bw / 2, y: top - 1, w: bw, h: bh });
    const r = bestRect([at(px, ny0), at(px - bw * 0.55 - 6, ny0), at(px + bw * 0.55 + 6, ny0),
      at(px, ny0 + bh + 3), at(px - bw * 0.5, ny0 + bh + 3), at(px + bw * 0.5, ny0 + bh + 3), at(px, ny0 + 2 * bh + 6),
      // above the head, when the floor under the person is taken (the subtitle, a neighbour's name)
      at(px, y - bh - 2), at(px - bw * 0.6, y + h * 0.3), at(px + bw * 0.6, y + h * 0.3)],
    layout);
    const cx = r.x + bw / 2;
    let yy = r.y + 1;
    ctx.font = `${present ? 600 : 500} ${nameSize}px ${FONT}`;
    ctx.fillStyle = c.ink;
    haloText(ctx, shown, cx, yy);
    yy += nameSize + 3;
    if (a.simulated) {
      ctx.font = `400 ${s2}px ${FONT}`;
      ctx.fillStyle = c.ink2;
      haloText(ctx, "simulated by policy", cx, yy);
      yy += s2 + 2;
    }
    if (gateText) {
      ctx.font = `600 ${gs}px ${FONT}`;
      ctx.fillStyle = FAIL;
      ctx.fillRect(Math.round(cx - tw / 2), Math.round(yy), Math.round(tw), gs + 5);
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "middle";
      ctx.fillText(gateText, cx, yy + (gs + 5) / 2 + 0.5);
    }
    layout.obstacles.push(r);
    qa("name", r, `actor:${a.id}`, shown);
    ctx.restore();
  });

  ctx.restore();
  if (bubbleVisible(v, clock) && v.bubble) {
    layout.bubbles.push({ x: px, y: y + 4 * gridPx, bubble: v.bubble, self: fig.rect, owner: key });
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
  ctx.globalAlpha = (dim ? DIM_ALPHA : 1) * fa(`place:${place.id}`, 0.4);

  if (place.id === "users") {
    top = drawUsers(ctx, px, py, scale, c);
    // who is who in Production: the teams are people; the oracle is their tests
    const us = fz(11);
    ctx.font = `500 ${us}px ${FONT}`;
    ctx.fillStyle = c.ink2;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const legend = replay.scene?.illustration ? "Downstream: the other teams' own tests"
      : "Their own tests = the truth check (hidden from the agent)";
    const lw = ctx.measureText(legend).width;
    // kept inside the frame (the users stand in the bottom-right corner)
    const lx = Math.min(px, STAGE_W - 8 - lw / 2);
    haloText(ctx, legend, lx, py + 2, 3);
    layout.obstacles.push({ x: lx - lw / 2 - 2, y: py + 1, w: lw + 4, h: us + 3 });
    qa("label", { x: lx - lw / 2 - 2, y: py + 1, w: lw + 4, h: us + 3 }, "place:users", legend);
  } else if (place.id === "pr-tray") {
    top = drawTray(ctx, px, py, scale, trayCount(replay, clock), c);
    note = place.note ?? null;
    layout.obstacles.push({ x: px - 30 * scale, y: top - 10 * scale, w: 80 * scale, h: py - top + 10 * scale });
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
      const fs = fz(Math.max(11, Math.round(12 * scale)));
      ctx.font = `600 ${fs}px ${FONT}`;
      ctx.fillStyle = FAIL;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      failing.slice(0, 4).forEach((id, i) => {
        const ly = top + 40 * scale + i * (fs + 3);
        haloText(ctx, id, px - 34 * scale, ly, 3);
        const tw = ctx.measureText(id).width;
        layout.obstacles.push({ x: px - 34 * scale - tw - 2, y: ly - fs / 2 - 1, w: tw + 4, h: fs + 2 });
        // which rule failed is the point of the frame: nothing may cover it
        layout.reserved.push({ x: px - 34 * scale - tw - 2, y: ly - fs / 2 - 1, w: tw + 4, h: fs + 2 });
        qa("label", { x: px - 34 * scale - tw - 2, y: ly - fs / 2 - 1, w: tw + 4, h: fs + 2 }, "place:ci-tower", id);
      });
      ctx.restore();
    }
    layout.obstacles.push({ x: px - 34 * scale, y: top, w: 68 * scale, h: py - top });
    if (state.ci.attempts > 0) note = `attempt ${state.ci.attempt ?? state.ci.attempts - 1}${state.ci.running ? " · running" : ""}`;
    // an illustration whose model has no architecture check in CI says so under the tower (one label, not a callout)
    const ill = replay.scene?.illustration;
    if (ill && !ill.ci_arch && state.ci.attempts > 0) note = `${note} · no architecture check in CI`;
  } else if (place.id === "staging-bench") {
    const consumers = state.staging.consumers.length ? state.staging.consumers : DEFAULT_CONSUMERS;
    const lights: LightState[] = consumers.map((k) => state.staging.results[k] ?? "idle");
    owner = actorFor(replay.actors, state.actors, "staging");
    top = drawSystemObject(ctx, "bench", px, py, scale, { lights, active: owner ? isActive(owner, clock) : false }, c);
    ctx.save();
    const ls = fz(11);
    ctx.font = `500 ${ls}px ${FONT}`;
    ctx.fillStyle = c.ink2;
    ctx.textAlign = "center";
    const slot = (130 * scale) / consumers.length;
    // under the bench (the zone titles sit above it), alternating rows so neighbouring names never touch
    ctx.textBaseline = "top";
    const rows = consumers.length > 2 ? 2 : 1;
    consumers.forEach((k, i) => haloText(ctx, k.split("-")[0], px - 65 * scale + slot * (i + 0.5),
      py + 1 + (rows > 1 && i % 2 ? ls + 2 : 0), 3));
    ctx.restore();
    layout.obstacles.push({ x: px - 65 * scale - 8, y: top, w: 130 * scale + 16, h: py - top + 1 + rows * (ls + 2) });
    qa("label", { x: px - 65 * scale - 8, y: py + 1, w: 130 * scale + 16, h: rows * (ls + 2) }, "place:staging-bench", "consumers");
    if (state.staging.state) note = `hidden from the agent · ${state.staging.state}`;
    else if (present) note = null; // the users' legend says it in presentation mode
  } else if (place.id === "dispatch") {
    owner = actorFor(replay.actors, state.actors, "flow_engine");
    top = drawSystemObject(ctx, "board", px, py, scale, { active: owner ? isActive(owner, clock) : false }, c);
  } else if (place.zone === "production" && place.kind === "desk") {
    top = drawCounter(ctx, px, py, scale, c);
  } else {
    top = drawProp(ctx, place, px, py, scale, c);
    const agentHome = replay.actors.find((a) => a.id === replay.scene?.agent)?.home;
    if (place.id === agentHome && glassFor(replay).contracts) {
      // V1: the consumers' contracts were copied into the agent's repo; a stack of sheets on its desk
      const sx = px + 46 * scale;
      const sy = py - 30 * scale;
      for (let i = 2; i >= 0; i--) drawSheetIcon(ctx, sx + i * 3, sy - i * 3, 0.85 * scale, c);
      layout.obstacles.push({ x: sx - 8, y: sy - 18, w: 22, h: 26 });
      layout.late.push(() => {
        ctx.save();
        const text = "the other teams' contracts";
        ctx.font = `500 ${fz(11)}px ${FONT}`;
        const tw = ctx.measureText(text).width;
        const th = fz(11) + 4;
        const at = (x: number, y: number): Rect => ({ x, y: y - th / 2, w: tw + 4, h: th });
        const r = bestRect([at(sx + 14, sy + 14 * scale), at(sx - tw / 2, sy + 22 * scale), at(sx + 14, sy - 16 * scale),
          at(sx - tw - 18, sy + 14 * scale), ...ring(sx, sy, tw + 4, th, [40, 70, 100, 140])], layout, [], 8);
        ctx.fillStyle = c.ink2;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        haloText(ctx, text, r.x + 2, r.y + th / 2, 3);
        layout.obstacles.push(r);
        qa("label", r, `place:${place.id}`, text);
        ctx.restore();
      });
    }
  }
  ctx.restore();

  const size = fz(Math.round(14 * Math.max(scale, 0.9)));
  const noteSize = fz(Math.round(12 * Math.max(scale, 0.9)));
  const anchored = SYSTEM_PLACES.has(place.id) || place.id === "pr-tray";
  // a consumer team seated at this counter carries the label (team, service) under it
  if (replay.scene?.consumers.some((k) => k.desk === place.id && k.owner)) return;
  layout.labels.push(anchored
    ? { text: place.label, note, x: px, y: py + 6, anchor: "top", size, noteSize, dim, place: place.id }
    : { text: place.label,
      note: dim ? (replay.scene?.illustration ? "not in this model" : "not part of this run")
        : place.id === "users" ? place.note ?? null : null,
      x: px, y: top - 6 - (dim || place.id === "users" ? noteSize + 2 : 0), anchor: "bottom", size, noteSize, dim,
      place: place.id });

  if (owner && bubbleVisible(owner, clock) && owner.bubble) {
    layout.bubbles.push(place.id === "ci-tower"
      ? { x: px + 36 * scale, y: top + 50 * scale, bubble: owner.bubble, side: "right", owner: `place:${place.id}` }
      : { x: px, y: top - 8, bubble: owner.bubble, owner: `place:${place.id}` });
  }
}

/** A label's note in lines: a note much wider than its label breaks at " · " (it stays near its place). */
function noteLines(ctx: CanvasRenderingContext2D, l: PlaceLabel): string[] {
  if (!l.note) return [];
  ctx.save();
  ctx.font = `600 ${l.size}px ${FONT}`;
  const w = ctx.measureText(l.text).width;
  ctx.font = `400 ${l.noteSize}px ${FONT}`;
  const nw = ctx.measureText(l.note).width;
  ctx.restore();
  const parts = l.note.split(" · ");
  if (nw <= Math.max(160, w * 1.6) || parts.length < 2) return [l.note];
  const half = Math.ceil(parts.length / 2);
  return [parts.slice(0, half).join(" · "), parts.slice(half).join(" · ")];
}

/** The box a place label takes at its anchor (before collision avoidance). */
function labelBox(ctx: CanvasRenderingContext2D, l: PlaceLabel): Rect & { bw: number; top: number } {
  const notes = noteLines(ctx, l);
  ctx.save();
  ctx.font = `600 ${l.size}px ${FONT}`;
  const w = ctx.measureText(l.text).width;
  ctx.font = `400 ${l.noteSize}px ${FONT}`;
  const nw = Math.max(0, ...notes.map((n) => ctx.measureText(n).width));
  ctx.restore();
  const bw = Math.max(w, nw) + 6;
  const h = l.size + 3 + notes.length * (l.noteSize + 2);
  const top = l.anchor === "bottom" ? l.y - l.size : l.y;
  return { x: l.x - bw / 2, y: top - 1, w: bw, h, bw, top };
}

/**
 * Place labels are drawn above everything on the floor, where they cover the least: at their anchor, a line higher
 * (or lower for labels hung under a system object), just above or below a person standing there, or beside it. A
 * label that had to move far keeps a hairline to its place. Presentation mode drops the places nobody uses.
 */
function drawPlaceLabel(ctx: CanvasRenderingContext2D, l: PlaceLabel, c: StageColors, layout: Layout) {
  if (present && (l.dim || (l.place && layout.occupied?.has(l.place)))) return;
  const box = labelBox(ctx, l);
  const { bw, h } = box;
  const at = (dx: number, top: number): Rect => ({ x: l.x + dx - bw / 2, y: top - 1, w: bw, h });
  const home = at(0, box.top);
  const cands: Rect[] = [home];
  const step = l.size + 6;
  for (const dy of l.anchor === "bottom" ? [-step, -2 * step] : [step, 2 * step, 3 * step]) cands.push(at(0, box.top + dy));
  for (const f of layout.figures) {
    if (overlap(home, f) > 0) cands.push(at(0, f.y - h - 3), at(0, f.y + f.h + 3));
  }
  for (const dx of [-(bw * 0.6 + 18), bw * 0.6 + 18]) cands.push(at(dx, box.top), at(dx, box.top + (l.anchor === "bottom" ? -step : step)));
  cands.push(...ring(l.x, box.top + h / 2, bw, h, [45, 80, 120]));
  const r = bestRect(cands, layout, [], 6);
  const cx = r.x + bw / 2;
  const top = r.y + 1;
  ctx.save();
  ctx.globalAlpha = (l.dim ? 0.5 : 1) * fa(l.place ? `place:${l.place}` : undefined, 0.5);
  // a label that moved away from its place keeps a hairline to it
  const ay = l.anchor === "bottom" ? l.y + 2 : l.y - 2;
  const edge = r.y > ay ? r.y : r.y + r.h;
  if (Math.abs(cx - l.x) > 22 || Math.abs(edge - ay) > 22) {
    ctx.strokeStyle = c.lineStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, edge);
    ctx.lineTo(l.x, ay);
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `600 ${l.size}px ${FONT}`;
  ctx.fillStyle = present && !l.dim ? c.ink : c.ink2;
  haloText(ctx, l.text, cx, top);
  ctx.font = `400 ${l.noteSize}px ${FONT}`;
  ctx.fillStyle = c.ink2;
  noteLines(ctx, l).forEach((n, i) => haloText(ctx, n, cx, top + l.size + 2 + i * (l.noteSize + 2)));
  ctx.restore();
  layout.obstacles.push(r);
  qa("label", r, `place:${l.place ?? l.text}`, l.text);
}

function actorFor(actors: ReplayActor[], views: Record<string, ActorView>, role: string): ActorView | undefined {
  const a = actors.find((x) => x.role === role);
  return a ? views[a.id] : undefined;
}

/** A running service's counter (Production): a low desk with a service plate, no monitors, so its team is seen. */
function drawCounter(ctx: CanvasRenderingContext2D, px: number, py: number, s: number, c: StageColors): number {
  ctx.save();
  const by = py - 4 * s;
  const w = 110 * s;
  const h = 26 * s;
  ctx.fillStyle = c.body;
  ctx.fillRect(px - w / 2, by - h, w, h);
  ctx.strokeStyle = c.lineStrong;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px - w / 2 + 0.5, by - h + 0.5, w - 1, h - 1);
  ctx.fillStyle = c.surface;
  ctx.fillRect(px - 26 * s, by - h + 7 * s, 52 * s, 12 * s);
  ctx.fillStyle = c.bodyShade;
  for (let i = 0; i < 4; i++) ctx.fillRect(px - 22 * s + i * 12 * s, by - h + 11 * s, 8 * s, 4 * s);
  ctx.restore();
  return by - h;
}

/** The users in front of the running services: plain silhouettes (illustrative, no identities). */
function drawUsers(ctx: CanvasRenderingContext2D, px: number, py: number, s: number, c: StageColors): number {
  ctx.save();
  const n = 6;
  const gap = 20 * s;
  const x0 = px - ((n - 1) * gap) / 2;
  for (let i = 0; i < n; i++) {
    const x = x0 + i * gap;
    const by = py - 4 * s - (i % 2) * 3 * s;
    ctx.fillStyle = i % 2 ? c.bodyShade : c.ink2;
    ctx.beginPath();
    ctx.arc(x, by - 26 * s, 5.5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(x - 8 * s, by - 19 * s, 16 * s, 19 * s, 5 * s);
    ctx.fill();
  }
  ctx.restore();
  return py - 36 * s;
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
    ctx.font = `600 ${fz(Math.round(11 * Math.max(s, 0.9)))}px ${FONT}`;
    ctx.fillStyle = c.ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const prText = count === 1 ? "PR" : `PR v${count}`;
    haloText(ctx, prText, px + 20 * s, ty - 8 * s, 3);
    qa("label", { x: px + 20 * s, y: ty - 8 * s - 8, w: ctx.measureText(prText).width, h: 16 }, "place:pr-tray", prText);
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

function measureBubble(ctx: CanvasRenderingContext2D, b: Bubble, collapsed = false): BubbleBox | null {
  const code = b.tone === "code" || b.tone === "pass" || b.tone === "fail";
  const fontSize = present ? 15 : 13;
  ctx.font = `400 ${fontSize}px ${code ? MONO : FONT}`;
  const maxW = collapsed ? 220 : code ? 330 : 300;
  const lines = wrap(ctx, b.text, maxW, collapsed ? 1 : 3);
  if (!lines.length) return null;
  const lh = fontSize + 4;
  return { lines, code, lh, w: Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width))) + 20,
    h: lines.length * lh + 14 };
}

/**
 * Places every bubble where it covers the fewest labels, names, figures and earlier bubbles: above the speaker
 * first (sliding sideways and upwards), then beside it. Deterministic: candidates are tried in a fixed order.
 */
function layoutBubbles(ctx: CanvasRenderingContext2D, layout: Layout, c: StageColors, clock: number) {
  const placed: Rect[] = [];
  // with lifecycle zones, bubbles stay below the zone titles and the sub-band
  const minY = layout.zones ? bandY() + 10 : HEADER_H + 4;
  const maxY = STAGE_H - 96;
  // no stacking: at most MAX_BUBBLES speak at once (the newest), laid out oldest first
  const shown = shownBubbles(layout.bubbles);
  for (const [i, b] of shown.entries()) {
    // the older of two bubbles steps back: one line, half the light (the newest one is the one to read)
    const older = i < shown.length - 1;
    ctx.save();
    const box = measureBubble(ctx, b.bubble, older);
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
    for (const r of ring(b.x, b.y - h / 2 - 20, w, h, [70, 120, 180])) cands.push({ x: clampX(r.x), y: clampY(r.y), w, h });
    let best = cands[0];
    let bestScore = Infinity;
    cands.forEach((r, i) => {
      let score = i * 0.5; // prefer earlier candidates on a tie
      for (const o of layout.obstacles) score += overlap(r, o) * 8;
      for (const o of layout.reserved) if (overlap(r, o) > 0) score += 1e5;
      for (const f of layout.figures) if (f !== b.self) score += overlap(r, f) * 4;
      if (b.self) score += overlap(r, b.self) * 6;
      for (const p of placed) score += overlap(r, p) * 8;
      if (score < bestScore) {
        bestScore = score;
        best = r;
      }
    });
    placed.push(best);
    qa("bubble", best, b.owner, b.bubble.text);
    drawBubble(ctx, b, box, best, c, bubbleAlpha(b.bubble, clock) * (older ? OLDER_BUBBLE_ALPHA : 1) * fa(b.owner, 0.5));
  }
}

function drawBubble(ctx: CanvasRenderingContext2D, b: BubbleAnchor, box: BubbleBox, r: Rect, c: StageColors,
  alpha = 1) {
  const tone = b.bubble.tone;
  const { x, y, w, h } = r;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `400 ${present ? 15 : 13}px ${box.code ? MONO : FONT}`;
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

function subtitleBox(ctx: CanvasRenderingContext2D, text: string, big: boolean) {
  ctx.save();
  const size = big ? 26 : 18;
  ctx.font = `500 ${size}px ${FONT}`;
  const lines = wrap(ctx, text, big ? 1000 : 860, 2);
  const lh = size + 8;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 32;
  const h = lines.length * lh + 16;
  ctx.restore();
  return { lines, lh, size, rect: { x: (STAGE_W - w) / 2, y: STAGE_H - 44 - h, w, h } };
}

function drawSubtitle(ctx: CanvasRenderingContext2D, text: string, c: StageColors, big: boolean) {
  const { lines, lh, size, rect } = subtitleBox(ctx, text, big);
  const { x, y, w, h } = rect;
  ctx.save();
  ctx.font = `500 ${size}px ${FONT}`;
  qa("subtitle", { x, y, w, h }, "subtitle", lines[0]);
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
  if (meta.source === "illustration") {
    // dashed: a scripted scene, never to be confused with "Replay of a real run"
    const ill = (meta as { legend?: string }).legend || "Illustration · scripted from public documentation";
    const src = (meta as { illustration_source?: string }).illustration_source;
    ctx.font = `600 ${fz(13)}px ${FONT}`;
    const head = ill;
    const hw = ctx.measureText(head).width;
    ctx.font = `400 ${fz(12)}px ${FONT}`;
    const tail = src ? ` · ${src}` : "";
    let t2 = tail;
    while (t2.length > 12 && hw + ctx.measureText(t2).width + 24 > STAGE_W * 0.62) t2 = `${t2.slice(0, -2)}…`;
    const w = hw + ctx.measureText(t2).width + 20;
    qa("chrome", { x, y: y + 3, w, h: h - 6 }, "watermark");
    ctx.fillStyle = c.surface;
    ctx.fillRect(x, y + 3, w, h - 6);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x + 0.5, y + 3.5, w - 1, h - 7);
    ctx.setLineDash([]);
    ctx.fillStyle = c.ink;
    ctx.font = `600 ${fz(13)}px ${FONT}`;
    ctx.fillText(head, x + 10, y + h / 2 + 0.5);
    ctx.font = `400 ${fz(12)}px ${FONT}`;
    ctx.fillStyle = c.ink2;
    ctx.fillText(t2, x + 10 + hw, y + h / 2 + 0.5);
  } else if (meta.source === "mock") {
    ctx.font = `600 14px ${FONT}`;
    const legend = meta.legend || "SIMULATED (mock agent) — not a real run";
    const inner = ctx.measureText(legend).width + 20;
    const stripe = 26;
    const w = inner + stripe * 2;
    qa("chrome", { x, y, w: w + 10 + ctx.measureText(`${runSource(meta)} · ${unitText(meta.unit)} · ${meta.date}`).width, h }, "watermark");
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
    ctx.fillText(`${runSource(meta)} · ${unitText(meta.unit)} · ${meta.date}`, x + w + 10, y + h / 2 + 0.5);
  } else {
    ctx.font = `500 ${fz(13)}px ${FONT}`;
    const text = `Replay of a real run · ${runSource(meta)} · ${unitText(meta.unit)} · ${meta.date}`;
    const w = ctx.measureText(text).width + 20;
    qa("chrome", { x, y: y + 3, w, h: h - 6 }, "watermark");
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
