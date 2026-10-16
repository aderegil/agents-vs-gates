// node --test console/plugins/results/web/charts.test.mjs   (pure chart math and SVG strings; no DOM)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  linearScale, niceTicks, proportionTicks, intervalGeometry, stackLayout, estWidth, truncate, wrapText,
  fmtXofN, fmtCI, drawBody, renderChart, renderSlide, dataTable, fitScale, THEMES, SLIDE,
} from "./charts.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const interval = (over = {}) => ({
  id: "t.interval", kind: "interval", title: "Staging break", subtitle: "x of N", tone: "fail", simulated: false,
  source: "Source: Agents vs. Gates, P1, Claude Code + Sonnet claude-sonnet-x, N=20, 12–14 Oct 2026",
  rows: [
    { group: "P1 · cc-sonnet", label: "X-rename", sub: "V0·S0", x: 7, n: 10, ci: [0.3475, 0.9333] },
    { group: "P1 · cc-sonnet", label: "X-rename", sub: "V0·S2", x: 0, n: 10, ci: [0, 0.3085] },
    { group: "P1 · cc-sonnet", label: "X-remove", sub: "V0·S0", x: 10, n: 10, ci: [0.6915, 1] },
  ], ...over,
});
const stacked = () => ({
  id: "t.stacked", kind: "stacked", title: "Boxes", subtitle: "runs", simulated: false, source: "Source: x",
  series: [{ key: "a", label: "Done & safe", tone: "pass" }, { key: "b", label: "Done & breaks", tone: "fail" }, { key: "c", label: "Not done", tone: "n4" }],
  rows: [
    { group: "P1 · cc-sonnet", label: "X-rename", sub: "V0·S0", n: 10, segments: [{ key: "a", value: 3 }, { key: "b", value: 7 }, { key: "c", value: 0 }] },
    { group: "P1 · cc-sonnet", label: "X-remove", sub: "V0·S0", n: 10, segments: [{ key: "a", value: 0 }, { key: "b", value: 1 }, { key: "c", value: 9 }] },
  ],
});
const matrix = (n = 1) => ({
  id: "t.matrix", kind: "matrix", title: "Mutation", subtitle: "s", simulated: false, source: "Source: x",
  rowAxis: "CI", colAxis: "Oracle", rowNames: ["Catches", "Misses"], colNames: ["Catches", "Misses"],
  panels: Array.from({ length: n }, (_, i) => ({ title: `T${i}`, note: "", total: 10,
    cells: [[{ count: 6, tone: "pass", items: ["m1", "m2"] }, { count: 1, tone: "n3", items: [] }], [{ count: 2, tone: "fail", items: ["m9"] }, { count: 1, tone: "n4", items: [] }]] })),
});

test("linearScale maps and inverts", () => {
  const s = linearScale([0, 1], [100, 300]);
  near(s(0), 100); near(s(0.5), 200); near(s(1), 300);
  near(s.invert(250), 0.75);
  assert.equal(linearScale([2, 2], [5, 9])(2), 5); // zero-width domain does not divide by zero
  near(linearScale([0, 10], [50, 0])(10), 0); // inverted range
});

test("niceTicks picks 1-2-5 steps inside the domain", () => {
  const t = niceTicks(0, 100, 5);
  assert.ok(t[0] >= 0 && t.at(-1) <= 100 + 1e-9);
  const steps = t.slice(1).map((v, i) => Math.round((v - t[i]) * 1e6) / 1e6);
  assert.equal(new Set(steps).size, 1);
  assert.ok([1, 2, 5].includes(steps[0] / Math.pow(10, Math.floor(Math.log10(steps[0])))));
  assert.deepEqual(niceTicks(0, 1, 3), [0, 0.5, 1]);
  assert.deepEqual(niceTicks(5, 5), [5]);
  assert.deepEqual(proportionTicks(), [0, 0.5, 1]);
});

test("intervalGeometry places the point and clamps the interval inside the plot", () => {
  const g = intervalGeometry({ x: 7, n: 10, ci: [0.3475, 0.9333] }, 100, 300);
  near(g.px, 100 + 0.7 * 200); near(g.lo, 100 + 0.3475 * 200); near(g.hi, 100 + 0.9333 * 200);
  const z = intervalGeometry({ x: 0, n: 10, ci: [0, 0.3085] }, 100, 300);
  near(z.px, 100); near(z.lo, 100); assert.ok(z.hi > 150);
  const all = intervalGeometry({ x: 10, n: 10, ci: [0.6915, 1] }, 100, 300);
  near(all.px, 300); near(all.hi, 300);
  // a CI that does not contain the point (bad input) is widened to contain it, never drawn outside
  const bad = intervalGeometry({ x: 5, n: 10, ci: [0.6, 0.9] }, 0, 100);
  assert.ok(bad.lo <= bad.px && bad.px <= bad.hi);
  const wild = intervalGeometry({ x: 5, n: 10, ci: [-1, 2] }, 0, 100);
  assert.equal(wild.lo, 0); assert.equal(wild.hi, 100);
  assert.deepEqual(Object.values(intervalGeometry({ x: 0, n: 0, ci: [0, 1] }, 0, 100)).every(Number.isFinite), true);
});

