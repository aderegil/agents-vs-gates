// Visual QA helpers for the Replay Theater (theater-1016): the theater build served from any folder at ORIGIN/qa/,
// the two featured real replays (video/work/replays, from prepare_clips.py) at ORIGIN/replays/, and the shots the QA
// scripts take. Same Edge-through-playwright-core setup as the clips (lib.mjs); nothing listens on a port.
import fs from "node:fs";
import path from "node:path";
import { ORIGIN, REPO, launch } from "./lib.mjs";

export const DIST = path.join(REPO, "console", "plugins", "replay", "web", "dist");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".png": "image/png" };

/** Edge with the theater build `dist` mounted at ORIGIN/qa/. */
export async function launchQa(dist = DIST) {
  const { browser, context } = await launch();
  await context.route(`${ORIGIN}/qa/**`, async (route) => {
    const u = new URL(route.request().url());
    const rel = decodeURIComponent(u.pathname.slice("/qa/".length)) || "index.html";
    const file = path.resolve(dist, rel);
    if (!file.startsWith(path.resolve(dist)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return route.fulfill({ status: 404, body: `missing ${u.pathname}` });
    }
    return route.fulfill({ status: 200, body: fs.readFileSync(file),
      headers: { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" } });
  });
  return { browser, context };
}

/** The replays the QA covers: the five scripted scenes, the two featured real runs, and the crowded mock sprint. */
export const REPLAYS = {
  "aisdlc-anthropic": "/qa/scenes/aisdlc-anthropic.json",
  "aisdlc-aws": "/qa/scenes/aisdlc-aws.json",
  "aisdlc-kiro": "/qa/scenes/aisdlc-kiro.json",
  "aisdlc-speckit": "/qa/scenes/aisdlc-speckit.json",
  "aisdlc-gate": "/qa/scenes/aisdlc-gate.json",
  "p1-0002": "/replays/p1-0002.json",
  "p6-0012": "/replays/p6-0012.json",
  "m2b-sprint": "/qa/demo/m2b-sprint-f1.json",
  "m1-v0s2": "/qa/demo/m1-xrename-v0s2-additive.json",
  "x1-0002": "/replays/x1-0002.json",
};

/** Opens a replay in the theater, paused, presentation mode by default, on a paused virtual clock. */
export async function openReplay(context, id, { t = 0, present = true, qa = false } = {}) {
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-16T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-16T12:00:01Z"));
  const q = [`replay=${REPLAYS[id]}`, present ? "present=1" : "", t ? `t=${t}` : "", qa ? "qa=1" : ""].filter(Boolean).join("&");
  await page.goto(`${ORIGIN}/qa/index.html?${q}`);
  await page.waitForSelector("canvas", { timeout: 60000 });
  await page.clock.runFor(3000); // presentation chrome hides after 2.5 s
  return page;
}

export function exists(id) {
  return id in REPLAYS;
}
