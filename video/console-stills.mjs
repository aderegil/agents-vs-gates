// Stills of the console for the deck's "Try it" slide and the kit (out/stills/*.png, 1920×1080): real data only,
// the namespace switch hidden (no frame says MOCK), no subtitle band. Same private console as the tours.
//
//   cd video && node console-stills.mjs [--port 8793]
import fs from "node:fs";
import path from "node:path";
import { createOwner, startPrivateConsole } from "./console-shots.mjs";
import { until } from "./console-tour.mjs";
import { OUT, launch, sleep } from "./lib.mjs";

const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 8793);
const RUN = "p1-0002";   // the poll-PR run, the same one exp-one-run.mp4 shows
const DIR = path.join(OUT, "stills");

function hideChrome() {
  if (window.top !== window) return;
  const css = document.createElement("style");
  css.textContent = "span.ns-switch[aria-label=Namespace]{display:none!important}"
    + ".res-gloss,details.code-legend{display:none!important}";
  const add = () => document.head.appendChild(css);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const { base, stop } = await startPrivateConsole({ port });
  const { browser, context } = await launch();
  try {
    const now = Date.now();
    await context.clock.install({ time: new Date(now) });
    await context.clock.pauseAt(new Date(now + 1000));
    const page = await context.newPage();
    await page.addInitScript(hideChrome);
    await createOwner(page, base, "demo");
    await page.goto(`${base}/#/start`);
    await page.reload();
    await until(page, async () => (await page.locator("#pbody .start .panel").count()) >= 5, "Start here");
    await page.getByRole("button", { name: "Expert", exact: true }).click();
    await page.mouse.move(960, 1079);
    const settle = async (ms = 1500) => { for (let i = 0; i < ms / 100; i++) { await page.clock.runFor(100); await sleep(60); } };
    const snap = async (name) => { await settle(); await page.screenshot({ path: path.join(DIR, `${name}.png`) }); console.log(`  ${name}.png`); };
    const tab = (name) => page.getByRole("tab").filter({ hasText: name }).first();   // a tab may carry a count ("Diff 2")
    const open = async (hash, ready, what) => {
      await page.goto(`${base}/#/${hash}`);
      await until(page, ready, what, 120000);
      await page.evaluate(() => { const b = document.getElementById("pbody"); if (b) b.scrollTop = 0; });
    };

    // Results: three agents, 100 runs per condition
    await open("results", async () => (await tab("Three agents · 100 runs").count()) > 0
      && (await page.locator("#pbody .loading").count()) === 0, "Results");
    await tab("Three agents · 100 runs").click();
    await page.evaluate(() => { document.getElementById("pbody").scrollTop = 300; });
    await snap("results-three-agents");

    // one run: the other teams' tests on its first pull request, then CI's verdict
    await open(`runs?run=${RUN}`, async () => (await tab("Other teams' tests").count()) > 0, "the run");
    await page.evaluate(() => { document.getElementById("pbody").scrollTop = 230; });
    await tab("Other teams' tests").click();
    await until(page, async () => (await page.locator("#pbody .loading").count()) === 0, "the other teams' tests");
    await snap("run-other-teams-tests");
    await tab("CI").click();
    await until(page, async () => (await page.locator("#pbody .loading").count()) === 0, "CI");
    await snap("run-ci");
    await tab("Diff").click();
    await until(page, async () => (await page.locator("#pbody .loading").count()) === 0, "Diff");
    await snap("run-diff");

    // the scenario: rules and repos
    await open("scenario", async () => (await tab("Rules").count()) > 0, "Scenario");
    await snap("scenario-repos");
    await tab("Rules").click();
    await snap("scenario-rules");
    await tab("Broker").click();
    await snap("scenario-contracts");

    // Run Control on the real namespace: the addenda's stages and the last runs
    await open("run-control", async () => (await page.getByText("Last batch", { exact: false }).count()) > 0
      && (await page.locator("#pbody").getByText("Loading…", { exact: false }).count()) === 0, "Run Control");
    // the first visible match (the launch form's stage <select> also names the stages)
    const scrollToText = (text) => page.evaluate((text) => {
      const b = document.getElementById("pbody");
      const all = [...b.querySelectorAll("*")].filter((n) => n.children.length === 0 && n.textContent.includes(text)
        && n.getClientRects().length && n.tagName !== "OPTION");
      if (!all.length) return false;
      b.scrollTop += all[0].getBoundingClientRect().top - b.getBoundingClientRect().top - 24;
      return true;
    }, text);
    await scrollToText("More main-test runs");
    await snap("run-control");
    await scrollToText("Finished");
    await snap("run-control-finished");

    // the Replay Theater on the same run, at the moment CI fails it (2×, 12 s of play ≈ 24 s of the run)
    await open(`replay?run=${RUN}`, async () => (await page.frameLocator("#pbody iframe")
      .getByRole("button", { name: /^Play \(Space\)/ }).count()) > 0, "the replay");
    const frame = page.frameLocator("#pbody iframe");
    const twoX = frame.locator(".speed-control button", { hasText: /^2×$/ });
    if (await twoX.count()) await twoX.first().click();
    await frame.getByRole("button", { name: /^Play \(Space\)/ }).click();
    await page.mouse.move(960, 1079);
    await settle(11800);
    await page.keyboard.press("Space").catch(() => undefined);
    await snap("theater");
    await page.close();
  } finally {
    await browser.shutdown();
    stop();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
