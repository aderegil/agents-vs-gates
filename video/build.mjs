// Talk video (draft): one command regenerates everything.
//
//   cd video && npm run build                      # prepare data, console stills, every segment, concat
//   node build.mjs --only 05-results               # re-render one segment (e.g. when X1 closes) and re-concat
//   node build.mjs --skip-console                  # reuse work/shots/*.png
//   node build.mjs --stills-only                   # only the storyboard stills (docs/qa/video-*.png)
//
// Frames are screenshots of headless Edge (playwright-core, the installed msedge.exe; no browser download), taken on a
// virtual clock (page.clock for the theater, render(t) for the scene pages) so the result does not depend on CPU load,
// at 15 fps by default, encoded by ffmpeg-static with -threads 2 and repeated to 30 fps. No audio.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { captureConsole } from "./console-shots.mjs";
import { FFMPEG, ORIGIN, OUT, REPO, VIDEO, WORK, encoder, ffprobeDuration, freeGB, launch, shot } from "./lib.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const FPS = Number(opt("--fps", 15));
const ONLY = opt("--only", "") ? opt("--only", "").split(",") : null;
const STILLS_ONLY = flag("--stills-only");
const OUT_FILE = path.join(OUT, "agents-vs-gates-talk-draft.mp4");
const QA = path.join(REPO, "docs", "qa");
const SEG_DIR = path.join(WORK, "segments");

