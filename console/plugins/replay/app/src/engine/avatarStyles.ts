// The three avatar styles of the Replay Theater (spec 22.5 item 3). Shared with the Teams & Avatars plugin through
// the library build (src/avatar-lib.ts -> console/plugins/teams/web/avatar.js), so a role's character looks the
// same everywhere: same seed in, same pixels out.
//   human  : pixel-souls' generator as-is (skin, hair, clothes by seed)
//   agent  : same pixel family, cool synthetic palette, helmet with a visor, accent outline, "AI · <model>" badge
//   system : objects, not people (CI tower with one light per check, staging bench, dispatch board). They light up.
import { GRID_H, GRID_W, paintAvatar } from "./avatar";
import { agentAppearance, generateAppearance } from "./appearance";
import { hashString } from "./rng";

export type AvatarStyle = "human" | "agent" | "system";

export interface AvatarSpec {
  style: AvatarStyle;
  seed: string;
  badge?: string | null;
  role?: string | null;
}

export const ACCENT = "#2563eb";
export const PASS = "#00BCD4";
export const FAIL = "#E91E63";
const HUMAN_ACCENT = "#5b6474";

/** Portrait grid: pixel-souls' 22×28 head-and-shoulders, padded so the agent outline fits. */
export const PAD_X = 2;
export const PAD_TOP = 2;
export const PORTRAIT_W = GRID_W + PAD_X * 2;
export const PORTRAIT_H = GRID_H + PAD_TOP;

function hexRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

/** Paints the padded portrait grid (PORTRAIT_W × PORTRAIT_H) of a human or agent into a 2D context. */
export function paintPortrait(ctx: CanvasRenderingContext2D, spec: AvatarSpec): void {
  const seedNum = hashString(spec.seed);
  const base = document.createElement("canvas");
  base.width = GRID_W;
  base.height = GRID_H;
  const bctx = base.getContext("2d");
  if (!bctx) return;
  const appearance =
    spec.style === "agent" ? agentAppearance(spec.seed, ACCENT) : generateAppearance(spec.seed, HUMAN_ACCENT);
  paintAvatar(bctx, { appearance, mood: 0, seed: seedNum });
  ctx.clearRect(0, 0, PORTRAIT_W, PORTRAIT_H);
  ctx.drawImage(base, PAD_X, PAD_TOP);
  if (spec.style !== "agent") return;

  const img = ctx.getImageData(0, 0, PORTRAIT_W, PORTRAIT_H);
  const d = img.data;
  const at = (x: number, y: number) => (y * PORTRAIT_W + x) * 4;
  const set = (x: number, y: number, hex: string, alpha = 255) => {
    if (x < 0 || y < 0 || x >= PORTRAIT_W || y >= PORTRAIT_H) return;
    const [r, g, b] = hexRgb(hex);
    const i = at(x, y);
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = alpha;
  };
  const opaque = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < PORTRAIT_W && y < PORTRAIT_H && d[at(x, y) + 3] > 0;

  // Helmet: a shell over the top of the head, ear pieces, and a visor band across the eyes.
  const cx = PAD_X + GRID_W / 2;
  const cy = PAD_TOP + 10.5;
  const shell = appearance.hairColor;
  for (let y = 0; y < PORTRAIT_H; y++) {
    for (let x = 0; x < PORTRAIT_W; x++) {
      const dx = (x - cx) / 6.3;
      const dy = (y - cy) / 7.1;
      if (dx * dx + dy * dy <= 1 && y <= cy - 2.4) set(x, y, x < cx - 1 ? "#475569" : shell);
    }
  }
  for (const side of [-1, 1]) {
    const ex = Math.round(cx + side * 6) - (side > 0 ? 1 : 0);
    for (let y = Math.round(cy - 2); y <= Math.round(cy + 1); y++) {
      set(ex, y, shell);
      set(ex + (side > 0 ? 1 : -1), y, shell);
    }
    set(ex, Math.round(cy - 1), ACCENT);
  }
  const visorY = Math.round(cy - 0.5);
  for (let x = Math.round(cx - 4.5); x <= Math.round(cx + 3.5); x++) {
    set(x, visorY - 1, "#1e40af");
    set(x, visorY, ACCENT);
  }
  set(Math.round(cx - 3.5), visorY - 1, "#93c5fd");
  // Helmet variant by seed (plain / antenna / crest) so agents are told apart while staying one family.
  const variant = seedNum % 3;
  const helmetTop = Math.ceil(cy - 7.1);
  if (variant === 1) {
    const ax = Math.round(cx + 2);
    for (let y = helmetTop - 2; y < helmetTop + 1; y++) set(ax, y, shell);
    set(ax, helmetTop - 3, ACCENT);
  } else if (variant === 2) {
    for (let x = Math.round(cx - 2); x <= Math.round(cx + 1); x++) set(x, helmetTop - 1, "#1e293b");
    for (let x = Math.round(cx - 1); x <= Math.round(cx); x++) set(x, helmetTop - 2, "#1e293b");
  }

  // Accent outline (1 px solid + 1 px faint) around the silhouette: the "this is software" cue.
  const ring1: [number, number][] = [];
  const ring2: [number, number][] = [];
  for (let y = 0; y < PORTRAIT_H; y++) {
    for (let x = 0; x < PORTRAIT_W; x++) {
      if (opaque(x, y)) continue;
      const n1 = opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1);
      if (n1) ring1.push([x, y]);
    }
  }
  for (const [x, y] of ring1) set(x, y, ACCENT);
  for (let y = 0; y < PORTRAIT_H; y++) {
    for (let x = 0; x < PORTRAIT_W; x++) {
      if (opaque(x, y)) continue;
      if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) ring2.push([x, y]);
    }
  }
  for (const [x, y] of ring2) set(x, y, ACCENT, 70);
  ctx.putImageData(img, 0, 0);
}

