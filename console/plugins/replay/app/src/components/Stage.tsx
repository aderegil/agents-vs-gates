// The office floor: pixel-souls' InteriorView (canvas 2D, pseudo-3D floor, characters that walk to their station)
// turned into the AI-SDLC Office stage. Everything drawn is a function of (replay, scene state, clock), so the same
// clock always renders the same frame: idle breathing, blinks, typing, talking and the CI reactions are keyed to the
// replay clock and the actor's seed, never to wall time or Math.random. Watermark and subtitles are painted into the
// canvas so recorded clips carry them too. One light palette (no dark variant, also in presentation mode).
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  FAIL, LIGHT, PASS, PORTRAIT_H, PORTRAIT_W, drawBadge, drawSystemObject, portraitGrid,
  type AvatarSpec, type LightState, type Palette,
} from "../engine/avatarStyles";
import { lastCiResult, poseFor, type CiReaction } from "../engine/motion";
import {
  bubbleVisible, isActive, narrationAt, walkProgress,
  type ActorView, type Bubble, type ReplayActor, type ReplayEngine, type ReplayPlace,
} from "../engine/replay";
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

export interface StageHandle {
  draw: () => void;
  canvas: () => HTMLCanvasElement | null;
}

interface Props {
  engine: ReplayEngine;
  largeSubtitles: boolean;
  label?: string;
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

export const Stage = forwardRef<StageHandle, Props>(function Stage({ engine, largeSubtitles, label }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const opts = useRef({ largeSubtitles, label });
  opts.current = { largeSubtitles, label };

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
    renderFrame(ctx, engine, STAGE_COLORS, opts.current.largeSubtitles, opts.current.label);
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

function renderFrame(ctx: CanvasRenderingContext2D, engine: ReplayEngine, c: StageColors, bigSubs: boolean,
  label?: string) {
  const { replay, state, clock } = engine;
  const placeById = new Map(replay.places.map((p) => [p.id, p]));
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);
  ctx.fillStyle = c.wall;
  ctx.fillRect(0, 0, STAGE_W, STAGE_H);
  drawFloor(ctx, c);
  drawHeader(ctx, engine, c, label);

  const drawables: Drawable[] = [];
  const layout: Layout = { obstacles: [], figures: [], bubbles: [], labels: [] };
  const ci = lastCiResult(engine);

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
  for (const l of layout.labels) drawPlaceLabel(ctx, l, c, layout);
  layoutBubbles(ctx, layout, c);

  const narration = narrationAt(state, clock, engine.end);
  if (narration) drawSubtitle(ctx, narration, c, bigSubs);
  drawWatermark(ctx, replay.meta, c);
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
  if (SYSTEM_PLACES.has(v.place)) spotTo.x -= 0.115;
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

  if (place.id === "ci-tower") {
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
  }

  const size = Math.round(14 * Math.max(scale, 0.9));
  const noteSize = Math.round(12 * Math.max(scale, 0.9));
  layout.labels.push(SYSTEM_PLACES.has(place.id)
    ? { text: place.label, note, x: px, y: py + 6, anchor: "top", size, noteSize }
    : { text: place.label, note: null, x: px, y: top - 6, anchor: "bottom", size, noteSize });

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
