// QA for the stage (theater-1016): every text-bearing box the stage draws in a frame is recorded with its kind and
// owner, so a headless sweep (video/qa-overlap.mjs) and node tests can count what overlaps what. Pure functions;
// nothing here draws. Erasable TypeScript only.

export interface QaRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a box is: text the audience reads, a person on the floor, or chrome that frames the stage. */
export type QaKind =
  | "label" | "name" | "bubble" | "callout" | "pill" | "card" | "caption" | "tag" | "sheet"
  | "figure" | "subtitle" | "chrome" | "travel";

export interface QaBox extends QaRect {
  kind: QaKind;
  /** the actor or place the box belongs to ("actor:code-agent", "place:ci-tower"); a box never collides with its own */
  owner?: string;
  /** short text, for the report */
  text?: string;
}

export interface QaPair {
  a: QaBox;
  b: QaBox;
  area: number;
}

export function overlapArea(a: QaRect, b: QaRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const TEXT: ReadonlySet<QaKind> = new Set<QaKind>(["label", "name", "bubble", "callout", "pill", "card", "caption", "tag",
  "sheet", "subtitle", "chrome"]);

export function isText(k: QaKind): boolean {
  return TEXT.has(k);
}

/**
 * Text over text: every pair of text boxes of different owners that share more than `minArea` square stage pixels
 * (a hairline touch is not an overlap). Moving things (packets in flight) are left out: they cross labels on purpose.
 */
export function textCollisions(boxes: QaBox[], minArea = 6): QaPair[] {
  const t = boxes.filter((b) => isText(b.kind));
  const out: QaPair[] = [];
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      const a = t[i];
      const b = t[j];
      if (a.owner && a.owner === b.owner) continue;
      if (a.kind === "chrome" && b.kind === "chrome") continue;
      const area = overlapArea(a, b);
      if (area > minArea) out.push({ a, b, area });
    }
  }
  return out;
}

/**
 * Text over people: a text box that covers more than `minShare` of another owner's figure (a name tag under its own
 * person is fine; a bubble over somebody else's face is not). Figures over figures are not counted: people stand
 * together at a desk.
 */
export function figureCollisions(boxes: QaBox[], minShare = 0.08): QaPair[] {
  const figs = boxes.filter((b) => b.kind === "figure");
  const out: QaPair[] = [];
  for (const b of boxes) {
    if (!isText(b.kind) || b.kind === "chrome" || b.kind === "subtitle") continue;
    for (const f of figs) {
      if (b.owner && b.owner === f.owner) continue;
      const area = overlapArea(b, f);
      if (area > minShare * f.w * f.h) out.push({ a: b, b: f, area });
    }
  }
  return out;
}

export function describe(p: QaPair): string {
  const s = (b: QaBox) => `${b.kind}${b.owner ? `(${b.owner})` : ""}${b.text ? ` "${b.text.slice(0, 32)}"` : ""}`;
  return `${s(p.a)} × ${s(p.b)} · ${Math.round(p.area)} px²`;
}
