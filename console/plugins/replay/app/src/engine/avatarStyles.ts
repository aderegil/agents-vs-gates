// The three avatar styles of the Replay Theater (spec 22.5 item 3). Shared with the Teams & Avatars plugin through
// the library build (src/avatar-lib.ts -> console/plugins/teams/web/avatar.js), so a role's character looks the
// same everywhere: same seed in, same pixels out.
//   human  : a 40×48 hand-shaded pixel bust (human.ts): face, hair, features and role clothing by seed
//   agent  : same bust size, plainly a machine (agent.ts): family head shape and palette, role emblem, screen face,
//            "AI · <model>" badge
//   system : objects, not people (CI tower with one light per check, staging bench, dispatch board). They light up.
// Pixels come from portrait.ts (no DOM); this file turns them into canvases and draws the system objects.
import { PORTRAIT_H, PORTRAIT_W, poseKey, type Pose } from "./identity";
import { portraitPixels } from "./portrait";

export { PORTRAIT_H, PORTRAIT_W };

export type AvatarStyle = "human" | "agent" | "system";

export interface AvatarSpec {
  style: AvatarStyle;
  seed: string;
  badge?: string | null;
  role?: string | null;
  /** agent family / AI-SDLC model id ("anthropic", "aws", "kiro", "ai-sdlc-io", "agents-vs-gates", "mock") */
  family?: string | null;
}

export const ACCENT = "#2563eb";
export let PASS = "#00BCD4";
/** The video clip's green "pass" (?pass=green, Stage.tsx); the console and the deck keep cyan. */
export const PASS_GREEN = "#1fb45a";
export const PASS_GREEN_INK = "#116329";
/** Only the clip calls it, once, before anything is drawn. */
export function setPassColor(c: string): void {
  PASS = c;
}
export const FAIL = "#E91E63";

/** Paints the PORTRAIT_W × PORTRAIT_H grid of a human or agent into a 2D context at (0, 0). */
export function paintPortrait(ctx: CanvasRenderingContext2D, spec: AvatarSpec, pose?: Pose): void {
  const g = portraitPixels(spec, pose);
  ctx.clearRect(0, 0, PORTRAIT_W, PORTRAIT_H);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(g.data), PORTRAIT_W, PORTRAIT_H), 0, 0);
}

const portraitCache = new Map<string, HTMLCanvasElement>();

function specKey(spec: AvatarSpec): string {
  return [spec.style, spec.seed, spec.role ?? "", spec.badge ?? "", spec.family ?? ""].join("|");
}

/** The unscaled portrait grid for a human/agent spec in a pose (cached). */
export function portraitGrid(spec: AvatarSpec, pose?: Pose): HTMLCanvasElement {
  const key = `${specKey(spec)}|${poseKey(pose)}`;
  const hit = portraitCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = PORTRAIT_W;
  c.height = PORTRAIT_H;
  const ctx = c.getContext("2d");
  if (ctx) paintPortrait(ctx, spec, pose);
  if (portraitCache.size > 2000) portraitCache.clear();
  portraitCache.set(key, c);
  return c;
}

/**
 * Largest crisp size for a portrait that should be about `target` px wide: a whole number of device pixels per
 * grid pixel, so nearest-neighbour scaling never doubles some columns and not others. Falls back to `target`.
 */
export function crispWidth(target: number, deviceScale: number): number {
  const k = Math.floor((target * deviceScale) / PORTRAIT_W + 1e-6);
  return k >= 1 ? (k * PORTRAIT_W) / deviceScale : target;
}

export type SystemKind = "tower" | "bench" | "board" | "machine";

export function systemKind(spec: { seed: string; role?: string | null }): SystemKind {
  const k = `${spec.role ?? ""} ${spec.seed}`.toLowerCase();
  if (/\bci\b|(^|[^a-z])ci([^a-z]|$)|pipeline|verifier of attest/.test(k)) return "tower";
  if (/staging|oracle/.test(k)) return "bench";
  if (/flow|dispatch|orchestrat|engine/.test(k)) return "board";
  return "machine";
}