test("stackLayout fills the bar, skips zeros and keeps order", () => {
  const l = stackLayout([{ key: "a", value: 3 }, { key: "b", value: 0 }, { key: "c", value: 7 }], 10, 110);
  assert.deepEqual(l.map((s) => s.key), ["a", "c"]);
  near(l[0].x, 10); near(l[0].w, 30); near(l[1].x, 40); near(l[1].x + l[1].w, 110);
  assert.deepEqual(stackLayout([{ key: "a", value: 0 }], 0, 100), []);
});

test("text helpers", () => {
  assert.ok(estWidth("0000", 10) > estWidth("llll", 10));
  assert.ok(estWidth("abc", 20) > estWidth("abc", 10));
  const t = truncate("A very long label that cannot fit", 80, 12.5);
  assert.ok(t.endsWith("…") && estWidth(t, 12.5) <= 80 + 1);
  assert.equal(truncate("ok", 80, 12.5), "ok");
  const w = wrapText("one two three four five six seven", 60, 12);
  assert.ok(w.length > 1 && w.join(" ") === "one two three four five six seven");
});

test("x of N has no percent sign; interval has two decimals", () => {
  assert.equal(fmtXofN(7, 10), "7 of 10");
  assert.equal(fmtCI([0.3475, 0.9333]), "[0.35, 0.93]");
  assert.equal(fmtCI([0, 1]), "[0.00, 1.00]");
});

test("renderChart: valid-looking SVG, numbers visible, no percentages, no NaN", () => {
  for (const spec of [interval(), stacked(), matrix(1), matrix(5)]) {
    const svg = renderChart(spec, { style: "app" });
    assert.match(svg, /^<svg [^>]*viewBox="0 0 600 [\d.]+"/);
    assert.ok(svg.endsWith("</svg>"));
    assert.ok(!/NaN|undefined|Infinity/.test(svg), spec.kind);
    assert.ok(!/>[^<]*\d\s*%[^<]*</.test(svg.replaceAll("95%", "95 pct")), spec.kind + " must not print a percentage");
    const open = (svg.match(/<(g|text)[ >]/g) || []).length, close = (svg.match(/<\/(g|text)>/g) || []).length;
    assert.equal(open, close, spec.kind);
  }
  const svg = renderChart(interval());
  for (const t of ["7 of 10", "0 of 10", "10 of 10", "[0.35, 0.93]", "[0.00, 0.31]", "X-rename", "P1 · cc-sonnet"]) assert.ok(svg.includes(t), t);
  const st = renderChart(stacked());
  for (const t of [">3<", ">7<", ">9<", "N = 10", "Done &amp; safe"]) assert.ok(st.includes(t), t);
  assert.ok(!st.includes(">0<"), "zero segments are not drawn");
});

test("interval row height grows with rows; the body reports its own height", () => {
  const a = drawBody(interval(), 600, THEMES.app).h;
  const spec = interval();
  spec.rows = spec.rows.concat(spec.rows.map((r) => ({ ...r, group: "P2 · cc-sonnet" })));
  const b = drawBody(spec, 600, THEMES.app).h;
  assert.ok(b > a + 3 * 26);
});

test("slide: 1920×1080, source note bottom left, title, both styles", () => {
  assert.deepEqual([SLIDE.w, SLIDE.h], [1920, 1080]);
  for (const style of ["app", "deck"]) {
    for (const spec of [interval(), stacked(), matrix(1), matrix(6)]) {
      const svg = renderSlide(spec, { style });
      assert.match(svg, /viewBox="0 0 1920 1080" width="1920" height="1080"/);
      assert.ok(svg.includes(spec.title));
      assert.ok(!/NaN|undefined|Infinity/.test(svg));
      const m = svg.match(/<text x="96" y="1034"[^>]*>(Source: [^<]*)<\/text>/);
      assert.ok(m, "source note at x=96 (left) y=1034 (bottom): " + spec.kind);
      assert.ok(!svg.includes("MOCK"));
    }
  }
  assert.match(renderSlide(interval(), { style: "app" }), /<rect x="0" y="0" width="1920" height="1080" fill="#ffffff"/);
  assert.match(renderSlide(interval(), { style: "deck" }), /<rect x="0" y="0" width="1920" height="1080" fill="#000000"/);
});

