// Hand-made SVG charts for the Results plugin (spec 22.3). No libraries, no DOM: every function here is pure and
// returns strings or numbers, so the same code draws in the browser (index.js) and under Node (render-cli.mjs for
// the server-side export, charts.test.mjs for the tests).
//
// Three chart kinds, all described by plain JSON specs built in payload.py:
//   interval  rows of {group,label,sub,x,n,ci:[lo,hi],tone}  → a point and a Clopper-Pearson interval, "x of N" in text
//   stacked   rows of {group,label,sub,n,segments:[{key,value}]} + series [{key,label,tone}] → counts as stacked bars
//   matrix    panels of 2×2 counts (mutation test, CI vs. oracle)
// Two styles: "app" (the console's light style) and "deck" (black, deck purple, cyan = pass, pink = fail).
// Two modes: renderChart() draws the chart alone (on screen); renderSlide() draws a 1920×1080 slide with title,
// source note bottom left and, for a mock namespace, a MOCK watermark that cannot be turned off.

export const SLIDE = { w: 1920, h: 1080 };

// ------------------------------------------------------------------ math

/** Linear scale. s(v) maps the domain to the range; s.invert maps back. A zero-width domain maps to the range start. */
export function linearScale([d0, d1], [r0, r1]) {
  const span = d1 - d0;
  const s = (v) => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0));
  s.invert = (p) => (r1 === r0 ? d0 : d0 + ((p - r0) / (r1 - r0)) * span);
  s.domain = [d0, d1];
  s.range = [r0, r1];
  return s;
}

/** Ticks of a proportion axis: minimal, three marks. */
export function proportionTicks() {
  return [0, 0.5, 1];
}

/** "Nice" ticks (1, 2, 5 × 10^k) covering [lo, hi] with about `count` marks. */
export function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** Geometry of one interval row on a proportion axis [0,1] mapped to [x0,x1]. Everything is clamped inside the plot. */
export function intervalGeometry(row, x0, x1) {
  const s = linearScale([0, 1], [x0, x1]);
  const clamp = (v) => Math.min(x1, Math.max(x0, v));
  const p = row.n > 0 ? row.x / row.n : 0;
  const [lo, hi] = row.ci && row.ci.length === 2 ? row.ci : [p, p];
  return { px: clamp(s(p)), lo: clamp(s(Math.min(lo, p))), hi: clamp(s(Math.max(hi, p))) };
}

/** Segments of a stacked bar normalised to the row total, laid out from x0 to x1. Zero-valued segments are skipped. */
export function stackLayout(segments, x0, x1) {
  const total = segments.reduce((a, s) => a + (s.value || 0), 0);
  if (total <= 0) return [];
  const out = [];
  let acc = 0;
  for (const s of segments) {
    if (!s.value) continue;
    const a = x0 + ((x1 - x0) * acc) / total;
    acc += s.value;
    const b = x0 + ((x1 - x0) * acc) / total;
    out.push({ key: s.key, value: s.value, x: a, w: b - a });
  }
  return out;
}

/** Rough text width for IBM Plex Sans / Graphik (tabular digits are 0.6 em, letters average 0.53 em). */
export function estWidth(text, size) {
  let w = 0;
  for (const ch of String(text)) {
    if (ch >= "0" && ch <= "9") w += 0.6;
    else if ("il.,:;'|![]() ·".includes(ch)) w += 0.3;
    else if ("mwMW—…".includes(ch)) w += 0.82;
    else if (ch >= "A" && ch <= "Z") w += 0.64;
    else w += 0.53;
  }
  return w * size;
}

export function truncate(text, maxW, size) {
  const s = String(text);
  if (estWidth(s, size) <= maxW) return s;
  let out = s;
  while (out.length > 1 && estWidth(out + "…", size) > maxW) out = out.slice(0, -1);
  return out.trimEnd() + "…";
}

/** Greedy word wrap by estimated width. */
export function wrapText(text, maxW, size) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (cur && estWidth(next, size) > maxW) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// "x of N" and the interval, never a percentage (spec 14.1: no percentages with N < 20; here, none at all).
export const fmtXofN = (x, n) => `${x} of ${n}`;
export const fmtCI = (ci) => (ci ? `[${ci[0].toFixed(2)}, ${ci[1].toFixed(2)}]` : "");