export interface Palette {
  ink: string;
  ink2: string;
  line: string;
  lineStrong: string;
  surface: string;
  body: string;
  bodyShade: string;
  idle: string;
}

export const LIGHT: Palette = {
  ink: "#111827",
  ink2: "#5b6474",
  line: "#e3e6eb",
  lineStrong: "#c4cad3",
  surface: "#ffffff",
  body: "#d9dee5",
  bodyShade: "#aeb6c2",
  idle: "#c4cad3",
};


export type LightState = "pass" | "fail" | "error" | "idle";

export interface SystemState {
  lights?: LightState[];
  beacon?: "pass" | "fail" | null;
  active?: boolean;
  running?: boolean;
  label?: string | null;
}

function lightColor(s: LightState, p: Palette): string {
  return s === "pass" ? PASS : s === "fail" || s === "error" ? FAIL : p.idle;
}

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string,
  stroke?: string, lw = 1.5) {
  ctx.fillStyle = fill;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
  }
}

/**
 * Draws a system object standing on the floor at (cx, baseY), scaled by `s`. Returns the object's top y, so the
 * caller can place a bubble or a label above it.
 */
export function drawSystemObject(ctx: CanvasRenderingContext2D, kind: SystemKind, cx: number, baseY: number,
  s: number, state: SystemState, p: Palette): number {
  ctx.save();
  let top = baseY;
  if (kind === "tower") {
    const lights = state.lights && state.lights.length ? state.lights : new Array<LightState>(10).fill("idle");
    const rows = Math.ceil(lights.length / 2);
    const w = 52 * s;
    const lh = 9 * s;
    const gap = 4 * s;
    const h = 30 * s + rows * (lh + gap);
    const x = cx - w / 2;
    const y = baseY - h;
    rect(ctx, x - 6 * s, baseY - 6 * s, w + 12 * s, 6 * s, p.bodyShade);
    rect(ctx, x, y, w, h, p.body, state.running || state.active ? ACCENT : p.lineStrong, 1.5);
    lights.forEach((l, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const lx = x + 8 * s + col * (w / 2 - 4 * s);
      const ly = y + 22 * s + row * (lh + gap);
      rect(ctx, lx, ly, w / 2 - 12 * s, lh, lightColor(l, p));
    });
    // Beacon: the run's verdict (cyan pass / pink fail), grey while idle or running.
    const bw = 22 * s;
    rect(ctx, cx - bw / 2, y - 12 * s, bw, 12 * s,
      state.beacon === "pass" ? PASS : state.beacon === "fail" ? FAIL : p.idle, p.lineStrong, 1);
    top = y - 12 * s;
  } else if (kind === "bench") {
    const lights = state.lights && state.lights.length ? state.lights : new Array<LightState>(3).fill("idle");
    const w = 130 * s;
    const h = 22 * s;
    const x = cx - w / 2;
    const y = baseY - h - 14 * s;
    rect(ctx, x + 6 * s, y + h, 6 * s, 14 * s, p.bodyShade);
    rect(ctx, x + w - 12 * s, y + h, 6 * s, 14 * s, p.bodyShade);
    rect(ctx, x, y, w, h, p.body, state.active ? ACCENT : p.lineStrong, 1.5);
    const slot = w / lights.length;
    lights.forEach((l, i) => {
      const mx = x + i * slot + slot * 0.18;
      const mw = slot * 0.64;
      rect(ctx, mx, y - 24 * s, mw, 20 * s, p.surface, p.lineStrong, 1);
      rect(ctx, mx + 3 * s, y - 21 * s, mw - 6 * s, 14 * s, lightColor(l, p));
      rect(ctx, mx + mw / 2 - 2 * s, y - 4 * s, 4 * s, 4 * s, p.bodyShade);
    });
    top = y - 24 * s;
  } else if (kind === "board") {
    const w = 96 * s;
    const h = 62 * s;
    const x = cx - w / 2;
    const y = baseY - h - 18 * s;
    rect(ctx, x + 10 * s, y + h, 5 * s, 18 * s, p.bodyShade);
    rect(ctx, x + w - 15 * s, y + h, 5 * s, 18 * s, p.bodyShade);
    rect(ctx, x, y, w, h, p.surface, state.active ? ACCENT : p.lineStrong, state.active ? 2 : 1.5);
    for (let i = 0; i < 4; i++) {
      const ry = y + 9 * s + i * 13 * s;
      rect(ctx, x + 8 * s, ry, 8 * s, 8 * s, i === 0 && state.active ? ACCENT : p.idle);
      rect(ctx, x + 22 * s, ry + 2 * s, (w - 34 * s) * (i % 2 ? 0.7 : 0.9), 4 * s, p.lineStrong);
    }
    top = y;
  } else {
    // a generic machine (hooks and other automation): a small cabinet with a status light and a slot
    const w = 64 * s;
    const h = 58 * s;
    const x = cx - w / 2;
    const y = baseY - h;
    rect(ctx, x + 6 * s, baseY - 4 * s, w - 12 * s, 4 * s, p.bodyShade);
    rect(ctx, x, y, w, h - 4 * s, p.body, state.active ? ACCENT : p.lineStrong, 1.5);
    rect(ctx, x + 8 * s, y + 8 * s, w - 16 * s, 18 * s, p.surface, p.lineStrong, 1);
    for (let i = 0; i < 3; i++) rect(ctx, x + 13 * s, y + 12 * s + i * 4.5 * s, (w - 26 * s) * (i === 1 ? 0.6 : 0.85), 2 * s, p.lineStrong);
    rect(ctx, x + 8 * s, y + 33 * s, 8 * s, 8 * s, state.active ? ACCENT : p.idle);
    rect(ctx, x + 22 * s, y + 36 * s, w - 30 * s, 3 * s, p.bodyShade);
    top = y;
  }
  ctx.restore();
  return top;
}