const portraitCache = new Map<string, HTMLCanvasElement>();

/** The unscaled portrait grid for a human/agent spec (cached by style+seed). */
export function portraitGrid(spec: AvatarSpec): HTMLCanvasElement {
  const key = `${spec.style}:${spec.seed}`;
  const hit = portraitCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = PORTRAIT_W;
  c.height = PORTRAIT_H;
  const ctx = c.getContext("2d");
  if (ctx) paintPortrait(ctx, spec);
  portraitCache.set(key, c);
  return c;
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
  bodyDark: string;
  idle: string;
}

export const LIGHT: Palette = {
  ink: "#111827",
  ink2: "#5b6474",
  line: "#e3e6eb",
  lineStrong: "#c4cad3",
  surface: "#ffffff",
  body: "#d9dee5",
  bodyDark: "#aeb6c2",
  idle: "#c4cad3",
};

export const DARK: Palette = {
  ink: "#e5e7eb",
  ink2: "#9aa3b2",
  line: "#2a2f38",
  lineStrong: "#3a414d",
  surface: "#151920",
  body: "#2b313b",
  bodyDark: "#1f242c",
  idle: "#3d4552",
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
    rect(ctx, x - 6 * s, baseY - 6 * s, w + 12 * s, 6 * s, p.bodyDark);
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
    rect(ctx, x + 6 * s, y + h, 6 * s, 14 * s, p.bodyDark);
    rect(ctx, x + w - 12 * s, y + h, 6 * s, 14 * s, p.bodyDark);
    rect(ctx, x, y, w, h, p.body, state.active ? ACCENT : p.lineStrong, 1.5);
    const slot = w / lights.length;
    lights.forEach((l, i) => {
      const mx = x + i * slot + slot * 0.18;
      const mw = slot * 0.64;
      rect(ctx, mx, y - 24 * s, mw, 20 * s, p.surface, p.lineStrong, 1);
      rect(ctx, mx + 3 * s, y - 21 * s, mw - 6 * s, 14 * s, lightColor(l, p));
      rect(ctx, mx + mw / 2 - 2 * s, y - 4 * s, 4 * s, 4 * s, p.bodyDark);
    });
    top = y - 24 * s;
  } else if (kind === "board") {
    const w = 96 * s;
    const h = 62 * s;
    const x = cx - w / 2;
    const y = baseY - h - 18 * s;
    rect(ctx, x + 10 * s, y + h, 5 * s, 18 * s, p.bodyDark);
    rect(ctx, x + w - 15 * s, y + h, 5 * s, 18 * s, p.bodyDark);
    rect(ctx, x, y, w, h, p.surface, state.active ? ACCENT : p.lineStrong, state.active ? 2 : 1.5);
    for (let i = 0; i < 4; i++) {
      const ry = y + 9 * s + i * 13 * s;
      rect(ctx, x + 8 * s, ry, 8 * s, 8 * s, i === 0 && state.active ? ACCENT : p.idle);
      rect(ctx, x + 22 * s, ry + 2 * s, (w - 34 * s) * (i % 2 ? 0.7 : 0.9), 4 * s, p.lineStrong);
    }
    top = y;
  } else {
    const w = 48 * s;
    const h = 44 * s;
    rect(ctx, cx - w / 2, baseY - h, w, h, p.body, state.active ? ACCENT : p.lineStrong, 1.5);
    rect(ctx, cx - 6 * s, baseY - h + 10 * s, 12 * s, 8 * s, state.active ? ACCENT : p.idle);
    top = baseY - h;
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
 * Renders a complete avatar card image (portrait, or system object) into `canvas` at `size` px wide.
 * Used by the Teams gallery; the theater draws the same portrait grid and objects on its stage.
 */
export function renderAvatar(canvas: HTMLCanvasElement, spec: AvatarSpec, size = 96,
  palette: Palette = LIGHT): void {
  const h = Math.round((size * PORTRAIT_H) / PORTRAIT_W) + (spec.style === "agent" ? Math.round(size * 0.2) : 0);
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, h);
  ctx.imageSmoothingEnabled = false;
  if (spec.style === "system") {
    const kind = systemKind(spec);
    const s = size / 140;
    drawSystemObject(ctx, kind, size / 2, h - 6 * s, kind === "tower" ? s * 0.9 : s, { active: false }, palette);
    return;
  }
  const grid = portraitGrid(spec);
  const ph = Math.round((size * PORTRAIT_H) / PORTRAIT_W);
  ctx.drawImage(grid, 0, 0, size, ph);
  if (spec.style === "agent") drawBadge(ctx, size / 2, ph - size * 0.02, spec.badge, size / 96);
}