// ------------------------------------------------------------------ themes

const PLEX = "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

export const THEMES = {
  app: {
    id: "app", bg: "#ffffff", ink: "#111827", muted: "#5b6474", faint: "#8a93a3", line: "#e3e6eb", rule: "#c4cad3",
    groupInk: "#5b6474", accent: "#2563eb", font: PLEX,
    tones: {
      pass: ["#00BCD4", "#00323a"], "pass-soft": ["#a6e8f1", "#00323a"], fail: ["#E91E63", "#ffffff"],
      "fail-soft": ["#f6a9c3", "#5a0a26"], n1: ["#374151", "#ffffff"], n2: ["#7b8494", "#ffffff"],
      n3: ["#b7bfcc", "#111827"], n4: ["#e3e6eb", "#111827"],
    },
    passInk: "#00727f", failInk: "#b0124a",
  },
  deck: {
    id: "deck", bg: "#000000", ink: "#ffffff", muted: "#8E8E9C", faint: "#6a6a78", line: "#2A2533", rule: "#3d3550",
    groupInk: "#C1A3FF", accent: "#A000FF", font: `Graphik, 'Graphik Regular', ${PLEX}`,
    tones: {
      pass: ["#00BCD4", "#001f24"], "pass-soft": ["#0b6a77", "#ffffff"], fail: ["#E91E63", "#ffffff"],
      "fail-soft": ["#8a1a47", "#ffffff"], n1: ["#E6DCFF", "#1a0030"], n2: ["#C1A3FF", "#1a0030"],
      n3: ["#7400C0", "#ffffff"], n4: ["#2A2533", "#D8D8E0"],
    },
    passInk: "#00BCD4", failInk: "#E91E63",
  },
};

export const toneFill = (theme, tone) => (theme.tones[tone] || theme.tones.n1)[0];
export const toneOn = (theme, tone) => (theme.tones[tone] || theme.tones.n1)[1];

// ------------------------------------------------------------------ svg primitives

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r2 = (n) => Math.round(n * 100) / 100;

function text(x, y, s, { size = 12.5, weight = 400, fill, anchor = "start", opacity, transform, spacing } = {}) {
  return `<text x="${r2(x)}" y="${r2(y)}" font-size="${r2(size)}"${weight !== 400 ? ` font-weight="${weight}"` : ""}` +
    ` fill="${fill}"${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}${opacity != null ? ` opacity="${opacity}"` : ""}` +
    `${spacing ? ` letter-spacing="${spacing}"` : ""}${transform ? ` transform="${transform}"` : ""}>${esc(s)}</text>`;
}
const rect = (x, y, w, h, fill, extra = "") => `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(Math.max(0, w))}" height="${r2(h)}" fill="${fill}"${extra}/>`;
const line = (x1, y1, x2, y2, stroke, sw = 1, extra = "") => `<line x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}" stroke="${stroke}" stroke-width="${sw}"${extra}/>`;

// Scale-1 metrics. The slide mode multiplies everything by k (see renderSlide).
const M = { fs: 12.5, small: 11, rowH: 26, groupH: 24, head: 18, axisH: 36, gap: 14, bar: 16 };

function columns(W) {
  const labelW = Math.round(Math.min(250, Math.max(150, W * 0.3)));
  const xofnW = 58, ciW = 84;
  return { labelW, px0: labelW + 14, valueW: xofnW + ciW + 8, xofnW, ciW };
}

function groupHeader(theme, y, W, label, first) {
  const top = first ? 0 : M.gap * 0.4;
  return text(0, y + top + 15, label, { size: M.small, weight: 600, fill: theme.groupInk, spacing: 0.2 }) +
    line(0, y + top + 20, W, y + top + 20, theme.line, 1);
}

// ------------------------------------------------------------------ interval chart

