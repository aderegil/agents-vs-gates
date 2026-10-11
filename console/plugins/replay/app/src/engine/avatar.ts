import type { Appearance, HairStyle } from "./types";

// Procedurally paints a small pixel grid (GRID_W x GRID_H) representing a
// head-and-shoulders portrait, then the caller upscales it with
// imageSmoothingEnabled = false so it reads as crisp 2D pixel art while the
// underlying shape (oval head, shaded jaw, per-style hair) aims for a more
// believable silhouette than a blocky retro sprite.

export const GRID_W = 22;
export const GRID_H = 28;

interface PaintOptions {
  appearance: Appearance;
  /** -1 (miserable) .. 1 (delighted), reshapes eyebrows/mouth live. */
  mood: number;
  /** deterministic per-character jitter so faces aren't all identical ovals */
  seed: number;
}

function shade(hex: string, amount: number): string {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const adj = (v: number) => Math.max(0, Math.min(255, Math.round(v + amount)));
  return `rgb(${adj(r)}, ${adj(g)}, ${adj(b)})`;
}

function seededJitter(seed: number, salt: number): number {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const HEAD_CX = GRID_W / 2;
const HEAD_CY = 10.5;
const HEAD_RX = 5.6;
const HEAD_RY = 6.4;

function isInHead(x: number, y: number): boolean {
  const dx = (x - HEAD_CX) / HEAD_RX;
  const dy = (y - HEAD_CY) / HEAD_RY;
  return dx * dx + dy * dy <= 1;
}

function hairCovers(style: HairStyle, x: number, y: number, jitter: number): boolean {
  const dx = (x - HEAD_CX) / HEAD_RX;
  const dy = (y - HEAD_CY - 1) / (HEAD_RY + 1);
  const inHeadish = dx * dx + dy * dy <= 1.05 + jitter * 0.08;
  const topBand = y <= HEAD_CY - 1.5 + jitter * 1.5;

  switch (style) {
    case "bald":
      return topBand && y <= HEAD_CY - 4.5 && inHeadish;
    case "short":
      return inHeadish && topBand;
    case "curly": {
      const bumpy = seededJitter(x * 3.1 + 1, y * 1.7) > 0.35;
      return inHeadish && (topBand || (y < HEAD_CY + 1 && bumpy && Math.abs(x - HEAD_CX) > HEAD_RX - 2));
    }
    case "bun":
      return (inHeadish && topBand) || (y < HEAD_CY - 5.5 && Math.abs(x - HEAD_CX) < 2);
    case "long":
      return (
        (inHeadish && topBand) ||
        (y >= HEAD_CY - 1 && y < GRID_H - 3 && Math.abs(x - HEAD_CX) > HEAD_RX - 2.2)
      );
    default:
      return false;
  }
}

export function paintAvatar(ctx: CanvasRenderingContext2D, options: PaintOptions): void {
  const { appearance, mood, seed } = options;
  const img = ctx.createImageData(GRID_W, GRID_H);
  const setPixel = (x: number, y: number, hex: string, alpha = 255) => {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    const idx = (y * GRID_W + x) * 4;
    const c = hex.startsWith("rgb")
      ? hex.match(/\d+/g)!.map(Number)
      : [
          parseInt(hex.slice(1, 3), 16),
          parseInt(hex.slice(3, 5), 16),
          parseInt(hex.slice(5, 7), 16),
        ];
    img.data[idx] = c[0];
    img.data[idx + 1] = c[1];
    img.data[idx + 2] = c[2];
    img.data[idx + 3] = alpha;
  };

  const jitter = seededJitter(seed, 4.2);

  // Shoulders / shirt.
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const shoulderTop = 17 - Math.abs(x - HEAD_CX) * 0.35;
      if (y >= shoulderTop) {
        const lit = x < HEAD_CX ? shade(appearance.shirtColor, 14) : shade(appearance.shirtColor, -10);
        setPixel(x, y, lit);
      }
    }
  }

  // Neck.
  for (let y = 15; y < 19; y++) {
    for (let x = HEAD_CX - 1.5; x <= HEAD_CX + 1.5; x++) {
      setPixel(Math.round(x), y, shade(appearance.skinTone, -12));
    }
  }

  // Head with simple top-left light shading for a rounder, less-flat look.
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (!isInHead(x, y)) continue;
      const dx = x - HEAD_CX;
      const dy = y - HEAD_CY;
      const lightDot = -dx * 0.7 - dy * 0.5;
      let tone = appearance.skinTone;
      if (lightDot > 3) tone = shade(tone, 18);
      else if (lightDot < -3.2) tone = shade(tone, -22);
      else if (lightDot < -1) tone = shade(tone, -8);
      setPixel(x, y, tone);
    }
  }

  // Hair.
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (!hairCovers(appearance.hairStyle, x, y, jitter)) continue;
      const dx = x - HEAD_CX;
      const tone = dx < -1 ? shade(appearance.hairColor, 10) : shade(appearance.hairColor, -6);
      setPixel(x, y, tone);
    }
  }

  // Eyebrows react to mood: furrowed/low when unhappy, raised when delighted.
  const browLift = mood < -0.25 ? 0 : mood > 0.35 ? -1 : -0.3;
  const browY = Math.round(HEAD_CY - 1.6 + browLift);
  for (const ex of [HEAD_CX - 2, HEAD_CX + 2]) {
    setPixel(Math.round(ex - 0.5), browY, shade(appearance.hairColor, -10));
    setPixel(Math.round(ex + 0.5), browY, shade(appearance.hairColor, -10));
  }

  // Eyes.
  const eyeY = Math.round(HEAD_CY - 0.5);
  setPixel(Math.round(HEAD_CX - 2), eyeY, appearance.eyeColor);
  setPixel(Math.round(HEAD_CX + 2), eyeY, appearance.eyeColor);

  // Mouth shape driven by mood.
  const mouthY = Math.round(HEAD_CY + 2.6);
  const mouthColor = shade(appearance.skinTone, -45);
  if (mood > 0.25) {
    setPixel(HEAD_CX - 1, mouthY, mouthColor);
    setPixel(HEAD_CX, mouthY + 1, mouthColor);
    setPixel(HEAD_CX + 1, mouthY, mouthColor);
  } else if (mood < -0.25) {
    setPixel(HEAD_CX - 1, mouthY + 1, mouthColor);
    setPixel(HEAD_CX, mouthY, mouthColor);
    setPixel(HEAD_CX + 1, mouthY + 1, mouthColor);
  } else {
    setPixel(HEAD_CX - 1, mouthY, mouthColor);
    setPixel(HEAD_CX, mouthY, mouthColor);
    setPixel(HEAD_CX + 1, mouthY, mouthColor);
  }

  // Cheeks: faint blush for warmth.
  setPixel(Math.round(HEAD_CX - 3.2), Math.round(HEAD_CY + 1), shade(appearance.skinTone, -6), 160);
  setPixel(Math.round(HEAD_CX + 3.2), Math.round(HEAD_CY + 1), shade(appearance.skinTone, -6), 160);

  // Small accent badge on the shoulder (role/scenario color cue).
  setPixel(Math.round(HEAD_CX + 3), GRID_H - 3, appearance.accentColor);
  setPixel(Math.round(HEAD_CX + 4), GRID_H - 3, appearance.accentColor);

  ctx.putImageData(img, 0, 0);
}

export function drawAvatar(
  canvas: HTMLCanvasElement,
  options: PaintOptions,
  displaySize = 96,
): void {
  const off = document.createElement("canvas");
  off.width = GRID_W;
  off.height = GRID_H;
  const offCtx = off.getContext("2d");
  if (!offCtx) return;
  paintAvatar(offCtx, options);

  canvas.width = displaySize;
  canvas.height = Math.round((displaySize * GRID_H) / GRID_W);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}
