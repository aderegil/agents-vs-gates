// Deck clips: one MP4 per segment, so each embeds on its own slide (night order 2026-10-13, section D).
//
//   cd video && node clips.mjs                     # prepare_clips.py, then every clip, then out/manifest.json
//   node clips.mjs --only exp-one-run,aisdlc-compare --skip-prepare
//   node clips.mjs --fps 30                        # capture rate (default 15; frames are repeated to 30 fps)
//
// Same machinery as build.mjs (lib.mjs): headless Edge through playwright-core on a virtual clock, JPEG frames piped to
// ffmpeg (libx264, 1920×1080, 30 fps, no audio). Theater segments play the theater build frozen by prepare_clips.py in
// presentation mode; card segments are the scene pages (scenes/, render(t)); the compare clip is the theater's lanes
// view. Nothing is written outside video/work and video/out; results/ is read only; no model calls.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FFMPEG, ORIGIN, OUT, REPO, VIDEO, WORK, encoder, ffprobeDuration, freeGB, launch, shot } from "./lib.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const FPS = Number(opt("--fps", 15));
const ONLY = opt("--only", "") ? opt("--only", "").split(",") : null;
const SEG = path.join(WORK, "clip-segments");

function freeRamGB() {
  const out = execFileSync("powershell", ["-NoProfile", "-Command",
    "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory"], { encoding: "utf8" });
  return Number(out.trim()) / 1024 ** 2;
}

const facts = () => JSON.parse(fs.readFileSync(path.join(WORK, "clip-facts.json"), "utf8"));
const replayMs = (rel) => JSON.parse(fs.readFileSync(path.join(WORK, rel), "utf8")).meta.duration_ms;

/** The clips: a list of segments each, and what the manifest says about them. */
function clips() {
  const f = facts();
  const one = f.one.run_id;
  const cx = f.codex.run_id;
  const scene = (id) => ({ kind: "scene", id });
  const theater = (replay, from, to, speed, chip, hold = 0) => ({ kind: "theater", replay, from, to, speed, chip, hold });
  const ill = (id, model, source) => ({
    file: `aisdlc-${id}.mp4`, segments: [{ kind: "theater", replay: `theater/scenes/aisdlc-${id}.json`, from: 0,
      to: replayMs(`theater/scenes/aisdlc-${id}.json`), speed: 1, chip: "Illustration · 1×" }],
    shows: `${model}: one feature (rename on OrderPlaced) through the model's own stages, scripted from its public documentation; where the architecture rule lives, what blocks the merge, and how the same scripted case ends.`,
    source: `replay/scenes/traces/aisdlc-${id}.jsonl (scripted, ${source}); beat → source in replay/scenes/SOURCES.md`,
    label: "Illustration · scripted from public documentation",
  });
  return [
    {
      file: "exp-one-run.mp4",
      segments: [scene("oneIntro"), theater(`replays/${one}.json`, 0, 23200, 0.5, "Real run · 0.5× speed"),
        scene("oneOracle"), theater(`replays/${one}.json`, 22600, 42800, 0.5, "Real run · 0.5× speed", 3000), scene("oneOutro")],
      shows: `One real run (${one}, poll-PR rule): ticket → rename → its own tests pass → PR → CI red (ARCH-4: billing needs totalCents, analytics needs placedAt) → the billing team's own tests fail on that first PR → the red build goes back to the agent → it keeps the old names as @deprecated aliases → CI green.`,
      source: `results/real/runs/${one} (events.jsonl → replay, record.json, diffs/fix1.diff); scenario/ contracts`,
      label: "Real run",
    },
    {
      file: "exp-codex-contract.mp4",
      segments: [scene("codexIntro"), theater(`replays/${cx}.json`, 12000, replayMs(`replays/${cx}.json`) + 3000, 1,
        "Real run · 1×"), scene("codexOutro")],
      shows: `One real run (${cx}, Codex, X-remove V1·S0): it edits the analytics team's contract and the contract-check script, CI passes, the analytics team's own tests fail.`,
      source: `results/real/runs/${cx} (events.jsonl → replay, record.json detectors and oracle)`,
      label: "Real run",
    },
    {
      file: "exp-company-design.mp4",
      segments: [scene("company"), scene("design")],
      shows: "Meridian Retail (fictional): orders-service and its three consuming teams, the fields they read, the architecture rules; then the experiment's design (V0/V1/V2 × S0/S1/S2) and the gates.",
      source: "scenario/repos/architecture (catalog, broker contracts, ARCHITECTURE-RULES.md); the design from the pre-registration",
      label: "Scenario and design",
    },
    ill("anthropic", "Anthropic · AI-native SDLC playbook", "Anthropic playbook, 21 Aug 2026"),
    ill("aws", "AWS · AI-DLC", "AWS AI-DLC blog 31 Jul 2025 + awslabs/aidlc-workflows 2.11.0"),
    ill("kiro", "Kiro", "Kiro docs, captured 10 Oct 2026"),
    ill("speckit", "GitHub spec-kit", "spec-kit README + spec-driven.md, read 13 Oct 2026"),
    ill("gate", "Any of the above + the gate", "this talk's proposal"),
    {
      file: "aisdlc-compare.mp4",
      segments: [{ kind: "lanes" }],
      shows: "The five scripted scenes side by side on one phase axis (intent → … → production): where the architecture rule lives, what blocks the merge, and how the same scripted case ends in each.",
      source: "console/plugins/replay/app/public/scenes/index.json (from replay/scenes/make_scenes.py)",
      label: "Illustration · scripted from public documentation",
    },
  ];
}

