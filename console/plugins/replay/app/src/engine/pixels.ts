// Pixel-art primitives shared by the human and AI-agent portrait painters. Pure (no DOM): a portrait is painted into
// a PixelGrid (RGBA bytes), which the browser copies into a canvas and the tests hash. Same input, same bytes.
// Erasable TypeScript only (runs under `node --test` with type stripping).

export type RGB = [number, number, number];

export function hex(h: string): RGB {
  const c = h.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

export function toHex(c: RGB): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const WARM_LIGHT: RGB = [255, 246, 228];
const COOL_SHADE: RGB = [38, 30, 62];
const INK: RGB = [24, 20, 34];

/** A small hue-shifted ramp (light warm, shadow cool), the usual pixel-art way to shade a flat colour. */
export interface Ramp {
  hi: RGB;
  base: RGB;
  mid: RGB;
  lo: RGB;
  line: RGB;
}

export function ramp(base: RGB, outline: RGB = INK, strength = 1): Ramp {
  return {
    hi: mix(base, WARM_LIGHT, 0.24 * strength),
    base,
    mid: mix(base, COOL_SHADE, 0.17 * strength),
    lo: mix(base, COOL_SHADE, 0.34 * strength),
    line: mix(base, outline, 0.66),
  };
}

export type Mask = (px: number, py: number) => boolean;
export type Fill = (px: number, py: number, x: number, y: number) => RGB | null;

export class PixelGrid {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8ClampedArray;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  set(x: number, y: number, c: RGB | null | undefined): void {
    if (!c || !this.inside(x, y)) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = 255;
  }

  get(x: number, y: number): RGB | null {
    if (!this.inside(x, y)) return null;
    const i = (y * this.w + x) * 4;
    if (this.data[i + 3] === 0) return null;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  opaque(x: number, y: number): boolean {
    return this.inside(x, y) && this.data[(y * this.w + x) * 4 + 3] > 0;
  }

  /** Sets a pixel only where something is already painted (details that must stay inside a shape). */
  over(x: number, y: number, c: RGB | null | undefined): void {
    if (this.opaque(x, y)) this.set(x, y, c);
  }

  /**
   * Paints a shape: every pixel whose centre is inside `mask` gets `fill`, and (when `line` is given) every pixel
   * 4-adjacent to the shape gets the outline colour. Painting parts back to front with their own outline gives the
   * clean separations pixel artists draw by hand (chin over neck, fringe over forehead).
   */
  shape(mask: Mask, fill: Fill, line?: RGB | ((x: number, y: number) => RGB | null) | null,
    only?: (x: number, y: number) => boolean): void {
    const inMask = new Uint8Array(this.w * this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (mask(x + 0.5, y + 0.5)) inMask[y * this.w + x] = 1;
      }
    }
    const m = (x: number, y: number) => this.inside(x, y) && inMask[y * this.w + x] === 1;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!m(x, y)) continue;
        if (only && !only(x, y)) continue;
        this.set(x, y, fill(x + 0.5, y + 0.5, x, y));
      }
    }
    if (!line) return;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (m(x, y)) continue;
        if (!(m(x - 1, y) || m(x + 1, y) || m(x, y - 1) || m(x, y + 1))) continue;
        if (only && !only(x, y)) continue;
        this.set(x, y, typeof line === "function" ? line(x, y) : line);
      }
    }
  }

  /** Draws a small bitmap: each character maps to a colour through `palette` ('.' and ' ' are transparent). */
  bitmap(x0: number, y0: number, rows: readonly string[], palette: Record<string, RGB | null>, flip = false): void {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const ch = flip ? row[row.length - 1 - i] : row[i];
        if (ch === "." || ch === " ") continue;
        this.set(x0 + i, y0 + j, palette[ch] ?? null);
      }
    });
  }

  /** Copies another grid on top of this one, offset by (dx, dy). */
  blit(src: PixelGrid, dx: number, dy: number): void {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const c = src.get(x, y);
        if (c) this.set(x + dx, y + dy, c);
      }
    }
  }
}

/** FNV-1a over the RGBA bytes: the "pixel hash" the determinism tests compare. */
export function gridHash(g: PixelGrid): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < g.data.length; i++) {
    h ^= g.data[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Ellipse test with an optional superellipse exponent (n = 2 is a plain ellipse). */
export function inEllipse(px: number, py: number, cx: number, cy: number, rx: number, ry: number, n = 2): boolean {
  return Math.pow(Math.abs(px - cx) / rx, n) + Math.pow(Math.abs(py - cy) / ry, n) <= 1;
}

/** Axis-aligned rounded rectangle test (inclusive bounds in pixel-centre coordinates). */
export function inRoundRect(px: number, py: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r + 0.01;
}
