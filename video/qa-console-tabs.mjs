// QA: stills of each tab of a console page (private console :8794), to pick the tour's and the deck's shots.
//   node qa-console-tabs.mjs <outDir> <plugin> [waitMs]
import fs from "node:fs";
import path from "node:path";
import { createOwner, startPrivateConsole } from "./console-shots.mjs";
import { launch, sleep } from "./lib.mjs";

const [outDir, plugin, wait = "20000"] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const { base, stop } = await startPrivateConsole({ port: 8794 });
const { browser, context } = await launch();
try {
  const page = await context.newPage();
  await createOwner(page, base, "demo");
  await page.goto(`${base}/#/${plugin}`);
  await page.reload();
  await sleep(Number(wait));
  const tabs = page.getByRole("tab");
  const n = await tabs.count();
  console.log("tabs", n);
  for (let i = 0; i < n; i++) {
    const name = (await tabs.nth(i).innerText()).trim().replace(/[^\w]+/g, "_").slice(0, 40);
    await tabs.nth(i).click();
    await sleep(2500);
    await page.screenshot({ path: path.join(outDir, `${plugin}-${i}-${name}.png`) });
    console.log(i, name);
  }
} finally {
  await browser.shutdown();
  stop();
}
process.exit(0);