test("deck style uses cyan for pass and pink for fail; Graphik first, IBM Plex Sans as fallback", () => {
  const svg = renderSlide(stacked(), { style: "deck" });
  assert.ok(svg.includes("#00BCD4") && svg.includes("#E91E63"));
  assert.match(svg, /font-family="Graphik[^"]*IBM Plex Sans/);
  assert.match(renderSlide(stacked(), { style: "app" }), /font-family="'IBM Plex Sans'/);
  assert.ok(renderSlide(stacked(), { style: "deck" }).includes("#A000FF")); // deck purple accent
});

test("mock watermark is always drawn and cannot be switched off", () => {
  const spec = interval({ simulated: true, banner: "SIMULATED (mock agent) — not a real run" });
  for (const style of ["app", "deck"]) {
    for (const opts of [{ style }, { style, watermark: false }, { style, mock: false, simulated: false }]) {
      const svg = renderSlide(spec, opts);
      assert.ok(svg.includes(">MOCK<"), "MOCK watermark");
      assert.ok(svg.includes("SIMULATED (mock agent) — not a real run"));
    }
  }
  assert.ok(!renderSlide(interval(), { style: "app" }).includes("MOCK"));
});

test("fitScale shrinks the chart so many rows still fit the slide", () => {
  const few = fitScale(interval(), 1728, 700, THEMES.app);
  const spec = interval();
  spec.rows = Array.from({ length: 30 }, (_, i) => ({ group: `P${1 + (i >> 3)} · cc-sonnet`, label: `T${i}`, sub: "V0·S0", x: 1, n: 10, ci: [0.01, 0.4] }));
  const many = fitScale(spec, 1728, 700, THEMES.app);
  assert.ok(many.k < few.k);
  assert.ok(many.k >= 1.2);
  assert.ok(few.k <= 2.6);
  assert.ok(few.h * few.k <= 700);
});

test("dataTable carries every number of the chart", () => {
  const t = dataTable(interval());
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[0].xn, "7 of 10");
  const s = dataTable(stacked());
  assert.deepEqual(s.columns.map((c) => c.key), ["group", "label", "n", "a", "b", "c"]);
  assert.equal(s.rows[1].c, 9);
  assert.equal(dataTable(matrix(2)).rows.length, 2);
});

test("font CSS is embedded when given, so a PNG drawn from the SVG keeps its font", () => {
  const css = "@font-face{font-family:'IBM Plex Sans';src:url(data:font/woff2;base64,AAAA)}";
  assert.ok(renderSlide(interval(), { style: "app", fontCss: css }).includes("data:font/woff2;base64,AAAA"));
  assert.ok(!renderSlide(interval(), { style: "app" }).includes("@font-face"));
});

test("an empty matrix cell is not painted pass or fail", () => {
  const spec = matrix(1);
  spec.panels[0].cells[1][0] = { count: 0, tone: "fail", items: [] };
  const svg = renderChart(spec, { style: "app" });
  assert.ok(!svg.includes('fill="#E91E63"'));
  spec.panels[0].cells[1][0].count = 4;
  assert.ok(renderChart(spec, { style: "app" }).includes('fill="#E91E63"'));
});

test("text is escaped", () => {
  const spec = interval();
  spec.rows[0].label = "<b>&\"x\"";
  const svg = renderSlide(spec, { style: "app" });
  assert.ok(!svg.includes("<b>"));
  assert.ok(svg.includes("&lt;b&gt;&amp;&quot;x&quot;"));
});

test("plain-word row labels fit beside their code at the console width (680) and on the slide", () => {
  const rows = [
    ["Every repo visible · No rule", "V2·S0"], ["Own repo · Rule in the spec", "V0·S2"],
    ["Contracts inside the repo · No rule", "V1·S0"], ["Ticket asks not to break consumers", "W2 · P5"],
  ].map(([label, sub], i) => ({ group: "Main test (P1) · Claude Code + Sonnet · Rename two fields (X-rename)", label, sub, x: i, n: 10, ci: [0, 0.5] }));
  const spec = interval({ rows });
  for (const svg of [renderChart(spec, { width: 680 }), renderSlide(spec)]) {
    for (const [label] of rows.map((r) => [r.label])) assert.ok(svg.includes(`>${label}</text>`), `not truncated: ${label}`);
  }
});
