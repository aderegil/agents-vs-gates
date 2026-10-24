// The theater's diff cards in the usual diff colours (Alfredo's review, 2026-10-24, round 5): added lines on light
// green with dark green ink, removed lines on light red with dark red ink and a strike. Erasable TypeScript only.

export const DIFF = {
  add: { bg: "#e6ffec", ink: "#116329" },
  del: { bg: "#ffebe9", ink: "#82071e" },
} as const;

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** WCAG contrast ratio between two #rrggbb colours (1..21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
