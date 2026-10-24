// exp-one-run.mp4, third version (coordinator's order, 2026-10-24, approved by Alfredo): the scene in the top 900 px,
// zoomed to the active area of each beat, and a black band of 180 px under it with the words Alfredo reads live.
//
// The narration is data (narration/exp-one-run.json, literal) and it drives the clock: each sentence stays at least
// max(2.5 s, words / 2 + 0.8 s), one at a time with 0.4 s of empty band between two, and the run's next action
// happens when its sentence ends, never before (the replay clock stands still while it is read). The camera moves to
// the sentence's place when the sentence starts. Times come from the frames really filmed, so the cue list written
// next to the clip (out/exp-one-run.cues.json) is the band's own timing.
//
// Used by clips.mjs (segments: [{ kind: "one-run" }]). Same machinery: headless Edge on a paused virtual clock, one
// JPEG per frame piped to ffmpeg. The theater opens with ?subs=0 (no subtitle in the scene), ?bubbles=none and
// ?light=0.45 (the beat's focus dims the rest less); the cards open with ?nocap=1.
import fs from "node:fs";
import path from "node:path";
import { ORIGIN, OUT, shot } from "./lib.mjs";

const NARRATION = JSON.parse(fs.readFileSync(new URL("./narration/exp-one-run.json", import.meta.url), "utf8"));
export const PHRASES = NARRATION.phrases.map((p) => p.text);
const words = (s) => s.split(/\s+/).filter(Boolean).length;
export const phraseMs = (s) => Math.max(2500, (words(s) / 2) * 1000 + 800);
const GAP = 400;
const SCENE_H = 900;
const BAND_H = 180;

// Camera shots, in px of the unzoomed 1920×900 theater frame (the stage canvas spans x 160–1760); the height follows
// from the width (1920:900).
const SHOT = {
  wide: { x: 0, y: 0, w: 1920 },
  agent: { x: 230, y: 100, w: 1000 },       // the agent's desk, its diff card, the dispatch board
  ci: { x: 680, y: 150, w: 880 },           // the PR tray, the CI tower and its lights, the agent at the tray
  agentCi: { x: 480, y: 120, w: 1150 },     // the red build going from the tower back to the agent
  teams: { x: 700, y: 145, w: 1060 },       // behind the glass: the three teams and their tests
};

const BAND_CSS = `#clip-band{position:fixed;left:0;right:0;bottom:0;height:${BAND_H}px;background:#000;z-index:100000;
  display:flex;align-items:center;justify-content:center;}
#clip-band div{max-width:1720px;text-align:center;color:#fff;font:500 42px/1.25 'IBM Plex Sans',system-ui,sans-serif;}`;
const CHAPTER_CSS = (bg) => "position:fixed;left:0;top:0;width:760px;height:66px;z-index:99999;display:flex;align-items:center;"
  + `box-sizing:border-box;padding-left:36px;background:${bg};font:600 30px 'IBM Plex Sans',system-ui,sans-serif;color:#111827;`;
const CHIP_CSS = `position:fixed;right:18px;bottom:${BAND_H + 18}px;z-index:99999;font:500 20px 'IBM Plex Sans',system-ui,sans-serif;`
  + "color:#5b6474;background:#fff;border:1.5px solid #c4cad3;border-radius:6px;padding:5px 12px;";
const MARK_CSS = `position:fixed;right:18px;bottom:${BAND_H + 66}px;z-index:99999;font:600 24px 'IBM Plex Sans',system-ui,sans-serif;`
  + "color:#fff;background:#1f2937;border-radius:6px;padding:4px 14px;";
const CH1 = "1 · The change";
const CH2 = "2 · The red build";
const CH3 = "3 · The repair";
const SCENE_BG = "#f6f7f9";
const THEATER_BG = "rgb(234,237,244)";
const fmtSpeed = (x) => String(Math.round(x * 100) / 100);
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

async function setBox(page, id, text, css) {
  await page.evaluate(([id, text, css]) => {
    let d = document.getElementById(id);
    if (!text) { d?.remove(); return; }
    if (!d) { d = document.createElement("div"); d.id = id; d.style.cssText = css; document.body.appendChild(d); }
    d.textContent = text;
  }, [id, text, css]);
}