function prepare() {
  const py = path.join(REPO, ".venv", "Scripts", "python.exe");
  const extra = [];
  if (opt("--break-run")) extra.push("--break-run", opt("--break-run"));
  if (opt("--stop-run")) extra.push("--stop-run", opt("--stop-run"));
  if (opt("--summary")) extra.push("--summary", opt("--summary"));
  execFileSync(py, ["-X", "utf8", path.join(VIDEO, "prepare.py"), ...extra], { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
  // freeze the theater build used for this render (another session may be rebuilding web/dist)
  const dist = path.join(REPO, "console", "plugins", "replay", "web", "dist");
  fs.rmSync(path.join(WORK, "theater"), { recursive: true, force: true });
  fs.cpSync(dist, path.join(WORK, "theater"), { recursive: true });
}

const meta = () => JSON.parse(fs.readFileSync(path.join(WORK, "meta.json"), "utf8"));

function segments(m) {
  return [
    { id: "01-company", scene: "company", still: ["video-1-company.png", 36000] },
    { id: "02-experiment", scene: "experiment", still: ["video-2-experiment.png", 22000] },
    { id: "03a-break-intro", scene: "breakIntro" },
    { id: "03b-break-theater", theater: m.break_run, cut: true, chip: "Director's cut · key moments at 1×, the rest compressed", hold: 4500,
      still: ["video-3-theater-break.png", 44000] },
    { id: "03c-break-outro", scene: "breakOutro", still: ["video-3b-break-record.png", 11000] },
    { id: "04a-stop-intro", scene: "stopIntro" },
    { id: "04b-stop-theater", theater: m.stop_run, cut: false, speed: "1", chip: "0.5× speed", hold: 3000 },
    { id: "04c-stop-answer", scene: "stopAnswer", still: ["video-4-stop-answer.png", 12000] },
    { id: "05-results", scene: "results", still: ["video-5-results.png", 30000] },
  ];
}

async function captureScene(context, seg, enc, stillOnly) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${ORIGIN}/scenes/index.html?s=${seg.scene}`);
  await page.waitForFunction(() => window.READY || window.SCENE_ERROR, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.SCENE_ERROR || null);
  if (err) throw new Error(`${seg.id}: ${err}`);
  const duration = await page.evaluate(() => window.SCENE.duration);
  if (seg.still) {
    await page.evaluate((t) => window.SCENE.render(t), seg.still[1]);
    await page.screenshot({ path: path.join(QA, seg.still[0]) });
  }
  if (!stillOnly) {
    const n = Math.round((duration / 1000) * FPS);
    for (let i = 0; i < n; i++) {
      await page.evaluate((t) => window.SCENE.render(t), (i * 1000) / FPS);
      await enc.push(await shot(page));
    }
  }
  if (errors.length) console.log(`  ${seg.id} page errors:`, errors.slice(0, 3));
  await page.close();
  return duration;
}

async function captureTheater(context, seg, enc, stillOnly) {
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-12T12:00:00Z") });
  const url = `${ORIGIN}/theater/index.html?replay=/replays/${seg.theater}.json${seg.cut ? "&cut=1" : ""}&present=1`;
  await page.goto(url);
  await page.waitForSelector("canvas", { timeout: 60000 });
  await page.waitForSelector(".timeline__fill", { state: "attached", timeout: 60000 });
  await page.clock.runFor(3000); // presentation chrome hides after 2.5 s
  if (seg.chip) {
    await page.evaluate((txt) => {
      const d = document.createElement("div");
      d.textContent = txt;
      d.style.cssText = "position:fixed;right:18px;bottom:22px;z-index:99999;font:500 20px 'IBM Plex Sans',system-ui,sans-serif;"
        + "color:#5b6474;background:#fff;border:1.5px solid #c4cad3;border-radius:6px;padding:5px 12px;";
      document.body.appendChild(d);
    }, seg.chip);
  }
  if (seg.speed) await page.keyboard.press(seg.speed);
  await page.keyboard.press("Space");
  const step = 1000 / FPS;
  const maxFrames = FPS * 200;
  let t = 0, endAt = null, stillDone = false, frames = 0;
  while (frames < maxFrames) {
    await page.clock.runFor(step);
    t += step;
    if (seg.still && !stillDone && t >= seg.still[1]) {
      await page.screenshot({ path: path.join(QA, seg.still[0]) });
      stillDone = true;
      if (stillOnly) break;
    }
    if (!stillOnly) { await enc.push(await shot(page)); frames += 1; }
    if (endAt === null && frames % FPS === 0) {
      const w = await page.$eval(".timeline__fill", (e) => e.style.width).catch(() => "");
      if (w === "100%") endAt = t;
    }
    if (endAt !== null && t >= endAt + seg.hold) break;
    if (stillOnly && t > 200000) break;
  }
  await page.close();
  return t;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SEG_DIR, { recursive: true });
  const free = freeGB();
  console.log(`free on C: ${free.toFixed(1)} GB`);
  if (free < 5) throw new Error("less than 5 GB free on C:, stopping (see README)");
  if (!flag("--skip-prepare")) { console.log("prepare (video/prepare.py)…"); prepare(); }
  const m = meta();
  if (!flag("--skip-console") && !STILLS_ONLY) {
    console.log("console stills (private console)…");
    const { browser, context } = await launch();
    try { await captureConsole(context, { port: Number(opt("--port", 8793)) }); } finally { await browser.shutdown(); }
  }
  for (const seg of segments(m)) {
    if (ONLY && !ONLY.includes(seg.id)) continue;
    // a fresh browser per segment: a long theater capture on a busy machine once crashed the next tab
    for (let attempt = 1; ; attempt++) {
      const file = path.join(SEG_DIR, `${seg.id}.mp4`);
      const t0 = Date.now();
      const { browser, context } = await launch();
      const enc = STILLS_ONLY ? null : encoder(file, FPS);
      try {
        const ms = seg.scene ? await captureScene(context, seg, enc, STILLS_ONLY) : await captureTheater(context, seg, enc, STILLS_ONLY);
        if (enc) await enc.close();
        console.log(`  ${seg.id}: ${(ms / 1000).toFixed(1)} s${enc ? ` · ${enc.frames} frames` : ""} · ${((Date.now() - t0) / 1000).toFixed(0)} s wall`);
        break;
      } catch (e) {
        if (enc) await enc.close().catch(() => undefined);
        if (attempt >= 2) throw e;
        console.log(`  ${seg.id}: ${String(e.message || e).split("\n")[0]} — retrying once`);
      } finally {
        await browser.shutdown();
      }
    }
  }
  if (STILLS_ONLY) return;
  const list = segments(m).map((s) => path.join(SEG_DIR, `${s.id}.mp4`));
  const missing = list.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`missing segments: ${missing.join(", ")}`);
  const listFile = path.join(SEG_DIR, "concat.txt");
  fs.writeFileSync(listFile, list.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n") + "\n");
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy",
    "-movflags", "+faststart", OUT_FILE], { stdio: "inherit" });
  const dur = ffprobeDuration(OUT_FILE);
  const mb = fs.statSync(OUT_FILE).size / 1024 ** 2;
  const marks = [];
  let acc = 0;
  for (const f of list) { marks.push(`${path.basename(f, ".mp4")} @ ${fmt(acc)}`); acc += ffprobeDuration(f) || 0; }
  fs.writeFileSync(path.join(OUT, "timings.txt"), marks.join("\n") + `\ntotal ${fmt(dur)}\n`);
  console.log(`\n${OUT_FILE}\n${fmt(dur)} · ${mb.toFixed(1)} MB\n${marks.join("\n")}`);
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

main().catch((e) => { console.error(e); process.exit(1); });