function intervalBody(spec, W, theme) {
  const c = columns(W);
  const px0 = c.px0, px1 = W - c.valueW - 14;
  const rows = spec.rows || [];
  let y = M.head;
  const parts = [];
  const body = [];
  let last = null;
  const geo = [];
  rows.forEach((r) => {
    if (r.group && r.group !== last) {
      body.push(groupHeader(theme, y, W, r.group, last === null));
      y += M.groupH + (last === null ? 0 : M.gap * 0.4);
      last = r.group;
    }
    geo.push({ r, cy: y + M.rowH / 2 });
    y += M.rowH;
  });
  const bottom = y;
  // grid and axis
  const ticks = proportionTicks();
  const sx = linearScale([0, 1], [px0, px1]);
  const grid = ticks.map((t) => line(sx(t), M.head, sx(t), bottom, t === 0 ? theme.rule : theme.line, 1, t === 0 ? "" : ' stroke-dasharray="2 3"')).join("");
  const axis = ticks.map((t) => text(sx(t), bottom + 14, t === 0 ? "0" : t === 1 ? "1" : "0.5", { size: M.small, fill: theme.muted, anchor: "middle" })).join("") +
    text((px0 + px1) / 2, bottom + 29, `${spec.axis || "share of runs"} · point = x/N, bar = 95% Clopper-Pearson interval`,
      { size: M.small, fill: theme.faint, anchor: "middle" });
  parts.push(text(W - c.valueW, 11, "Runs", { size: M.small, fill: theme.muted, weight: 500 }));
  parts.push(text(W - c.valueW + c.xofnW + 8, 11, "95% interval", { size: M.small, fill: theme.muted, weight: 500 }));
  parts.push(grid);
  parts.push(body.join(""));
  for (const { r, cy } of geo) {
    const g = intervalGeometry(r, px0, px1);
    const tone = r.tone || spec.tone || "fail";
    const fill = toneFill(theme, tone);
    const subW = r.sub ? estWidth(r.sub, M.small) + 6 : 0;
    parts.push(`<g><title>${esc(`${r.label} ${r.sub || ""}: ${fmtXofN(r.x, r.n)} ${fmtCI(r.ci)}`.replace(/\s+/g, " "))}</title>`);
    parts.push(text(0, cy + 4.3, truncate(r.label, c.labelW - subW - 4, M.fs), { size: M.fs, weight: 500, fill: theme.ink }));
    if (r.sub) parts.push(text(c.labelW, cy + 4.3, r.sub, { size: M.small, fill: theme.muted, anchor: "end" }));
    parts.push(line(g.lo, cy, g.hi, cy, fill, 3, ' stroke-linecap="round"'));
    parts.push(line(g.lo, cy - 4.5, g.lo, cy + 4.5, fill, 1.6));
    parts.push(line(g.hi, cy - 4.5, g.hi, cy + 4.5, fill, 1.6));
    parts.push(`<circle cx="${r2(g.px)}" cy="${r2(cy)}" r="5" fill="${fill}" stroke="${theme.bg}" stroke-width="1.5"/>`);
    parts.push(text(W - c.valueW, cy + 4.3, fmtXofN(r.x, r.n), { size: M.fs, weight: 600, fill: theme.ink }));
    parts.push(text(W - c.valueW + c.xofnW + 8, cy + 4.3, fmtCI(r.ci), { size: M.small + 0.5, fill: theme.muted }));
    parts.push("</g>");
  }
  parts.push(axis);
  return { svg: parts.join(""), h: bottom + M.axisH };
}

// ------------------------------------------------------------------ stacked chart

function legend(theme, spec, W, y0) {
  const present = (spec.series || []).filter((s) => (spec.rows || []).some((r) => (r.segments || []).some((g) => g.key === s.key && g.value > 0)));
  let x = 0, y = y0;
  const out = [];
  for (const s of present) {
    const w = 14 + estWidth(s.label, M.small) + 18;
    if (x > 0 && x + w > W) { x = 0; y += 18; }
    out.push(rect(x, y + 2, 10, 10, toneFill(theme, s.tone), ' rx="2"') + text(x + 15, y + 11, s.label, { size: M.small, fill: theme.muted }));
    x += w;
  }
  return { svg: out.join(""), h: present.length ? y - y0 + 22 : 0 };
}

