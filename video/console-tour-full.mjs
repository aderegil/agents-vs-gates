// The full console tour for the kit (out/console-tour-full.mp4, ~112 s, silent): Start here → the scenario (repos,
// rules, what the spec says, tickets, the consumer contracts) → Run Control → Results (three agents, 100 runs per
// condition) → one run in Run Explorer (diff, CI, the other teams' tests) → the same run in the Replay Theater → the
// AI-SDLC lanes. Real namespace only (prepare.py's read-only snapshot in video/work/results); the namespace switch is
// hidden, so no frame says MOCK. Same frame machinery, private console and subtitle band as console-tour.mjs.
//
//   cd video && node clips.mjs --fps 30 --skip-prepare --only console-tour-full
import { createOwner, startPrivateConsole } from "./console-shots.mjs";
import { ease, presentation, ring, scrollTo, subtitle, until } from "./console-tour.mjs";
import { shot, sleep } from "./lib.mjs";

/** The beats: seconds and the one short subtitle each. */
export const FULL_BEATS = [
  { id: "start", s: 10, sub: "Start here: the experiment in five short parts" },
  { id: "repos", s: 7, sub: "The scenario: a fictional retailer, four repos" },
  { id: "rules", s: 7, sub: "Its architecture rules, each one checked in CI" },
  { id: "contexts", s: 6, sub: "What the agent's spec says: nothing, notes, or the rules" },
  { id: "tickets", s: 5, sub: "The tickets the agent is given" },
  { id: "broker", s: 6, sub: "What each team reads: its consumer contract" },
  { id: "run-control", s: 9, sub: "Run Control: every batch and every run" },
  { id: "results", s: 13, sub: "Results: three agents, 100 runs per condition" },
  { id: "runs", s: 18, sub: "One run: its diff, CI's verdict, the other teams' tests" },
  { id: "replay", s: 18, sub: "The same run in the Replay Theater" },
  { id: "compare", s: 13, sub: "Five ways of working, one change" },
];

const RUN = "p1-0002";   // the poll-PR run (analysis.select_poll_pr), the same one exp-one-run.mp4 shows
const BAND = 84;