/** "AI · Sonnet" badge for agents; drawn at display resolution (crisp text). */
export function drawBadge(ctx: CanvasRenderingContext2D, cx: number, y: number, model: string | null | undefined,
  s: number, font = "IBM Plex Sans, system-ui, sans-serif"): void {
  const text = model ? `AI · ${model}` : "AI";
  ctx.save();
  ctx.font = `600 ${Math.max(9, 10 * s)}px ${font}`;
  const w = ctx.measureText(text).width + 8 * s;
  const h = Math.max(13, 15 * s);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(Math.round(cx - w / 2), Math.round(y), Math.round(w), Math.round(h));
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, y + h / 2 + 0.5);
  ctx.restore();
}

/**
 * Renders a complete avatar card image (portrait, or system object) into `canvas`, about `size` px wide.
 * Portraits are drawn at the largest crisp size that fits and centred; agents get their badge under the bust.
 * Used by the Teams gallery and the theater's map; the theater floor draws the same grids and objects on its stage.
 */
export function renderAvatar(canvas: HTMLCanvasElement, spec: AvatarSpec, size = 96, palette: Palette = LIGHT): void {
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (spec.style === "system") {
    const h = Math.round((size * PORTRAIT_H) / PORTRAIT_W);
    sizeCanvas(canvas, size, h, dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, h);
    const kind = systemKind(spec);
    const s = size / 140;
    drawSystemObject(ctx, kind, size / 2, h - 6 * s, kind === "tower" ? s * 0.9 : s, { active: false }, palette);
    return;
  }
  const w = crispWidth(size, dpr);
  const ph = (w * PORTRAIT_H) / PORTRAIT_W;
  const gridPx = w / PORTRAIT_W;
  const s = Math.max(w, 40) / 96;
  const badgeH = Math.max(13, 15 * s);
  const badgeY = ph - 2 * gridPx;
  const h = Math.ceil(spec.style === "agent" ? badgeY + badgeH : ph);
  sizeCanvas(canvas, size, h, dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, h);
  ctx.imageSmoothingEnabled = false;
  const x = Math.round(((size - w) / 2) * dpr) / dpr;
  ctx.drawImage(portraitGrid(spec), x, 0, w, ph);
  if (spec.style === "agent") drawBadge(ctx, size / 2, badgeY, spec.badge, s);
}

function sizeCanvas(canvas: HTMLCanvasElement, w: number, h: number, dpr: number): void {
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
}