function stackedBody(spec, W, theme) {
  const c = columns(W);
  const nW = 64;
  const px0 = c.px0, px1 = W - nW - 8;
  const lg = legend(theme, spec, W, 0);
  let y = lg.h + 4;
  const parts = [lg.svg];
  let last = null;
  const toneOf = Object.fromEntries((spec.series || []).map((s) => [s.key, s.tone]));
  const labelOf = Object.fromEntries((spec.series || []).map((s) => [s.key, s.label]));
  for (const r of spec.rows || []) {
    if (r.group && r.group !== last) {
      parts.push(groupHeader(theme, y, W, r.group, last === null));
      y += M.groupH + (last === null ? 0 : M.gap * 0.4);
      last = r.group;
    }
    const cy = y + M.rowH / 2;
    const subW = r.sub ? estWidth(r.sub, M.small) + 6 : 0;
    parts.push(`<g><title>${esc(`${r.label} ${r.sub || ""}: ` + (r.segments || []).filter((g) => g.value).map((g) => `${labelOf[g.key] || g.key} ${g.value}`).join(", ") + ` (${spec.nLabel || "N"} = ${r.n})`)}</title>`);
    parts.push(text(0, cy + 4.3, truncate(r.label, c.labelW - subW - 4, M.fs), { size: M.fs, weight: 500, fill: theme.ink }));
    if (r.sub) parts.push(text(c.labelW, cy + 4.3, r.sub, { size: M.small, fill: theme.muted, anchor: "end" }));
    for (const s of stackLayout(r.segments || [], px0, px1)) {
      const tone = toneOf[s.key] || "n1";
      parts.push(rect(s.x, cy - M.bar / 2, s.w, M.bar, toneFill(theme, tone), ` stroke="${theme.bg}" stroke-width="1"`));
      const label = String(s.value);
      if (s.w >= estWidth(label, M.small) + 5) {
        parts.push(text(s.x + s.w / 2, cy + 3.9, label, { size: M.small, weight: 600, fill: toneOn(theme, tone), anchor: "middle" }));
      }
    }
    parts.push(text(W, cy + 4.3, `${spec.nLabel || "N"} = ${r.n}`, { size: M.small + 0.5, fill: theme.muted, anchor: "end" }));
    parts.push("</g>");
    y += M.rowH;
  }
  return { svg: parts.join(""), h: y + 6 };
}

// ------------------------------------------------------------------ matrix chart (2×2 panels)

function matrixBody(spec, W, theme) {
  const panels = spec.panels || [];
  const big = panels.length === 1;
  const rowLabW = big ? 120 : 124;
  const cellW = big ? Math.min(250, (W - rowLabW - 8) / 2) : 104;
  const cellH = big ? 92 : 58;
  const panelW = rowLabW + cellW * 2;
  const cols = Math.max(1, Math.min(panels.length, Math.floor((W + 18) / (panelW + 18))));
  const parts = [];
  let maxH = 0;
  const heads = 38;
  panels.forEach((p, i) => {
    const col = i % cols, rowI = Math.floor(i / cols);
    const ph = heads + cellH * 2 + 22;
    const ox = col * (panelW + 18), oy = rowI * (ph + 14);
    maxH = Math.max(maxH, oy + ph);
    const t = `${p.title}${p.note ? ` · ${p.note}` : ""}`;
    if (p.title) parts.push(text(ox, oy + 12, truncate(t, panelW, M.fs), { size: M.fs, weight: 600, fill: theme.ink }));
    parts.push(text(ox + rowLabW + cellW, oy + 28, spec.colAxis || "", { size: M.small, fill: theme.faint, anchor: "middle" }));
    (spec.colNames || []).forEach((n, j) => parts.push(text(ox + rowLabW + cellW * j + cellW / 2, oy + 41, n, { size: M.small, weight: 500, fill: theme.muted, anchor: "middle" })));
    parts.push(text(ox, oy + 41, spec.rowAxis || "", { size: M.small, fill: theme.faint }));
    (p.cells || []).forEach((row, a) => {
      const cy = oy + heads + 8 + cellH * a;
      parts.push(text(ox + rowLabW - 8, cy + cellH / 2 + 4, (spec.rowNames || [])[a] || "", { size: M.small, weight: 500, fill: theme.muted, anchor: "end" }));
      row.forEach((cell, b) => {
        const cx = ox + rowLabW + cellW * b;
        const tone = cell.count ? cell.tone : "n4"; // an empty cell is never painted pass or fail
        const fill = toneFill(theme, tone), on = toneOn(theme, tone);
        parts.push(`<g><title>${esc(`${p.title}: ${(spec.rowNames || [])[a]} / ${(spec.colNames || [])[b]}: ${cell.count}${cell.items && cell.items.length ? " (" + cell.items.join(", ") + ")" : ""}`)}</title>`);
        parts.push(rect(cx, cy, cellW - 3, cellH - 3, fill, ' rx="3"'));
        parts.push(text(cx + (cellW - 3) / 2, cy + (big ? 38 : cellH / 2 + 7), String(cell.count), { size: big ? 28 : 20, weight: 600, fill: on, anchor: "middle" }));
        if (big && cell.items && cell.items.length) {
          const ex = truncate("e.g. " + cell.items.slice(0, 3).join(", "), cellW - 16, M.small);
          parts.push(text(cx + (cellW - 3) / 2, cy + cellH - 14, ex, { size: M.small, fill: on, anchor: "middle", opacity: 0.9 }));
        }
        parts.push("</g>");
      });
    });
    if (!big && p.total != null) parts.push(text(ox + panelW - 3, oy + heads + cellH * 2 + 20, `N = ${p.total}`, { size: M.small, fill: theme.muted, anchor: "end" }));
  });
  return { svg: parts.join(""), h: maxH + 4 };
}

