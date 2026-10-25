// exp-one-run.mp4, fourth version (coordinator's orders, 2026-10-24, rounds 1 and 2, approved by Alfredo).
//
// Layout (1920×1080): the scene on the left (1200×960), the run's real log on the right (720×960), and a black band
// of 120 px under both with the sentence Alfredo reads live. The log lists the run's own events (the replay's steps,
// from events.jsonl, in the theater's plain words), the current one highlighted: it is always the event the scene is
// showing, so the animation reads as what it is, a reading of the log.
//
// The narration is data (narration/exp-one-run.json, literal) and drives the clock. Two kinds of sentence:
//   A (anticipates): the scene stands still while it is read; its action starts when it ends, and then plays for at
//     least 2 s with an empty band before the next sentence;
//   D (describes): what it describes is already on screen, still, at least 0.5 s before it appears.
// A sentence stays max(3 s, words / 1.8 + 1.0 s), one at a time. The camera arrives before its sentence. Cue times
// come from the frames really filmed (out/exp-one-run.cues.json), with each action's time and the margin.
//
// Used by clips.mjs (segments: [{ kind: "one-run" }]): headless Edge on a paused virtual clock, one JPEG per frame.
// The theater opens with ?subs=0 (no subtitle), ?bubbles=none and ?light=0.45; the cards with ?nocap=1.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ORIGIN, OUT, REPO, WORK, clockStepper, shot } from "./lib.mjs";

const NARRATION = JSON.parse(fs.readFileSync(new URL("./narration/exp-one-run.json", import.meta.url), "utf8"));
const PHRASE = new Map(NARRATION.phrases.map((p) => [p.id, p]));
const words = (s) => s.split(/\s+/).filter(Boolean).length;
export const phraseMs = (s) => Math.max(3000, (words(s) / 1.8) * 1000 + 1000);
const GAP = 400;            // empty band between two sentences
const WATCH = 2000;         // after an A sentence's action starts: empty band at least this long
const SHOWN = 550;          // a D sentence's subject on screen at least this long before it
const CAM_MS = 1700;
const W = 1920, LOG_W = 580, SCENE_W = W - LOG_W, BAND_H = 120, SCENE_H = 1080 - BAND_H;

// Camera shots on the stage canvas: centre and width as fractions of the canvas (the height follows from the
// scene's 1340:960). From the theater's floor plan: Product x≈0.2 and Maya 0.17 (the define column), the agent's desk
// 0.38, the PR tray 0.50, the CI tower 0.58, the glass 0.65, the teams 0.70–0.95; the repair's diff card 0.11–0.29.
const SHOT = {
  wide: { cx: 0.5, cy: 0.5, fw: 1 },
  define: { cx: 0.2, cy: 0.47, fw: 0.48 },
  middle: { cx: 0.48, cy: 0.42, fw: 0.52 },
  diff: { cx: 0.21, cy: 0.4, fw: 0.36 },
  agent: { cx: 0.36, cy: 0.42, fw: 0.5 },
  // the agent with its diff cards whole (they sit at x 0.11–0.29, left of the desk) and the PR tray
  agentWide: { cx: 0.3, cy: 0.42, fw: 0.54 },
  // the assignment: Product, Maya's library, the agent and the CI tower in one shot
  assign: { cx: 0.39, cy: 0.47, fw: 0.64 },
  ci: { cx: 0.6, cy: 0.42, fw: 0.5 },
  agentCi: { cx: 0.38, cy: 0.42, fw: 0.66 },     // the tower, the agent and the first diff card whole
  teams: { cx: 0.67, cy: 0.45, fw: 0.56 },
};
// Signs drawn over the stage, in its own coordinates (they move with the camera), in the style of the theater's
// test badges. Each shows over a span of the replay's clock in one segment.
const SIGNS = {
  ownTests: { x: 0.29, y: 0.535, cls: "pass", text: "✓ own tests pass (39)" },        // the agent's message at 18.2 s
  ciFailed: { x: 0.56, y: 0.215, cls: "fail big", text: "✗ CI failed · ARCH-4" },      // CI's result at 22.7 s, over the tower
};

const TITLE = "One real run · Claude Code · no rule";
const CH1 = "1 · The change", CH2 = "2 · The red build", CH3 = "3 · The repair";
const SCENE_BG = "#f6f7f9", THEATER_BG = "rgb(234,237,244)";
const fmtSpeed = (x) => String(Math.round(x * 100) / 100);
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

