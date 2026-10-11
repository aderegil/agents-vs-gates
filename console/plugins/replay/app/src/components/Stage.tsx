// The office floor: pixel-souls' InteriorView (canvas 2D, pseudo-3D floor, characters that walk to their station)
// turned into the AI-SDLC Office stage. Everything drawn is a function of (replay, scene state, clock), so the same
// clock always renders the same frame. Watermark and subtitles are painted into the canvas so recorded clips carry
// them too.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  DARK, FAIL, LIGHT, PASS, PORTRAIT_H, PORTRAIT_W, drawBadge, drawSystemObject, portraitGrid,
  type LightState, type Palette,
} from "../engine/avatarStyles";
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

interface StageColors extends Palette {
  wall: string;
  floor: string;
  grid: string;
  subtitleBg: string;
  subtitleInk: string;
}

const LIGHT_STAGE: StageColors = { ...LIGHT, wall: "#eceff3", floor: "#f6f7f9", grid: "#e3e6eb",
  subtitleBg: "#111827", subtitleInk: "#ffffff" };
const DARK_STAGE: StageColors = { ...DARK, wall: "#0b0d11", floor: "#12151b", grid: "#1f242c",
  subtitleBg: "#000000", subtitleInk: "#ffffff" };

export interface StageHandle {
  draw: () => void;
  canvas: () => HTMLCanvasElement | null;
}

interface Props {
  engine: ReplayEngine;
  dark: boolean;
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

export const Stage = forwardRef<StageHandle, Props>(function Stage({ engine, dark, largeSubtitles, label }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const opts = useRef({ dark, largeSubtitles, label });
  opts.current = { dark, largeSubtitles, label };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = STAGE_W * 2;
    canvas.height = STAGE_H * 2;
  }, []);

  function draw() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    renderFrame(ctx, engine, opts.current.dark ? DARK_STAGE : LIGHT_STAGE, opts.current.largeSubtitles,
      opts.current.label);
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

interface BubbleAnchor {
  x: number;
  y: number;
  bubble: Bubble;
  side?: "up" | "right";
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
  const bubbles: BubbleAnchor[] = [];