const BODIES = { interval: intervalBody, stacked: stackedBody, matrix: matrixBody };

/** Body of a chart at scale 1 in a coordinate space W wide. → {svg: <g> content, h} */
export function drawBody(spec, W, theme) {
  const f = BODIES[spec.kind];
  if (!f) throw new Error(`unknown chart kind ${spec.kind}`);
  return f(spec, W, theme);
}

/** Plain-text description for aria-label / alt. */
export function describe(spec) {
  const rows = spec.rows ? spec.rows.length : (spec.panels || []).length;
  return `${spec.title}. ${spec.subtitle || ""} ${rows} ${spec.kind === "matrix" ? "panels" : "rows"}.`.replace(/\s+/g, " ");
}

/** Rows of numbers behind a chart, for the "Show numbers" table: {columns:[{key,label,num}], rows:[{…}]}. */
export function dataTable(spec) {
  if (spec.kind === "interval") {
    return { columns: [{ key: "group", label: "Group" }, { key: "label", label: "Row" }, { key: "xn", label: "x of N", num: true }, { key: "ci", label: "95% interval", num: true }],
      rows: spec.rows.map((r) => ({ group: r.group || "", label: `${r.label} ${r.sub || ""}`.trim(), xn: fmtXofN(r.x, r.n), ci: fmtCI(r.ci) })) };
  }
  if (spec.kind === "stacked") {
    const series = spec.series.filter((s) => spec.rows.some((r) => r.segments.some((g) => g.key === s.key && g.value)));
    return { columns: [{ key: "group", label: "Group" }, { key: "label", label: "Row" }, { key: "n", label: spec.nLabel || "N", num: true }, ...series.map((s) => ({ key: s.key, label: s.label, num: true }))],
      rows: spec.rows.map((r) => ({ group: r.group || "", label: `${r.label} ${r.sub || ""}`.trim(), n: r.n, ...Object.fromEntries(series.map((s) => [s.key, (r.segments.find((g) => g.key === s.key) || {}).value || 0])) })) };
  }
  const names = [];
  (spec.rowNames || []).forEach((rn) => (spec.colNames || []).forEach((cn) => names.push(`${rn} / ${cn}`)));
  return { columns: [{ key: "title", label: "Panel" }, ...names.map((n, i) => ({ key: "c" + i, label: n, num: true }))],
    rows: spec.panels.map((p) => ({ title: p.title, ...Object.fromEntries(p.cells.flat().map((c, i) => ["c" + i, c.count])) })) };
}

// ------------------------------------------------------------------ screen mode

/** The chart alone, as an inline <svg> (responsive: viewBox + width 100%). */
export function renderChart(spec, { style = "app", width = 600, fontCss = "" } = {}) {
  const theme = THEMES[style] || THEMES.app;
  const { svg, h } = drawBody(spec, width, theme);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${r2(h)}" width="100%" role="img" aria-label="${esc(describe(spec))}"` +
    ` font-family="${esc(theme.font)}" style="font-variant-numeric:tabular-nums;max-width:${Math.round(width * (spec.kind === "matrix" && (spec.panels || []).length === 1 ? 1.1 : 1.25))}px;height:auto">` +
    (fontCss ? `<defs><style>${fontCss}</style></defs>` : "") + svg + "</svg>";
}