async function captureScene(context, seg, enc) {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/scenes/index.html?s=${seg.id}`);
  await page.waitForFunction(() => window.READY || window.SCENE_ERROR, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.SCENE_ERROR || null);
  if (err) throw new Error(`${seg.id}: ${err}`);
  const duration = await page.evaluate(() => window.SCENE.duration);
  const n = Math.round((duration / 1000) * FPS);
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.SCENE.render(t), (i * 1000) / FPS);
    await enc.push(await shot(page));
  }
  await page.close();
  return duration;
}

const SPEED_KEY = { 0.5: "1", 1: "2", 2: "3" };

async function captureTheater(context, seg, enc) {
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") });
  // paused: time moves only with runFor. Installed but running, the fake clock also follows wall time, so every
  // slow screenshot would push the replay ahead (the first renders ran ~3× fast)
  await page.clock.pauseAt(new Date("2026-10-13T12:00:01Z"));
  await page.goto(`${ORIGIN}/theater/index.html?replay=/${seg.replay.replace(/^theater\//, "theater/")}&present=1&t=${seg.from}`);
  await page.waitForSelector("canvas", { timeout: 60000 });
  await page.clock.runFor(3000); // presentation chrome hides after 2.5 s
  if (seg.chip) {
    await page.evaluate((txt) => {
      const d = document.createElement("div");
      d.textContent = txt;
      d.style.cssText = "position:fixed;right:18px;bottom:70px;z-index:99999;font:500 20px 'IBM Plex Sans',system-ui,sans-serif;"
        + "color:#5b6474;background:#fff;border:1.5px solid #c4cad3;border-radius:6px;padding:5px 12px;";
      document.body.appendChild(d);
    }, seg.chip);
  }
  await page.keyboard.press(SPEED_KEY[seg.speed] || "2");
  await page.keyboard.press("Space");
  const wall = (seg.to - seg.from) / seg.speed;
  const n = Math.round((wall / 1000) * FPS);
  const step = 1000 / FPS;
  for (let i = 0; i < n; i++) {
    await page.clock.runFor(step);
    await enc.push(await shot(page));
  }
  // a still hold on the last frame (playback paused), e.g. to let green CI sink in before the next card
  if (seg.hold) {
    await page.keyboard.press("Space");
    const m = Math.round((seg.hold / 1000) * FPS);
    for (let i = 0; i < m; i++) {
      await page.clock.runFor(step);
      await enc.push(await shot(page));
    }
  }
  await page.close();
  return wall + (seg.hold || 0);
}

async function captureLanes(context, enc) {
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") });
  // paused: time moves only with runFor. Installed but running, the fake clock also follows wall time, so every
  // slow screenshot would push the replay ahead (the first renders ran ~3× fast)
  await page.clock.pauseAt(new Date("2026-10-13T12:00:01Z"));
  await page.goto(`${ORIGIN}/theater/index.html?lanes=1&autoplay=1&capture=1`);
  await page.clock.runFor(1600);
  await page.waitForSelector(".lanes__grid", { timeout: 60000 });
  await page.clock.runFor(200);
  await page.keyboard.press("Home");
  const total = await page.evaluate(() => {
    const idx = document.querySelectorAll(".lanes__axis").length;
    return idx * 4600 + 13000;
  });
  const wall = total + 1500;
  const n = Math.round((wall / 1000) * FPS);
  const step = 1000 / FPS;
  for (let i = 0; i < n; i++) {
    await page.clock.runFor(step);
    await enc.push(await shot(page));
  }
  await page.close();
  return wall;
}

async function renderSegment(seg, file) {
  for (let attempt = 1; ; attempt++) {
    const { browser, context } = await launch();
    const enc = encoder(file, FPS);
    try {
      const ms = seg.kind === "scene" ? await captureScene(context, seg, enc)
        : seg.kind === "lanes" ? await captureLanes(context, enc) : await captureTheater(context, seg, enc);
      await enc.close();
      return ms;
    } catch (e) {
      await enc.close().catch(() => undefined);
      if (attempt >= 2) throw e;
      console.log(`  ${path.basename(file)}: ${String(e.message || e).split("\n")[0]} — retrying once`);
    } finally {
      await browser.shutdown();
    }
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SEG, { recursive: true });
  const disk = freeGB();
  const ram = freeRamGB();
  console.log(`free: C: ${disk.toFixed(1)} GB · RAM ${ram.toFixed(1)} GB`);
  if (disk < 5) throw new Error("less than 5 GB free on C:, stopping");
  if (ram < 6) throw new Error("less than 6 GB of free RAM, stopping (night order: renders only with >= 6 GB)");
  if (!flag("--skip-prepare")) {
    const py = path.join(REPO, ".venv", "Scripts", "python.exe");
    execFileSync(py, ["-X", "utf8", path.join(VIDEO, "prepare_clips.py")], { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
  }
  const list = clips();
  const manifestPath = path.join(OUT, "manifest.json");
  const prev = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { clips: [] };
  const byFile = new Map((prev.clips || []).map((c) => [c.file, c]));
  for (const clip of list) {
    if (ONLY && !ONLY.includes(clip.file.replace(/\.mp4$/, ""))) continue;
    const t0 = Date.now();
    const parts = [];
    for (const [i, seg] of clip.segments.entries()) {
      const r = freeRamGB();
      if (r < 6) throw new Error(`RAM ${r.toFixed(1)} GB < 6 GB before ${clip.file} segment ${i + 1}; stopping`);
      const file = path.join(SEG, `${clip.file.replace(/\.mp4$/, "")}-${String(i + 1).padStart(2, "0")}.mp4`);
      await renderSegment(seg, file);
      parts.push(file);
    }
    const out = path.join(OUT, clip.file);
    if (parts.length === 1) fs.copyFileSync(parts[0], out);
    else {
      const listFile = path.join(SEG, `${clip.file}.txt`);
      fs.writeFileSync(listFile, parts.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n") + "\n");
      execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
        "-c", "copy", "-movflags", "+faststart", out], { stdio: "inherit" });
    }
    const dur = ffprobeDuration(out);
    console.log(`${clip.file}: ${dur?.toFixed(1)} s · ${(fs.statSync(out).size / 1024 ** 2).toFixed(1)} MB · ${((Date.now() - t0) / 1000).toFixed(0)} s wall`);
    byFile.set(clip.file, { file: clip.file, duration_s: dur ? Math.round(dur * 10) / 10 : null, shows: clip.shows,
      source: clip.source, label: clip.label, format: "MP4 H.264 1920×1080 30 fps, no audio, English subtitles in frame",
      rendered_at: new Date().toISOString() });
    const order = list.map((c) => c.file);
    const clipsOut = [...byFile.values()].sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));
    fs.writeFileSync(manifestPath, JSON.stringify({ generated_by: "video/clips.mjs", clips: clipsOut }, null, 1) + "\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
