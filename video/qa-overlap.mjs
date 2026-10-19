// Overlap sweep for the Replay Theater (theater-1016): plays every QA replay in presentation mode at 1920×1080,
// seeks every --step ms (default 250) through the ?qa=1 hook, and counts, frame by frame, text boxes that overlap
// other text boxes and text boxes that cover somebody else's figure (rules in console/plugins/replay/app/src/engine/
// overlap.ts). Prints a table and writes it to --out (default docs/qa/theater-1016-overlap-<tag>.txt).
//
//   node video/qa-overlap.mjs --tag before [--dist <theater build>] [--step 250] [--only aisdlc-gate,p1-0002]
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./lib.mjs";
import { DIST, REPLAYS, launchQa, openReplay } from "./qa-lib.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const TAG = opt("--tag", "now");
const STEP = Number(opt("--step", 250));
const ONLY = opt("--only", "") ? opt("--only", "").split(",") : Object.keys(REPLAYS);
const OUTF = opt("--out", path.join(REPO, "docs", "qa", `theater-1016-overlap-${TAG}.txt`));
const dist = path.resolve(opt("--dist", DIST));

const area = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};
const TEXT = new Set(["label", "name", "bubble", "callout", "pill", "card", "caption", "tag", "sheet", "subtitle", "chrome"]);
// same rules as engine/overlap.ts (kept in step by test/overlap.test.ts)
function textPairs(boxes) {
  const t = boxes.filter((b) => TEXT.has(b.kind));
  const out = [];
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
    const a = t[i]; const b = t[j];
    if (a.owner && a.owner === b.owner) continue;
    if (a.kind === "chrome" && b.kind === "chrome") continue;
    const s = area(a, b);
    if (s > 6) out.push([a, b, s]);
  }
  return out;
}
function figurePairs(boxes) {
  const figs = boxes.filter((b) => b.kind === "figure");
  const out = [];
  for (const b of boxes) {
    if (!TEXT.has(b.kind) || b.kind === "chrome" || b.kind === "subtitle") continue;
    for (const f of figs) {
      if (b.owner && b.owner === f.owner) continue;
      const s = area(b, f);
      if (s > 0.08 * f.w * f.h) out.push([b, f, s]);
    }
  }
  return out;
}
const name = (b) => `${b.kind}${b.owner ? `(${b.owner})` : ""}${b.text ? ` "${String(b.text).slice(0, 28)}"` : ""}`;

async function main() {
  const { browser, context } = await launchQa(dist);
  const lines = [`# Overlap sweep · ${TAG} · ${new Date().toISOString()} · step ${STEP} ms · presentation mode 1920×1080`, "",
    "| Replay | Frames | Frames with text over text | Text-over-text pairs | Frames with text over a person | Text-over-person pairs | Max bubbles at once |",
    "|---|---|---|---|---|---|---|"];
  const worst = [];
  const totals = { frames: 0, tf: 0, tp: 0, ff: 0, fp: 0 };
  try {
    for (const id of ONLY) {
      const page = await openReplay(context, id, { qa: true });
      await page.waitForFunction(() => !!window.__avgQa, null, { timeout: 30000 });
      const end = await page.evaluate(() => window.__avgQa.end);
      const r = { frames: 0, tf: 0, tp: 0, ff: 0, fp: 0, bubbles: 0 };
      const seen = new Map();
      for (let t = 0; t <= end; t += STEP) {
        const { boxes } = await page.evaluate((x) => window.__avgQa.at(x), t);
        r.frames++;
        const tp = textPairs(boxes);
        const fp = figurePairs(boxes);
        r.bubbles = Math.max(r.bubbles, boxes.filter((b) => b.kind === "bubble").length);
        if (tp.length) r.tf++;
        if (fp.length) r.ff++;
        r.tp += tp.length;
        r.fp += fp.length;
        for (const [a, b, s] of [...tp, ...fp]) {
          const k = `${name(a)} × ${name(b)}`;
          const e = seen.get(k) ?? { k, n: 0, max: 0, first: t };
          e.n++;
          e.max = Math.max(e.max, s);
          seen.set(k, e);
        }
      }
      await page.close();
      lines.push(`| ${id} | ${r.frames} | ${r.tf} | ${r.tp} | ${r.ff} | ${r.fp} | ${r.bubbles} |`);
      for (const k of Object.keys(totals)) totals[k] += r[k];
      const top = [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 8);
      if (top.length) worst.push(`\n## ${id}: most frequent overlaps`, ...top.map((e) => `- ${e.k} · ${e.n} frames (first at ${(e.first / 1000).toFixed(2)} s, max ${Math.round(e.max)} px²)`));
      console.log(`${id}: ${r.frames} frames · text×text in ${r.tf} · text×person in ${r.ff} · max bubbles ${r.bubbles}`);
    }
  } finally {
    await browser.shutdown();
  }
  lines.push(`| **all** | ${totals.frames} | ${totals.tf} | ${totals.tp} | ${totals.ff} | ${totals.fp} | |`);
  fs.mkdirSync(path.dirname(OUTF), { recursive: true });
  fs.writeFileSync(OUTF, [...lines, ...worst, ""].join("\n"));
  console.log(`wrote ${OUTF}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
