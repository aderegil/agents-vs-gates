// One still of a scene page at given times (QA of a card scene before a full clip render).
//   node qa-scene-still.mjs <sceneId> <outDir> <tSec,...>
import fs from "node:fs";
import path from "node:path";
import { ORIGIN, launch } from "./lib.mjs";

const [id, outDir, times] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const { browser, context } = await launch();
try {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/scenes/index.html?s=${id}`);
  await page.waitForFunction(() => window.READY || window.SCENE_ERROR, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.SCENE_ERROR || null);
  if (err) throw new Error(err);
  for (const s of times.split(",").map(Number)) {
    await page.evaluate((t) => window.SCENE.render(t), s * 1000);
    await page.screenshot({ path: path.join(outDir, `${id}-${s}s.png`) });
  }
} finally {
  await browser.shutdown();
}
process.exit(0);
