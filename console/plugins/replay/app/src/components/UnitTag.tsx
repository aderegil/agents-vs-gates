// Unit glyph + label for the HUD: the same neutral monograms as the console (console/web/lib/units.js is the source
// of truth; keep the two in step). Not the vendors' logos; the glyph never appears without its label.
import type { ReactElement } from "react";

const FRAME = <rect x="3" y="3" width="18" height="18" rx="4" />;
const C = (cx: number) => <path d={`M${(cx + 2.47).toFixed(2)} 9.53A3.5 3.5 0 1 0 ${(cx + 2.47).toFixed(2)} 14.47`} />;

const GLYPHS: Record<string, ReactElement> = {
  CC: <>{FRAME}{C(9.3)}{C(15.8)}</>,
  CX: <>{FRAME}{C(9)}<path d="M13 8.5l5.5 7" /><path d="M18.5 8.5l-5.5 7" /></>,
  M: <><rect x="3" y="3" width="18" height="18" rx="4" strokeDasharray="2.2 2.2" /><path d="M8.5 15.5v-7l3.5 4 3.5-4v7" /></>,
  "?": <>{FRAME}<path d="M12 15.5h.01" /></>,
};

const UNITS: Record<string, { mono: string; product: string; model: string | null }> = {
  "cc-sonnet": { mono: "CC", product: "Claude Code", model: "Sonnet" },
  "cc-opus": { mono: "CC", product: "Claude Code", model: "Opus" },
  codex: { mono: "CX", product: "Codex", model: null },
  mock: { mono: "M", product: "Mock agent", model: null },
  "agy-flash": { mono: "?", product: "Antigravity CLI", model: "Gemini 3.8 Flash" },   // P8 (addendum 1)
};

export function unitInfo(unit?: string | null) {
  const u = String(unit ?? "");
  const k = UNITS[u] ?? (u.startsWith("cc-")
    ? { mono: "CC", product: "Claude Code", model: u.slice(3, 4).toUpperCase() + u.slice(4) }
    : { mono: "?", product: u || "unknown unit", model: null });
  return { ...k, unit: u, label: k.model ? `${k.product} · ${k.model}` : k.product };
}

/** "CC Claude Code · Sonnet": for places that can only hold text (the canvas legend). */
export const unitText = (unit?: string | null) => { const i = unitInfo(unit); return `${i.mono === "?" ? "" : `${i.mono} `}${i.label}`; };

export function UnitTag({ unit, size = 16 }: { unit?: string | null; size?: number }): ReactElement {
  const i = unitInfo(unit);
  return (
    <span className="unit-tag" title={i.unit}>
      <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {GLYPHS[i.mono] ?? GLYPHS["?"]}
      </svg>
      <span>{i.label}</span>
    </span>
  );
}