// ---------------------------------------------------------------------------------------------------- the log
const SHORT_ACTOR = { "code-orders": "Agent", "flow-engine": "Experiment", ci: "CI", staging: "Other teams' tests" };
/** Nothing local on screen: the run's workspace path goes, any other drive path is cut (the release package rule). */
function redact(s) {
  return s.replace(/[A-Za-z]:\\avg\\w\d+\\r\\/g, "").replace(/[A-Za-z]:\\[^\s'"`)]*/g, "…");
}
const clean = (s) => redact(String(s ?? "")).replace(/```/g, "").replace(/`/g, "").replace(/\*\*/g, "").replace(/\t/g, " ")
  .replace(/\s*\n+\s*/g, " · ").replace(/\s{2,}/g, " ").replace(/\bfixed_code\b/g, "fixed").trim();
const FORBIDDEN = /\\avg\\|\\Users|alfredo|cloud folder|\\w\d\\|token|password|@gmail/i;
const mmss = (ms) => { const s = Math.round((ms ?? 0) / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

/** The log's rows from the replay's steps: tool calls without their raw output, repeated edits counted, each CI run
 * as what it ran and what failed, the agent's message once. */
export async function logRows(replay) {
  const { plainReplay } = await import(pathToFileURL(path.join(REPO, "console", "plugins", "replay", "app", "src",
    "components", "labels.ts")).href);
  const r = plainReplay(replay);
  const rows = [];
  const push = (s, who, text, tone = "") => rows.push({ t: s.t_ms, real: s.t_real_ms, who, text, tone });
  let ci = null;
  let lastSaid = "";
  for (const s of r.steps) {
    if (s.action === "move") continue;
    const d = s.detail ?? {};
    const text = clean(s.text);
    const who = SHORT_ACTOR[s.actor] ?? s.actor;
    if (s.action === "check") {
      if (!ci) { ci = { pass: [], fail: [] }; push(s, "CI", "picks up the pull request · runs 10 checks"); }
      if (!text) continue;
      const id = text.split(" ")[0];
      if (/\bFAIL\b/.test(text)) ci.fail.push(text); else ci.pass.push(id);
      continue;
    }
    if (s.action === "ci_result") {
      if (ci) {
        for (const f of ci.fail) push(s, "CI", f, "fail");
        push(s, "CI", `${ci.pass.length} checks pass: ${ci.pass.join(", ")}`, "pass");
      }
      push(s, "CI", text, /fail/i.test(text) ? "fail" : "pass");
      ci = null;
      continue;
    }
    if (!text) continue;
    if (d.event_type === "TOOL_CALL_COMPLETED") {
      // the raw output of a tool stays out; a short result (no match) or a refusal is shown
      if (/denied/i.test(text)) push(s, who, "↳ tool use denied (no approval surface in the run)", "fail");
      else if (text.length < 40) push(s, who, `↳ ${text}`);
      continue;
    }
    if (s.action === "speak") {
      if (text.slice(0, 80) === lastSaid) continue;   // the same message handed to the harness
      lastSaid = text.slice(0, 80);
    }
    const prev = rows.at(-1);
    if (prev && prev.who === who && prev.text.replace(/ \(\d+×\)$/, "") === text) {
      const n = Number((/\((\d+)×\)$/.exec(prev.text) || [0, 1])[1]) + 1;
      prev.text = `${text} (${n}×)`;
      continue;
    }
    const tone = s.action === "oracle" ? (/failed/.test(text) ? "fail" : "pass") : "";
    const said = s.action === "speak" ? `“${text}”` : s.action === "oracle"
      ? text.replace(" (gen):", " · first PR:").replace(" (final):", " · final PR:") : text;
    push(s, who, said, tone);
  }
  for (const row of rows) {
    if (FORBIDDEN.test(row.text)) throw new Error(`log row not clean: ${row.text}`);
  }
  return rows;
}
const currentRow = (rows, t) => { let k = 0; rows.forEach((r, i) => { if (r.t <= t) k = i; }); return k; };

// ---------------------------------------------------------------------------------------------- page chrome
const CHROME_CSS = `
#clip-band{position:fixed;left:0;right:0;bottom:0;height:${BAND_H}px;background:#000;z-index:100000;display:flex;
  align-items:center;justify-content:center;}
#clip-band div{max-width:1800px;text-align:center;color:#fff;font:500 40px/1.2 'IBM Plex Sans',system-ui,sans-serif;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
#clip-log{position:fixed;top:0;right:0;width:${LOG_W}px;height:${SCENE_H}px;z-index:99990;background:#fff;
  border-left:2px solid #d5dae1;box-sizing:border-box;display:flex;flex-direction:column;font-family:'IBM Plex Sans',system-ui,sans-serif;}
#clip-log header{padding:18px 20px 12px;border-bottom:1.5px solid #e3e6eb;}
#clip-log h2{margin:0;font-size:28px;font-weight:600;color:#111827;}
#clip-log header p{margin:4px 0 0;font-size:18px;color:#5b6474;}
#clip-log .list{position:relative;flex:1;overflow:hidden;}
#clip-log ol{position:absolute;left:0;right:0;top:0;margin:0;padding:10px 0 0;list-style:none;}
#clip-log.hint{box-shadow:inset 0 0 0 4px #22c3e6;}
#clip-log li{display:grid;grid-template-columns:58px 1fr;gap:8px;padding:6px 20px;font-size:19px;line-height:1.3;color:#111827;opacity:.55;}
#clip-log li .t{font-variant-numeric:tabular-nums;color:#5b6474;}
#clip-log li .x{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
#clip-log li .w{font-weight:600;margin-right:8px;}
#clip-log li.fail .x{color:#be123c;} #clip-log li.pass .x{color:#116329;}
#clip-log li.now{opacity:1;background:#111827;color:#fff;}
#clip-log li.now .t{color:#cbd5e1;} #clip-log li.now .x{white-space:normal;display:-webkit-box;-webkit-line-clamp:3;
  -webkit-box-orient:vertical;}
#clip-log li.now.fail .x{color:#fda4af;} #clip-log li.now.pass .x{color:#86efac;}
#clip-log li.future{display:none;}
#clip-title{position:fixed;left:0;top:0;z-index:99999;box-sizing:border-box;padding:14px 26px;max-width:${SCENE_W}px;
  font:600 30px/1.2 'IBM Plex Sans',system-ui,sans-serif;color:#111827;}
#clip-reading{position:fixed;bottom:${BAND_H + 16}px;right:${LOG_W + 16}px;z-index:99999;padding:5px 12px;border-radius:6px;
  background:#fff;border:1.5px solid #c4cad3;font:500 18px 'IBM Plex Sans',system-ui,sans-serif;color:#374151;}
#clip-signs{position:fixed;transform-origin:0 0;z-index:99980;pointer-events:none;}
#clip-signs div{position:absolute;transform:translate(-50%,-50%);white-space:nowrap;padding:2px 8px;border-radius:3px;
  font:600 13px/1.35 'IBM Plex Sans',system-ui,sans-serif;}
#clip-signs .pass{color:#116329;background:#fff;border:2px solid #1fb45a;}
#clip-signs .fail{color:#fff;background:#e11d5f;}
#clip-signs .big{font-size:16px;padding:3px 10px;}`;

async function installChrome(page, rows, { log }) {
  await page.addStyleTag({ content: CHROME_CSS });
  await page.evaluate(([rows, log, reading]) => {
    const el = (tag, attrs = {}, html = "") => { const n = document.createElement(tag); Object.assign(n, attrs); n.innerHTML = html; return n; };
    const band = el("div", { id: "clip-band" }); band.append(el("div")); document.body.append(band);
    if (!log) return;
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const box = el("aside", { id: "clip-log" }, `<header><h2>The run's log · real</h2>
      <p>Claude Code · Sonnet · 12 Oct 2026 · its own events, real time</p></header><div class="list"><ol></ol></div>`);
    const ol = box.querySelector("ol");
    for (const r of rows) ol.append(el("li", { className: r.tone }, `<span class="t">${r.real != null ? esc(r.realLabel) : ""}</span>`
      + `<span class="x"><span class="w">${esc(r.who)}</span>${esc(r.text)}</span>`));
    document.body.append(box);
    document.body.append(el("div", { id: "clip-reading" }, reading));
    let y = null;
    window.__clipLog = (k) => {
      const items = [...ol.children];
      items.forEach((li, i) => { li.classList.toggle("now", i === k); li.classList.toggle("future", i > k); });
      const list = box.querySelector(".list");
      const cur = items[k];
      const target = Math.max(0, cur.offsetTop + cur.offsetHeight - list.clientHeight * 0.72);
      y = y === null ? target : y + (target - y) * 0.16;     // smooth follow, one step per frame
      ol.style.transform = `translateY(${-y.toFixed(1)}px)`;
    };
  }, [rows.map((r) => ({ ...r, realLabel: mmss(r.real) })), log, "The animation is a reading of this log →"]);
}

async function setBox(page, id, text, css) {
  await page.evaluate(([id, text, css]) => {
    let d = document.getElementById(id);
    if (!text) { d?.remove(); return; }
    if (!d) { d = document.createElement("div"); d.id = id; if (css) d.style.cssText = css; document.body.appendChild(d); }
    d.textContent = text;
  }, [id, text, css]);
}
const CHAPTER_CSS = (bg) => "position:fixed;left:0;top:0;z-index:99999;display:flex;align-items:center;height:62px;"
  + `box-sizing:border-box;padding:0 26px;background:${bg};font:600 28px 'IBM Plex Sans',system-ui,sans-serif;color:#111827;`;
const CHIP_CSS = `position:fixed;right:${LOG_W + 16}px;bottom:${BAND_H + 62}px;z-index:99999;font:500 18px 'IBM Plex Sans',system-ui,sans-serif;`
  + "color:#5b6474;background:#fff;border:1.5px solid #c4cad3;border-radius:6px;padding:4px 10px;";
const MARK_CSS = `position:fixed;right:${LOG_W + 16}px;bottom:${BAND_H + 104}px;z-index:99999;font:600 22px 'IBM Plex Sans',system-ui,sans-serif;`
  + "color:#fff;background:#1f2937;border-radius:6px;padding:3px 12px;";

// ---------------------------------------------------------------------------------------------- the capture
/** The whole clip into one encoder. Returns its length in ms and writes the cue list. */
export async function captureOneRun(context, enc, { fps, oneRunId }) {
  const replay = JSON.parse(fs.readFileSync(path.join(WORK, "replays", `${oneRunId}.json`), "utf8"));
  const rows = await logRows(replay);
  const step = 1000 / fps;
  const cues = [];             // { id, type, text, start, end, action }
  const camLog = [];
  let wall = 0;
  let lastEnd = -GAP, quietUntil = 0, shownAt = 0;
  let page = null, kind = null, cardT = 0, cardFreeze = 0, logOn = false, logRow = 0;
  let rt = 0;                  // the replay's clock in the theater
  let speed = 0.5, at = 0, signs = [];
  let canvasBox = null;        // the stage canvas in the page, before any transform
  let tick = null;             // the theater page's clock, moved by exact amounts (lib.mjs clockStepper)
  let cam = { from: SHOT.wide, to: SHOT.wide, t0: 0, ms: 0 };

  const camAt = (t) => {
    const p = cam.ms ? ease(Math.min(1, Math.max(0, (t - cam.t0) / cam.ms))) : 1;
    const f = cam.from, g = cam.to;
    return { cx: f.cx + (g.cx - f.cx) * p, cy: f.cy + (g.cy - f.cy) * p, fw: f.fw + (g.fw - f.fw) * p };
  };
  const camDone = () => cam.t0 + cam.ms;
  const bandAt = (t) => {
    const c = cues.find((q) => t >= q.start && t < q.end);
    if (!c) return { text: "", o: 0 };
    return { text: c.text, o: Math.min(1, (t - c.start) / 200, (c.end - t) / 200) };
  };

  const frame = async (adv) => {
    const band = bandAt(wall);
    if (kind === "card") {
      await page.evaluate(([t, b, k, log]) => {
        window.SCENE.render(t);
        const d = document.querySelector("#clip-band div"); d.textContent = b.text; d.style.opacity = b.o;
        if (log) window.__clipLog(k);
      }, [Math.min(cardT, cardFreeze), band, logRow, logOn]);
      cardT += adv;
    } else {
      if (adv > 0) { await tick(adv); rt += adv; }
      const r = { ...camAt(wall) };
      const { x, y, w, h } = canvasBox;
      // a close-up never shows past the stage's edges (the define column sits at its left edge)
      const fh = r.fw * (w / h) * (SCENE_H / SCENE_W);
      if (r.fw < 1 && fh <= 1) {
        r.cx = Math.min(1 - r.fw / 2, Math.max(r.fw / 2, r.cx));
        r.cy = Math.min(1 - fh / 2, Math.max(fh / 2, r.cy));
      }
      const s = 1 / r.fw;
      const tx = SCENE_W / 2 - x - s * r.cx * w, ty = SCENE_H / 2 - y - s * r.cy * h;
      const on = signs.filter((g) => rt >= g.from && rt < g.to).map((g) => g.sign);
      await page.evaluate(([tx, ty, s, b, k, on]) => {
        const t = `translate(${tx}px, ${ty}px) scale(${s})`;
        const c = document.querySelector("canvas");
        c.style.transformOrigin = "0 0"; c.style.transform = t;
        const g = document.getElementById("clip-signs"); g.style.transform = t;
        g.innerHTML = on.map((x) => `<div class="${x.cls}" style="left:${x.x * 100}%;top:${x.y * 100}%">${x.text}</div>`).join("");
        const d = document.querySelector("#clip-band div"); d.textContent = b.text; d.style.opacity = b.o;
        window.__clipLog(k);
      }, [tx, ty, s, band, currentRow(rows, rt), on]);
    }
    await enc.push(await shot(page));
    wall += step;
  };
  const hold = async (ms) => {
    const n = Math.round(ms / step);
    if (n && kind === "theater") await setBox(page, "clip-mark", null);   // a still frame is not fast-forward
    for (let i = 0; i < n; i++) await frame(kind === "card" ? step : 0);
  };
  const holdUntil = async (t) => { if (t > wall) await hold(t - wall); };
  const camTo = (name, ms = CAM_MS) => { cam = { from: camAt(wall), to: SHOT[name], t0: wall, ms }; camLog.push({ at: wall, shot: name }); };
  const cut = (name) => { cam = { from: SHOT[name], to: SHOT[name], t0: wall, ms: 0 }; camLog.push({ at: wall, shot: `${name} (cut)` }); };
  /** What a D sentence describes is on screen from `ms` of clip time from now (negative: it already was). */
  const shown = (ms = 0) => { shownAt = wall + ms; };

  /** A sentence: it waits for the band, the camera and (D) its subject; then it is read with the scene still. */
  const say = async (id) => {
    const p = PHRASE.get(id);
    if (!p) throw new Error(`no sentence ${id}`);
    let start = Math.max(wall, lastEnd + GAP, quietUntil, camDone());
    if (p.type === "D") start = Math.max(start, shownAt + SHOWN);
    await holdUntil(start);
    const c = { id, type: p.type, text: p.text, start: wall, end: wall + phraseMs(p.text), action: p.type === "D" ? shownAt : null,
      replay: kind === "theater" ? rt : null, row: kind === "theater" ? currentRow(rows, rt) : logOn ? logRow : null };
    cues.push(c);
    lastEnd = c.end;
    await holdUntil(c.end);
    if (p.type === "A") { c.action = wall; quietUntil = wall + WATCH; }   // its action is the next thing that plays
  };

  const dress = async (chapter) => {
    if (chapter !== undefined) {
      await setBox(page, "clip-title", null);
      await setBox(page, "clip-chapter", chapter, CHAPTER_CSS(kind === "card" ? SCENE_BG : THEATER_BG));
    }
    if (kind === "theater") {
      await setBox(page, "clip-chip", `Real run · ${fmtSpeed(speed)}× speed`, CHIP_CSS);
      await setBox(page, "clip-mark", speed > 0.5 ? `×${fmtSpeed(speed / 0.5)}` : null, MARK_CSS);
    }
  };
  const play = async (to, sp, chapter) => {
    speed = sp;
    await dress(chapter);
    // the replay's clock lands exactly on `to` (rounding a whole number of frames per stretch drifted it ~0.2 s
    // behind by the end, so the log and the D sentences lagged the scene); the last frame takes the remainder
    while (to - rt > 1e-6) await frame(Math.min(step * sp, to - rt));
    at = to;
  };

  /** A scene card in the left part (log on) or across the whole width (log off), cropped to what it shows. */
  const openCard = async (id, { log, query = "", row = null, freeze }) => {
    await page?.close();
    page = await context.newPage();
    // a card's own time stops once all of it is in (the cards fade out after their old fixed length)
    kind = "card"; cardT = 0; cardFreeze = freeze; logOn = log;
    if (row !== null) logRow = row;
    await page.goto(`${ORIGIN}/scenes/index.html?s=${id}&nocap=1${query}`);
    await page.waitForFunction(() => window.READY || window.SCENE_ERROR, null, { timeout: 60000 });
    const err = await page.evaluate(() => window.SCENE_ERROR || null);
    if (err) throw new Error(`${id}: ${err}`);
    await installChrome(page, rows, { log });
    // round 5: "pass" in the clip's green (as the theater's ?pass=green); fail stays pink
    await page.addStyleTag({ content: ":root{--pass:#1fb45a;--pass-tinta:#116329;--pass-suave:#e6ffec;}" });
    // the card's content (all of it shown), its box, then scaled to fill the area under the chapter label
    const area = { w: log ? SCENE_W : W, h: SCENE_H };
    await page.evaluate(([area]) => {
      const st = document.getElementById("stage");
      window.SCENE.render(1e9);
      let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0;
      for (const n of st.children) {
        if (n.classList.contains("caption")) continue;
        const r = n.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
      }
      const m = 30, top = 70;
      const w = x1 - x0 + 2 * m, h = y1 - y0 + 2 * m;
      const s = Math.min(area.w / w, (area.h - top) / h);
      const tx = (area.w - s * w) / 2 - s * (x0 - m), ty = top + (area.h - top - s * h) / 2 - s * (y0 - m);
      st.style.transformOrigin = "0 0";
      st.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
      window.SCENE.render(0);
    }, [area]);
  };
  const openTheater = async (from, { title = false } = {}) => {
    await page?.close();
    page = await context.newPage();
    kind = "theater"; logOn = true;
    await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-13T12:00:01Z"));
    await page.goto(`${ORIGIN}/theater/index.html?replay=/replays/${oneRunId}.json&present=1&subs=0&header=0&stagger=1&envdelay=1200&pass=green&bubbles=none&light=0.45&t=${from}`);
    await page.waitForSelector("canvas", { timeout: 60000 });
    // the player in the left 1200×960 (its 16:9 stage centred there), the log on the right, the band under both
    await page.addStyleTag({ content: `html,body,#root{width:${SCENE_W}px!important;height:${SCENE_H}px!important;overflow:visible!important}
      .player{width:${SCENE_W}px!important;height:${SCENE_H}px!important;overflow:visible!important}
      .player.is-presenting .stage-frame{max-width:${SCENE_W}px!important}
      .stage-area,.main-col,.body,.stage-frame{overflow:visible!important}` });
    await installChrome(page, rows, { log: true });
    await page.evaluate(() => { const g = document.createElement("div"); g.id = "clip-signs"; document.body.append(g); });
    await page.clock.runFor(3000);               // presentation chrome hides after 2.5 s
    await page.keyboard.press("2");              // 1×: the clip sets the pace by how far the clock runs per frame
    await page.keyboard.press("Space");
    tick = clockStepper(page);
    canvasBox = await page.evaluate(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await page.evaluate(([b]) => Object.assign(document.getElementById("clip-signs").style,
      { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` }), [canvasBox]);
    if (title) await setBox(page, "clip-title", TITLE);
    at = from; rt = from;
  };

  // ---- the poster: the whole office, the log's first lines, the title; an empty band
  await openTheater(0, { title: true });
  cut("wide");
  await dress();
  await hold(1000);

  // ---- the ticket card (the log's first event, the assignment)
  const assign = rows.findIndex((r) => /different names/.test(r.text));
  const introStart = 450 + SHOWN;                // the card fades in over 450 ms
  const noteAt = introStart + phraseMs(PHRASE.get("1").text) + 100;
  await openCard("oneIntro", { log: true, query: `&note=${noteAt}`, row: Math.max(0, assign), freeze: noteAt + 600 });
  await dress(CH1);
  shown(450);
  await say("1");
  shown(noteAt + 450 - cardT);
  await say("2");

  // ---- the office, the change, its own tests, the PR, CI red
  await openTheater(0);
  cut("wide");
  await dress(CH1);
  // the context: what is where (Alfredo's review, round 3), the camera still on each place before its sentence
  await page.evaluate(() => document.getElementById("clip-log").classList.add("hint"));
  shown(0);
  await say("3a");
  await page.evaluate(() => document.getElementById("clip-log").classList.remove("hint"));
  for (const [id, where] of [["3b", "define"], ["3c", "middle"], ["3d", "teams"]]) {
    camTo(where);
    shown(CAM_MS);
    await say(id);
  }
  signs = [{ sign: SIGNS.ownTests, from: 18224, to: 22701 }, { sign: SIGNS.ciFailed, from: 22701, to: 1e9 }];
  // the assignment (round 4): the camera on both flights before the sentence; when it ends the ticket flies from
  // Product to the agent and the ARCH-1…ARCH-8 sheet from Maya's library to the CI tower (2.4 s each, the theater's
  // own sheets), then the agent loads its context
  camTo("assign");
  await say("3e");
  await play(3200, 1);
  camTo("agentWide");
  await say("4");
  await play(18450, 3);                          // reads and edits (×6); the agent's message "All 39 tests pass" at 18.2 s
  shown(-(18450 - 18224) / 3);
  await say("5a");
  await say("5b");
  await play(19250, 0.5);                        // PR opened at 18.5 s
  camTo("ci");
  await say("6");
  await play(22760, 0.5, CH2);                   // ten checks; ARCH-4 red at 22.7 s
  shown(-(22760 - 22701) / 0.5);
  await say("7");
  camTo("teams");
  await say("8");                                // its action: the Meanwhile card

  // ---- Meanwhile: the other teams' tests on that first PR, across the whole width
  await openCard("oneOracle", { log: false, freeze: 5000 });
  await dress(CH2);
  shown(2100 + 450);                             // billing's and analytics' rows (the card shows them at 0.5 and 2.1 s)
  await say("9");
  await say("10");

  // ---- the red build back to the agent, the repair, CI green
  // CI's output envelope leaves the tower at 23.9 s in the clip (?envdelay=1200: the tower stays clear on "Red.")
  await openTheater(23800);
  signs = [];
  cut("agentCi");
  await dress(CH2);
  await say("11");
  await play(25400, 0.5);                        // the envelope flies 23.9–25.1 s and reaches the agent
  camTo("agentWide");
  await say("12");
  await play(31700, 2, CH3);                     // reads, edits; the repair's diff card from 31.4 s
  camTo("diff");                                 // the diff card large enough to read (round 3)
  shown(CAM_MS);
  await say("13");
  camTo("ci");
  await play(37250, 3);                          // its own checks, no sentence: quick
  await say("14");
  await play(41440, 1);                          // repair pushed at 37.3 s, CI green at 41.4 s
  shown(-(41440 - 41376) / 1);
  await say("15");

  // ---- behind the glass on the final PR: every team's tests pass (the replay's final oracle, from 44.4 s)
  await holdUntil(lastEnd + GAP);
  await openTheater(46500);
  cut("teams");
  await dress(CH3);
  await hold(2600);

  // ---- the record card, the log finished; the last frame holds 3 s with an empty band
  await openCard("oneOutro", { log: true, row: rows.length - 1, freeze: 4500 });
  await dress(CH3);
  shown(3500 + 450);                             // the card's last line at 3.5 s
  await say("16");
  await say("17");
  await say("18");                               // the closing line (round 5); then the still poster, empty band
  await holdUntil(lastEnd + 3000);
  await page.close();

  const s2 = (ms) => (ms == null ? null : +(ms / 1000).toFixed(2));
  fs.writeFileSync(path.join(OUT, "exp-one-run.cues.json"), JSON.stringify({
    clip: "exp-one-run.mp4", poster_first_s: 0, poster_last_s: s2(wall - step), duration_ms: Math.round(wall),
    rule: NARRATION.rule,
    cues: cues.map((c) => ({ id: c.id, type: c.type, start_s: s2(c.start), end_s: s2(c.end), action_s: s2(c.action),
      margin_s: c.type === "A" ? s2(c.action - c.end) : s2(c.start - c.action), replay_s: s2(c.replay),
      log_row: c.row === null ? null : rows[c.row].text.slice(0, 60), text: c.text })),
    camera: camLog.map((c) => ({ at_s: s2(c.at), shot: c.shot })),
  }, null, 1) + "\n");
  return wall;
}
