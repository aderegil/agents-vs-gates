// Before/after stills of the Replay Theater and the AI-SDLC lanes (theater-1016), at fixed moments, 1920×1080, written
// to docs/qa/theater-1016-<shot>-<tag>.png. Presentation mode unless the shot says "panel".
//
//   node video/qa-stills.mjs --tag before --dist work/theater-before
//   node video/qa-stills.mjs --tag after              (the current build in console/plugins/replay/web/dist)
import fs from "node:fs";
import path from "node:path";
import { ORIGIN, REPO } from "./lib.mjs";
import { DIST, launchQa, openReplay } from "./qa-lib.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const TAG = opt("--tag", "now");
const dist = path.resolve(opt("--dist", DIST));
const ONLY = opt("--only", "") ? opt("--only", "").split(",") : null;
const QA = path.join(REPO, "docs", "qa");

/** [shot name, replay id or "lanes", time in ms, options] */
const SHOTS = [
  ["anthropic-t14", "aisdlc-anthropic", 14000],
  ["anthropic-t31", "aisdlc-anthropic", 31000],
  ["anthropic-t50", "aisdlc-anthropic", 50000],
  ["aws-t34", "aisdlc-aws", 34000],
  ["aws-t50", "aisdlc-aws", 50000],
  ["kiro-t30", "aisdlc-kiro", 30000],
  ["speckit-t40", "aisdlc-speckit", 40000],
  ["gate-t07", "aisdlc-gate", 7000],
  ["gate-t31", "aisdlc-gate", 31000],
  ["gate-t41", "aisdlc-gate", 41000],
  ["gate-t52", "aisdlc-gate", 52000],
  ["p1-0002-t24", "p1-0002", 24000],
  ["p1-0002-t31", "p1-0002", 31000],
  ["p1-0002-t43", "p1-0002", 43000],
  ["p1-0002-t24-panel", "p1-0002", 24000, { present: false }],
  ["p6-0012-t39", "p6-0012", 39000],
  ["m2b-sprint-t40", "m2b-sprint", 40000],
  ["lanes-t14", "lanes", 14000],
  ["lanes-t33", "lanes", 33000],
  ["lanes-t44", "lanes", 44000],
  ["lanes-t50", "lanes", 50000],
  ["lanes-neutral-t33", "lanes", 33000, { neutral: true }],
  ["lanes-neutral-t50", "lanes", 50000, { neutral: true }],
];

async function lanes(context, t, neutral) {
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-16T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-16T12:00:01Z"));
  await page.goto(`${ORIGIN}/qa/index.html?lanes=1&capture=1&t=${t}${neutral ? "&neutral=1" : ""}`);
  await page.clock.runFor(1600);
  await page.waitForSelector(".lanes__grid", { timeout: 60000 });
  await page.clock.runFor(1500); // transitions settle
  return page;
}

async function main() {
  fs.mkdirSync(QA, { recursive: true });
  const { browser, context } = await launchQa(dist);
  try {
    for (const [name, id, t, o = {}] of SHOTS) {
      if (ONLY && !ONLY.some((x) => name.startsWith(x))) continue;
      const page = id === "lanes" ? await lanes(context, t, o.neutral) : await openReplay(context, id, { t, present: o.present !== false });
      const file = path.join(QA, `theater-1016-${name}-${TAG}.png`);
      await page.screenshot({ path: file, type: "png" });
      await page.close();
      console.log(path.relative(REPO, file));
    }
  } finally {
    await browser.shutdown();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
