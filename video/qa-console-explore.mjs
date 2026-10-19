// QA: full-page stills of each console page on a private console (port 8794), to plan the full tour.
//   node qa-console-explore.mjs <outDir> [plugin,...]
import fs from "node:fs";
import path from "node:path";
import { createOwner, startPrivateConsole } from "./console-shots.mjs";
import { launch, sleep } from "./lib.mjs";

const [outDir, list] = process.argv.slice(2);
const plugins = (list || "start,story,overview,run-control,results,runs,replay,teams,scenario,readiness").split(",");
fs.mkdirSync(outDir, { recursive: true });
const { base, stop } = await startPrivateConsole({ port: 8794 });
const { browser, context } = await launch();
try {
  const page = await context.newPage();
  await createOwner(page, base, "demo");
  await page.goto(`${base}/#/start`);
  await page.reload();
  await sleep(4000);
  for (const p of plugins) {
    await page.goto(`${base}/#/${p}`);
    await sleep(Number(process.env.WAIT || 6000));
    await page.screenshot({ path: path.join(outDir, `${p}.png`) });
    const h = await page.evaluate(() => { const b = document.getElementById("pbody"); return b ? b.scrollHeight : 0; });
    console.log(p, "scrollHeight", h);
  }
} finally {
  await browser.shutdown();
  stop();
}
process.exit(0);