export async function captureFullTour(context, enc, { fps = 30, port = 8793 } = {}) {
  const step = 1000 / fps;
  const now = Date.now();
  await context.clock.install({ time: new Date(now) });
  await context.clock.pauseAt(new Date(now + 1000));
  const { base, stop } = await startPrivateConsole({ port });
  let elapsed = 0;
  try {
    const page = await context.newPage();
    await page.addInitScript(presentation, { band: BAND });
    await createOwner(page, base, "demo");
    await page.goto(`${base}/#/start`);
    await page.reload();
    await until(page, async () => (await page.locator("#pbody .start .panel").count()) >= 5, "Start here");
    // Expert view (off camera): Run Control is in the rail only there
    await page.getByRole("button", { name: "Expert", exact: true }).click();
    await until(page, async () => (await page.locator("a.rail-btn[data-plugin=run-control]").count()) > 0, "Expert rail");
    await page.mouse.move(960, 1080 - BAND / 2);

    const frames = async (ms, each) => {
      const n = Math.max(1, Math.round(ms / step));
      for (let i = 0; i < n; i++) {
        if (each) await each(i, n);
        await page.clock.runFor(step);
        await enc.push(await shot(page));
      }
      elapsed += n * step;
    };
    let beatEnd = 0;
    let beatNo = 0;
    const beat = async () => {
      const b = FULL_BEATS[beatNo++];
      beatEnd += b.s * 1000;
      await subtitle(page, b.sub);
    };
    const fill = async () => { if (beatEnd - elapsed > step / 2) await frames(beatEnd - elapsed); };
    const left = (reserve) => Math.max(0, beatEnd - elapsed - reserve);
    const point = async (loc, ms = 800) => {
      await ring(page, await loc.boundingBox());
      await frames(ms);
      await ring(page, null);
    };
    const click = async (loc) => {
      await loc.click();
      await page.mouse.move(960, 1080 - BAND / 2); // park the pointer on the band: no hover tooltips on camera
    };
    const go = async (plugin, ready, what) => {
      const btn = page.locator(`a.rail-btn[data-plugin=${plugin}]`);
      await frames(left(1100));
      await point(btn, 900);
      await click(btn);
      await fill();
      await until(page, ready, what, 120000);
      await scrollTo(page, 0);
    };
    const tab = (name) => page.getByRole("tab").filter({ hasText: name }).first();   // a tab may carry a count ("Diff 2")
    const maxScroll = () => page.evaluate(() => { const b = document.getElementById("pbody"); return b.scrollHeight - b.clientHeight; });
    const glide = async (ms, to) => {
      const from = await page.evaluate(() => document.getElementById("pbody").scrollTop);
      await frames(ms, (i, n) => scrollTo(page, Math.round(from + (to - from) * ease((i + 1) / n))));
    };

    // ---------------------------------------------------------------- Start here (10 s)
    await beat();
    await frames(2000);
    await glide(6000, Math.min(await maxScroll(), 900));
    await go("scenario", async () => (await tab("Repos").count()) > 0 && (await page.locator("#pbody .loading").count()) === 0, "Scenario");

    // ---------------------------------------------------------------- Scenario: repos, rules, contexts, tickets, broker
    await beat();                                                    // repos (7 s)
    await frames(1500);
    const orders = page.locator("#pbody").getByText("orders-service", { exact: true }).first();
    if (await orders.count()) await point(orders, 1200);
    await frames(left(1000));
    await point(tab("Rules"), 700);
    await click(tab("Rules"));
    await fill();

    await beat();                                                    // rules (7 s)
    await frames(1500);
    const arch4 = page.locator("#pbody").getByText("ARCH-4", { exact: true }).first();
    if (await arch4.count()) await point(arch4, 1500);
    await frames(left(1000));
    await point(tab("Contexts"), 700);
    await click(tab("Contexts"));
    await fill();

    await beat();                                                    // contexts (6 s)
    await frames(left(1000));
    await point(tab("Tickets"), 700);
    await click(tab("Tickets"));
    await fill();

    await beat();                                                    // tickets (5 s)
    await frames(left(1000));
    await point(tab("Broker"), 700);
    await click(tab("Broker"));
    await fill();

    await beat();                                                    // broker (6 s)
    await frames(1500);
    await glide(2500, Math.min(await maxScroll(), 420));
    await go("run-control", async () => (await page.getByText("Last batch", { exact: false }).count()) > 0
      && (await page.locator("#pbody").getByText("Loading…", { exact: false }).count()) === 0, "Run Control");

    // ---------------------------------------------------------------- Run Control (9 s)
    await beat();
    await frames(1500);
    await glide(6000, Math.min(await maxScroll(), 2600));
    await go("results", async () => (await tab("Three agents · 100 runs").count()) > 0
      && (await page.locator("#pbody .loading").count()) === 0, "Results");

    // ---------------------------------------------------------------- Results: three agents (13 s)
    await beat();
    await click(tab("Three agents · 100 runs"));
    await frames(1500);
    await glide(2500, 300);
    await frames(left(1100 + 3500));
    await glide(3500, Math.min(await maxScroll(), 820));
    const search = page.getByPlaceholder("Run ID or cell");
    await go("runs", async () => (await search.count()) > 0 && (await page.locator(`[data-run="${RUN}"]`).count()) > 0, "Run Explorer");

    // ---------------------------------------------------------------- one run: diff, CI, the other teams' tests (18 s)
    await beat();
    await frames(800);
    await point(search, 500);
    await search.focus();
    for (const ch of RUN) {
      await page.keyboard.type(ch);
      await frames(90);
    }
    await until(page, async () => (await page.locator("[data-run]").count()) === 1, "the filtered list");
    await frames(600);
    // the row, not its id cell: the presentation layer takes text that is only a code (the run id) off screen
    const row = page.locator(`[data-run="${RUN}"]`).first().locator("xpath=ancestor::tr[1]");
    await point(row, 700);
    await click(row);
    await until(page, async () => (await tab("Diff").count()) > 0, "the run's detail");
    await frames(1500);
    for (const [name, ms] of [["Diff", 3200], ["CI", 3200], ["Other teams' tests", 3200]]) {
      const t = tab(name);
      await point(t, 500);
      await click(t);
      await until(page, async () => (await page.locator("#pbody .loading").count()) === 0, name);
      await frames(ms);
    }
    const openTheater = page.getByRole("button", { name: "Open in Replay Theater" }).first();
    await frames(left(1100));
    await point(openTheater, 900);
    await click(openTheater);
    await fill();
    const frame = page.frameLocator("#pbody iframe");
    const play = frame.getByRole("button", { name: /^Play \(Space\)/ });
    await until(page, async () => (await play.count()) > 0, "the replay", 120000);
    for (let i = 0; i < 15; i++) { await page.clock.runFor(100); await sleep(100); }

    // ---------------------------------------------------------------- the same run in the Replay Theater, 2× (18 s)
    await beat();
    await frames(1500);
    const twoX = frame.locator(".speed-control button", { hasText: /^2×$/ });
    if (await twoX.count()) {
      await point(twoX.first(), 600);
      await click(twoX.first());
    }
    await point(play, 800);
    await click(play);
    const compareBtn = frame.getByRole("button", { name: "Compare AI-SDLC models" });
    await frames(left(1100));
    await point(compareBtn, 900);
    await click(compareBtn);
    // the lanes grid was laid out for the full window; the subtitle band takes 84 px, so the theater is drawn at 90 %
    const theater = await (await page.locator("#pbody iframe").elementHandle()).contentFrame();
    await theater.evaluate(() => { document.documentElement.style.zoom = "0.9"; });
    await fill();
    const lanesPlay = frame.locator(".lanes").getByRole("button", { name: "Play", exact: true });
    await until(page, async () => (await lanesPlay.count()) > 0, "the lanes view");

    // ---------------------------------------------------------------- Compare AI-SDLC models (13 s)
    await beat();
    await frames(1000);
    await point(lanesPlay, 700);
    await click(lanesPlay);
    await frames(8000);
    await frame.locator(".lanes").press("End").catch(() => page.keyboard.press("End"));
    await fill();
    await page.close();
    return elapsed;
  } finally {
    stop();
  }
}