// ------------------------------------------------------------------ slide mode (export)

const PAD = 96;

/** Natural size choice: the largest scale k (≤ 2.6) at which the body fits the slide area. */
export function fitScale(spec, availW, availH, theme) {
  for (let k = 2.6; k >= 1.2; k -= 0.05) {
    const W = availW / k;
    const { h } = drawBody(spec, W, theme);
    if (h * k <= availH) return { k, W, h };
  }
  const k = 1.2, W = availW / k;
  return { k, W, h: drawBody(spec, W, theme).h };
}

/** A 1920×1080 SVG slide: title, subtitle, the chart, source note bottom left, MOCK watermark when simulated.
 *  The watermark is not an option: it follows spec.simulated and nothing in `opts` can remove it. */
export function renderSlide(spec, { style = "app", fontCss = "" } = {}) {
  const theme = THEMES[style] || THEMES.app;
  const W = SLIDE.w, H = SLIDE.h;
  const out = [];
  out.push(rect(0, 0, W, H, theme.bg));
  // title block
  out.push(rect(PAD, 62, 56, 6, theme.accent));
  out.push(text(PAD, 128, truncate(spec.title, W - PAD * 2 - 160, 54), { size: 54, weight: 600, fill: theme.ink }));
  const sub = wrapText(spec.subtitle || "", W - PAD * 2 - 100, 26).slice(0, 2);
  sub.forEach((l, i) => out.push(text(PAD, 176 + i * 34, l, { size: 26, fill: theme.muted })));
  // footer text (bottom up): source note bottom left, footnote above it
  const foot = wrapText(spec.footnote || "", W - PAD * 2, 20);
  const banner = spec.simulated ? spec.banner || "SIMULATED (mock agent) — not a real run" : "";
  const stacked = !!banner && estWidth(banner, 22) * 1.05 > W - PAD * 2 - estWidth(spec.source || "", 22) - 40;
  const footTop = 1034 - 34 - (stacked ? 32 : 0) - foot.length * 26;
  const bodyTop = 176 + Math.max(1, sub.length) * 34 + 26;
  const availH = Math.max(300, footTop - 24 - bodyTop), availW = W - PAD * 2;
  const fit = fitScale(spec, availW, availH, theme);
  const { svg } = drawBody(spec, fit.W, theme);
  out.push(`<g transform="translate(${PAD} ${r2(bodyTop)}) scale(${r2(fit.k)})">${svg}</g>`);
  foot.forEach((l, i) => out.push(text(PAD, footTop + 18 + i * 26, l, { size: 20, fill: theme.muted })));
  out.push(text(PAD, 1034, truncate(spec.source || "Source: Agents vs. Gates", W - PAD * 2, 22), { size: 22, fill: theme.muted }));
  if (spec.simulated) {
    if (!stacked) out.push(text(W - PAD, 1034, banner, { size: 22, weight: 600, fill: theme.failInk, anchor: "end" }));
    else out.push(text(PAD, 1034 - 32, truncate(banner, W - PAD * 2, 22), { size: 22, weight: 600, fill: theme.failInk }));
    out.push(`<g transform="translate(${W / 2} ${H / 2 + 100}) rotate(-24)">${text(0, 0, "MOCK", { size: 380, weight: 700, fill: theme.ink, anchor: "middle", opacity: theme.id === "deck" ? 0.08 : 0.07 })}</g>`);
    out.push(`<g>${rect(W - PAD - 118, 70, 118, 46, "none", ` stroke="${theme.failInk}" stroke-width="3" rx="6"`)}${text(W - PAD - 59, 104, "MOCK", { size: 30, weight: 700, fill: theme.failInk, anchor: "middle", spacing: 3 })}</g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(describe(spec))}"` +
    ` font-family="${esc(theme.font)}" style="font-variant-numeric:tabular-nums">` +
    (fontCss ? `<defs><style>${fontCss}</style></defs>` : "") + out.join("") + "</svg>";
}
