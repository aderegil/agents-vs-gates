// Unit glyphs: a neutral monogram in a rounded-square outline, drawn with the same 1.5px stroke as the Lucide icons
// (class "icon", stroke from --trazo), no color. They are not the vendors' logos: the repo is public and shown on
// stage, so no trademark artwork. The glyph always goes next to its text label (unitTag), never alone.
//   CC  Claude Code units (cc-sonnet, cc-opus)    CX  Codex    M (dashed outline)  the mock agent
// Pure module (no DOM): the shell, the plugins and the tests import it.

const FRAME = '<rect x="3" y="3" width="18" height="18" rx="4"/>';
const FRAME_DASHED = '<rect x="3" y="3" width="18" height="18" rx="4" stroke-dasharray="2.2 2.2"/>';
// a C of radius 3.5 centred on (cx, 12), open on the right
const C = (cx) => `<path d="M${(cx + 2.47).toFixed(2)} 9.53A3.5 3.5 0 1 0 ${(cx + 2.47).toFixed(2)} 14.47"/>`;

export const GLYPHS = {
  CC: FRAME + C(9.3) + C(15.8),
  CX: FRAME + C(9) + '<path d="M13 8.5l5.5 7"/><path d="M18.5 8.5l-5.5 7"/>',
  M: FRAME_DASHED + '<path d="M8.5 15.5v-7l3.5 4 3.5-4v7"/>',
  "?": FRAME + '<path d="M12 15.5h.01"/>',
};

const UNITS = {
  "cc-sonnet": { mono: "CC", product: "Claude Code", model: "Sonnet" },
  "cc-opus": { mono: "CC", product: "Claude Code", model: "Opus" },
  codex: { mono: "CX", product: "Codex", model: null },
  mock: { mono: "M", product: "Mock agent", model: null, mock: true },
};

/** {unit, mono, product, model, mock, label} for a unit id; unknown ids keep their own name. */
export function unitInfo(unit) {
  const u = String(unit ?? "");
  const known = UNITS[u] || (u.startsWith("cc-") ? { mono: "CC", product: "Claude Code", model: u.slice(3, 4).toUpperCase() + u.slice(4) } : null);
  const info = known ? { ...known } : { mono: "?", product: u || "unknown unit", model: null };
  info.unit = u;
  info.mock = !!info.mock;
  info.label = info.model ? `${info.product} · ${info.model}` : info.product;
  return info;
}

/** SVG markup for a unit's glyph (trusted, built here). */
export function unitGlyph(unit, size = 16) {
  const s = Number(size) || 16;
  const { mono } = unitInfo(unit);
  return `<svg class="icon unit-glyph" viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true" focusable="false">${GLYPHS[mono] ?? GLYPHS["?"]}</svg>`;
}

/** Label text with the monogram, for places that can only hold text (a <select> option, a chart caption). */
export function unitText(unit) {
  const i = unitInfo(unit);
  return `${i.mono} ${i.label}`;
}