  // Places (props, system objects, labels)
  for (const place of replay.places) {
    const f = placeToFloor(place);
    drawables.push({ depth: f.y, draw: () => drawPlace(ctx, place, engine, c, bubbles) });
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

  for (const a of replay.actors) {
    const v = state.actors[a.id];
    if (!v) continue;
    if (a.actor_type === "system" && SYSTEM_PLACES.has(a.home)) continue;
    const pos = actorPosition(a.id, v, clock, placeById, byPlace);
    if (!pos) continue;
    drawables.push({
      depth: pos.y,
      draw: () => drawActor(ctx, a, v, pos, clock, c, bubbles),
    });
  }
  // System actors' bubbles sit over their object (the object registers the anchor in drawPlace).
  drawables.sort((p, q) => p.depth - q.depth);
  for (const d of drawables) d.draw();
  for (const b of bubbles) drawBubble(ctx, b, c);

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
  if (SYSTEM_PLACES.has(v.place)) spotTo.x -= 0.075;
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

function drawActor(ctx: CanvasRenderingContext2D, a: ReplayActor, v: ActorView,
  pos: { x: number; y: number; walking: boolean; facing: 1 | -1 }, clock: number, c: StageColors,
  bubbles: BubbleAnchor[]) {
  const { px, py, scale } = floorToPixel(pos.x, pos.y);
  const size = 84 * scale;
  const h = (size * PORTRAIT_H) / PORTRAIT_W;
  const bob = pos.walking ? Math.abs(Math.sin(clock / 140)) * 3 * scale : 0;

  // feet shadow, or the pink ring when this actor touched the gate (spec 13.2: "marked in pink")
  ctx.save();
  ctx.fillStyle = "rgba(17,24,39,0.14)";
  ctx.beginPath();
  ctx.ellipse(px, py, size * 0.34, size * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();
  if (v.gateMark) {
    ctx.strokeStyle = FAIL;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(px, py, size * 0.46, size * 0.15, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  const grid = portraitGrid({ style: a.avatar.style === "agent" ? "agent" : "human", seed: a.avatar.seed });
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(px, py - h * 0.55 - bob);
  ctx.scale(pos.facing, 1);
  ctx.drawImage(grid, -size / 2, -h / 2, size, h);
  ctx.restore();
  const top = py - h * 0.55 - bob - h / 2;

  if (a.avatar.style === "agent") drawBadge(ctx, px, py - h * 0.2 - bob, a.avatar.badge, scale, FONT);

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `500 ${Math.round(13 * Math.max(scale, 0.9))}px ${FONT}`;
  ctx.fillStyle = c.ink;
  ctx.fillText(a.display_name, px, py + 6);
  let ny = py + 6 + 16;
  if (a.simulated) {
    ctx.font = `400 ${Math.round(12 * Math.max(scale, 0.9))}px ${FONT}`;
    ctx.fillStyle = c.ink2;
    ctx.fillText("simulated by policy", px, ny);
    ny += 14;
  }
  if (v.gateMark) {
    ctx.font = `600 11px ${FONT}`;
    const t = `Gate touched · ${v.gateMark}`;
    const w = ctx.measureText(t).width + 10;
    ctx.fillStyle = FAIL;
    ctx.fillRect(Math.round(px - w / 2), Math.round(ny), Math.round(w), 16);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(t, px, ny + 8.5);
  }
  ctx.restore();

  if (bubbleVisible(v, clock) && v.bubble) bubbles.push({ x: px, y: top - 6, bubble: v.bubble });
}

function drawPlace(ctx: CanvasRenderingContext2D, place: ReplayPlace, engine: ReplayEngine, c: StageColors,
  bubbles: BubbleAnchor[]) {
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
      ctx.font = `600 ${Math.round(12 * scale)}px ${FONT}`;
      ctx.fillStyle = FAIL;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      failing.slice(0, 4).forEach((id, i) => ctx.fillText(id, px - 34 * scale, top + 40 * scale + i * 15 * scale));
      ctx.restore();
    }
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
    if (state.staging.state) note = `hidden from the agent · ${state.staging.state}`;
  } else if (place.id === "dispatch") {
    owner = actorFor(replay.actors, state.actors, "flow_engine");
    top = drawSystemObject(ctx, "board", px, py, scale, { active: owner ? isActive(owner, clock) : false }, c);
  } else {
    top = drawProp(ctx, place, px, py, scale, c);
  }

  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = c.ink2;
  const labelSize = Math.round(14 * Math.max(scale, 0.9));
  const noteSize = Math.round(12 * Math.max(scale, 0.9));
  if (SYSTEM_PLACES.has(place.id)) {
    ctx.textBaseline = "top";
    ctx.font = `600 ${labelSize}px ${FONT}`;
    ctx.fillText(place.label, px, py + 6);
    if (note) {
      ctx.font = `400 ${noteSize}px ${FONT}`;
      ctx.fillText(note, px, py + 8 + labelSize);
    }
  } else {
    ctx.textBaseline = "bottom";
    ctx.font = `600 ${labelSize}px ${FONT}`;
    ctx.fillText(place.label, px, top - 6);
  }
  ctx.restore();

  if (owner && bubbleVisible(owner, clock) && owner.bubble) {
    bubbles.push(place.id === "ci-tower"
      ? { x: px + 40 * scale, y: top + 50 * scale, bubble: owner.bubble, side: "right" }
      : { x: px, y: top - 8, bubble: owner.bubble });
  }
}

function actorFor(actors: ReplayActor[], views: Record<string, ActorView>, role: string): ActorView | undefined {
  const a = actors.find((x) => x.role === role);
  return a ? views[a.id] : undefined;
}

/** Furniture for people's places (pixel-souls drawProp, re-drawn flat: no gradients, no decorative colour). */
function drawProp(ctx: CanvasRenderingContext2D, place: ReplayPlace, px: number, py: number, s: number,
  c: StageColors): number {
  ctx.save();
  let top = py;
  const by = py - 4 * s; // the prop sits just behind the standing spot
  if (place.kind === "desk") {
    const w = 120 * s;
    const h = 22 * s;
    ctx.fillStyle = c.bodyDark;
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
      ctx.fillStyle = c.bodyDark;
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
    const shades = [c.ink2, c.bodyDark, c.lineStrong, c.ink2, c.bodyDark];
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
    ctx.fillStyle = c.bodyDark;
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

function drawBubble(ctx: CanvasRenderingContext2D, b: BubbleAnchor, c: StageColors) {
  const tone = b.bubble.tone;
  const code = tone === "code" || tone === "pass" || tone === "fail";
  const fontSize = 13;
  ctx.save();
  ctx.font = `400 ${fontSize}px ${code ? MONO : FONT}`;
  const maxW = code ? 330 : 300;
  const lines = wrap(ctx, b.bubble.text, maxW, code ? 4 : 3);
  if (!lines.length) {
    ctx.restore();
    return;
  }
  const lh = fontSize + 4;
  const w = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width))) + 20;
  const h = lines.length * lh + 14;
  const right = b.side === "right";
  const x = right ? Math.min(STAGE_W - w - 8, b.x + 12) : Math.max(8, Math.min(STAGE_W - w - 8, b.x - w / 2));
  const y = right ? Math.max(HEADER_H + 4, b.y - h / 2) : Math.max(HEADER_H + 4, b.y - h - 10);
  const border = tone === "pass" ? PASS : tone === "fail" ? FAIL : c.lineStrong;
  ctx.fillStyle = c.surface;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = border;
  ctx.lineWidth = tone === "pass" || tone === "fail" ? 2 : 1.5;
  if (tone === "thought") ctx.setLineDash([4, 3]);
  if (right) {
    // tail on the left edge, pointing at the object
    const ty = Math.max(y + 10, Math.min(y + h - 10, b.y));
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y + 0.5);
    ctx.lineTo(x + w - 0.5, y + 0.5);
    ctx.lineTo(x + w - 0.5, y + h - 0.5);
    ctx.lineTo(x + 0.5, y + h - 0.5);
    ctx.lineTo(x + 0.5, ty + 7);
    ctx.lineTo(x - 9, ty);
    ctx.lineTo(x + 0.5, ty - 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c.ink;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    lines.forEach((l, i) => ctx.fillText(l, x + 10, y + 8 + i * lh));
    ctx.restore();
    return;
  }
  const tx = Math.max(x + 12, Math.min(x + w - 12, b.x));
  ctx.beginPath();
  ctx.moveTo(x + 0.5, y + 0.5);
  ctx.lineTo(x + w - 0.5, y + 0.5);
  ctx.lineTo(x + w - 0.5, y + h - 0.5);
  ctx.lineTo(tx + 7, y + h - 0.5);
  ctx.lineTo(tx, y + h + 9);
  ctx.lineTo(tx - 7, y + h - 0.5);
  ctx.lineTo(x + 0.5, y + h - 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = c.ink;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  lines.forEach((l, i) => ctx.fillText(l, x + 10, y + 8 + i * lh));
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