/** The whole clip into one encoder. Returns its length in ms and writes the cue list. */
export async function captureOneRun(context, enc, { fps, oneRunId }) {
  const step = 1000 / fps;
  const cues = [];             // { n, text, start, end } in ms of the clip
  const actions = [];          // { n, at } the moment each sentence's action happens
  const camLog = [];
  let wall = 0;                // ms filmed so far
  let lastEnd = -GAP;
  let page = null;
  let kind = null;             // "card" | "theater"
  let cardT = 0;               // a card's own time
  let speed = 0.5;             // replay ms per clip ms while playing
  let cam = { from: SHOT.wide, to: SHOT.wide, t0: 0, ms: 0 };

  const camAt = (t) => {
    const p = cam.ms ? ease(Math.min(1, Math.max(0, (t - cam.t0) / cam.ms))) : 1;
    const f = cam.from, g = cam.to;
    return { x: f.x + (g.x - f.x) * p, y: f.y + (g.y - f.y) * p, w: f.w + (g.w - f.w) * p };
  };
  const bandAt = (t) => {
    const c = cues.find((q) => t >= q.start && t < q.end);
    if (!c) return { text: "", o: 0 };
    return { text: c.text, o: Math.min(1, (t - c.start) / 200, (c.end - t) / 200) };
  };

  /** One frame: advance the scene by `adv` ms of its own time, place the camera, the band, and film it. */
  const frame = async (adv) => {
    const band = bandAt(wall);
    if (kind === "card") {
      await page.evaluate(([t, b]) => {
        window.SCENE.render(t);
        const d = document.querySelector("#clip-band div");
        d.textContent = b.text; d.style.opacity = b.o;
      }, [cardT, band]);
      cardT += adv;
    } else {
      if (adv > 0) await page.clock.runFor(adv);
      const r = camAt(wall);
      const s = 1920 / r.w;
      await page.evaluate(([tx, ty, s, b]) => {
        const c = document.querySelector("canvas");
        c.style.transformOrigin = "0 0";
        c.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
        const d = document.querySelector("#clip-band div");
        d.textContent = b.text; d.style.opacity = b.o;
      }, [-160 - s * (r.x - 160), -s * r.y, s, band]);
    }
    await enc.push(await shot(page));
    wall += step;
  };
  const hold = async (ms) => {
    const n = Math.round(ms / step);
    if (n && kind === "theater") await setBox(page, "clip-mark", null, MARK_CSS);   // a still frame is not fast-forward
    for (let i = 0; i < n; i++) await frame(kind === "card" ? step : 0);
  };
  /** Sentence n (1-based) starts now or as soon as the band is free; the scene holds still until then, then `lead` more. */
  const say = async (n, lead = 0, minMs = 0, shotName = null) => {
    const start = Math.max(wall, lastEnd + GAP);
    if (start > wall) await hold(start - wall);
    const text = PHRASES[n - 1];
    const c = { n, text, start: wall, end: wall + Math.max(phraseMs(text), minMs) };
    cues.push(c);
    lastEnd = c.end;
    if (shotName) camTo(shotName);       // the camera moves while the sentence is read
    if (lead) await hold(lead);
  };
  /** Where sentence n's action happens: now, or `ms` of clip time from now (the replay's step, at the next play's speed). */
  const action = (n, ms = 0) => actions.push({ n, at: wall + ms });
  const untilSaid = async (extra = 0) => { if (lastEnd + extra > wall) await hold(lastEnd + extra - wall); };
  /** Sentence n, the camera to its place, and the scene still until the sentence is done: its action comes next. */
  const sayFirst = async (n, shotName = null) => { await say(n, 0, 0, shotName); await untilSaid(); };
  const camTo = (name, ms = 1400) => { cam = { from: camAt(wall), to: SHOT[name], t0: wall, ms }; camLog.push({ at: wall, shot: name }); };

  let at = 0;                  // replay ms
  const dress = async (chapter) => {
    if (chapter !== undefined) await setBox(page, "clip-chapter", chapter, CHAPTER_CSS(kind === "card" ? SCENE_BG : THEATER_BG));
    if (kind === "theater") {
      await setBox(page, "clip-chip", `Real run · ${fmtSpeed(speed)}× speed`, CHIP_CSS);
      await setBox(page, "clip-mark", speed > 0.5 ? `×${fmtSpeed(speed / 0.5)}` : null, MARK_CSS);
    }
  };
  const play = async (to, sp, chapter) => {
    speed = sp;
    await dress(chapter);
    const n = Math.round((to - at) / sp / step);
    for (let i = 0; i < n; i++) await frame(step * sp);
    at = to;
  };

  const openCard = async (id, query = "") => {
    await page?.close();
    page = await context.newPage();
    kind = "card";
    cardT = 0;
    await page.goto(`${ORIGIN}/scenes/index.html?s=${id}&nocap=1${query}`);
    await page.waitForFunction(() => window.READY || window.SCENE_ERROR, null, { timeout: 60000 });
    const err = await page.evaluate(() => window.SCENE_ERROR || null);
    if (err) throw new Error(`${id}: ${err}`);
    // the 1920×1080 card drawn at 1600×900 above the band; its own top bar moves under the chapter label
    await page.addStyleTag({ content: `${BAND_CSS}
      #stage{transform:scale(${SCENE_H / 1080});transform-origin:50% 0;} .topbar{top:84px!important}` });
    await page.evaluate(() => { const b = document.createElement("div"); b.id = "clip-band"; b.append(document.createElement("div")); document.body.append(b); });
  };
  const openTheater = async (from) => {
    await page?.close();
    page = await context.newPage();
    kind = "theater";
    await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-13T12:00:01Z"));
    await page.goto(`${ORIGIN}/theater/index.html?replay=/replays/${oneRunId}.json&present=1&subs=0&bubbles=none&light=0.45&t=${from}`);
    await page.waitForSelector("canvas", { timeout: 60000 });
    // the player in the top 900 px (its stage 1600×900, centred), the band under it
    await page.addStyleTag({ content: `${BAND_CSS}
      html,body,#root{height:${SCENE_H}px!important;overflow:visible!important}
      .player{height:${SCENE_H}px!important;overflow:visible!important}
      .player.is-presenting .stage-frame{max-width:1600px!important}
      .stage-area,.main-col,.body,.stage-frame{overflow:visible!important}` });
    await page.evaluate(() => { const b = document.createElement("div"); b.id = "clip-band"; b.append(document.createElement("div")); document.body.append(b); });
    await page.clock.runFor(3000);               // presentation chrome hides after 2.5 s
    await page.keyboard.press("2");              // 1×: the clip sets the pace by how far the clock runs per frame
    await page.keyboard.press("Space");
    at = from;
  };

  // ---- 1 · the ticket card
  await openCard("oneIntro", `&note=${600 + phraseMs(PHRASES[0]) + GAP}`);
  await dress(CH1);
  await hold(600);                               // the poster frame: the ticket, an empty band
  await say(1); action(1);
  await say(2); action(2);
  await untilSaid(GAP);

  // ---- 2 · the office, the change, the PR, CI red
  await openTheater(0);
  camTo("wide", 0);
  await dress(CH1);
  await hold(300);
  await sayFirst(3); action(3);
  await play(3200, 1);                           // the ticket reaches the agent, it loads its context
  await sayFirst(4, "agent"); action(4);
  await play(18300, 3);                          // reads and edits (×6), up to just before the PR
  await sayFirst(5); action(5, (18501 - 18300) / 0.5);
  await play(19200, 0.5);                        // PR opened at 18.5 s
  await sayFirst(6, "ci"); action(6, (19301 - 19200) / 0.5);
  await play(22760, 0.5, CH2);                   // ten checks; ARCH-4 red at 22.7 s
  await say(7); action(7, (22701 - 22760) / 0.5);  // on the red, still
  await untilSaid();
  await sayFirst(8, "teams"); action(8);         // its action: the Meanwhile card
  await hold(GAP);

  // ---- 3 · Meanwhile: the other teams' tests on that first PR (the card as it was)
  await openCard("oneOracle");
  await dress(CH2);
  await say(9, 0); action(9);
  await say(10, 0); action(10);
  await untilSaid(GAP);

  // ---- 4 · the red build back to the agent, the repair, CI green
  await openTheater(23300);                      // CI's output on its way to the agent
  camTo("agentCi", 0);
  await dress(CH2);
  await sayFirst(11); action(11, (23900 - 23300) / 0.5);
  await play(24400, 0.5);                        // the CI output reaches the agent at 23.9 s
  await sayFirst(12, "agent"); action(12);
  await play(31700, 2, CH3);                     // reads, edits; the repair's diff card from 31.4 s
  await say(13); action(13, 31400 - 31700);      // the diff on screen, still
  await untilSaid();
  await play(37200, 3);                          // its own checks, no sentence: quick
  await sayFirst(14, "ci"); action(14, 37343 - 37200);
  await play(41440, 1);                          // repair pushed at 37.3 s, CI green at 41.4 s
  const greenMs = 2500 + 4000;                   // the green tower, then every team green on the final PR
  await say(15, 0, greenMs); action(15, 41376 - 41440);
  await hold(2500);

  // ---- 5 · behind the glass on the final PR: every team's tests pass (the replay's own final oracle, 44.4 s on)
  await openTheater(46500);
  cam = { from: SHOT.teams, to: SHOT.teams, t0: wall, ms: 0 };
  camLog.push({ at: wall, shot: "teams (final PR)" });
  await dress(CH3);
  await untilSaid(GAP);

  // ---- 6 · the record card
  await openCard("oneOutro");
  await dress(CH3);
  await say(16, 0); action(16);
  await say(17, 0); action(17);
  await untilSaid(800);
  await page.close();

  fs.writeFileSync(path.join(OUT, "exp-one-run.cues.json"), JSON.stringify({
    clip: "exp-one-run.mp4", poster_s: 0.5, duration_ms: Math.round(wall), cues: cues.map((c) => ({
      n: c.n, start_s: +(c.start / 1000).toFixed(2), end_s: +(c.end / 1000).toFixed(2),
      action_s: +((actions.find((a) => a.n === c.n)?.at ?? c.start) / 1000).toFixed(2), text: c.text })),
    camera: camLog.map((c) => ({ at_s: +(c.at / 1000).toFixed(2), shot: c.shot })),
  }, null, 1) + "\n");
  return wall;
}
