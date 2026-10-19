// The console tour clip (out/console-tour.mp4, ~82 s, silent): sign in → Start here → Results → one run in the Replay
// Theater → the AI-SDLC lanes. Real namespace from prepare.py's read-only snapshot (video/work/results), on the private
// console of console-shots.mjs (:8793 by default, never :8765; it stops only the PID it started).
//
// Same frame machinery as clips.mjs: the context's clock is installed and PAUSED (so the Theater iframe follows it
// too), each frame is one runFor(1000 / fps) then a JPEG screenshot (lib.mjs shot) piped to the encoder. Waits that are
// not filmed (a page loading after a click) advance the clock in small steps until the page is ready, so the next beat
// opens on a finished page. Subtitles sit in a band under the console (the console is shortened by the band's height, so
// a subtitle never covers its text), in the theater chip's style. For the film only, the top document shows plain
// words: codes in brackets ("Main test (P1)", "(V0-S0)") and text that is only a code ("X-remove", "RQ1") are taken off
// screen, as labels.js asks of the video clips; the Theater iframe already shows plain words and is left alone (only
// its lanes view is drawn at 90 % so the grid fits above the band).
//
//   cd video && node clips.mjs --fps 30 --skip-prepare --only console-tour   (AVG_PYTHON=<python> in a worktree)
import { createOwner, startPrivateConsole } from "./console-shots.mjs";
import { shot, sleep } from "./lib.mjs";

const USER = "demo";

/** The beats: seconds and the one short subtitle each (README, "Console tour"). */
export const BEATS = [
  { id: "sign-in", s: 8, sub: "Sign in" },
  { id: "start", s: 18, sub: "Start here: the experiment in five short parts" },
  { id: "results", s: 16, sub: "Results: one tab per question" },
  { id: "replay", s: 24, sub: "Watch one run: pick it, press Play" },
  { id: "compare", s: 16, sub: "Five ways of working, one change" },
];

const RUN_LABEL = "Main test · run 2";
const BAND = 84; // px under the console for the subtitle

export async function captureTour(context, enc, { fps = 30, port = 8793 } = {}) {
  const step = 1000 / fps;
  const now = Date.now();
  await context.clock.install({ time: new Date(now) });
  await context.clock.pauseAt(new Date(now + 1000));
  const { base, stop } = await startPrivateConsole({ port });
  let elapsed = 0; // filmed ms
  try {
    const page = await context.newPage();
    await page.addInitScript(presentation, { band: BAND });
    const pw = await createOwner(page, base, USER);
    // sign the page out again, so the tour starts on the real sign-in form
    await page.evaluate(async () => {
      const s = await (await fetch("/api/session")).json();
      await fetch("/api/logout", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": s.csrf }, body: "{}" });
    });
    await page.goto(`${base}/`);
    await until(page, async () => (await page.locator("input[name=username]").count()) > 0, "sign-in form");

    // ---------------------------------------------------------------- helpers bound to this page
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
    const beat = async (i) => {
      beatEnd += BEATS[i].s * 1000;
      await subtitle(page, BEATS[i].sub);
    };
    const fill = async () => { if (beatEnd - elapsed > step / 2) await frames(beatEnd - elapsed); };
    const point = async (loc, ms = 800) => {
      await ring(page, await loc.boundingBox());
      await frames(ms);
      await ring(page, null);
    };
    const click = async (loc) => {
      await loc.click();
      await page.mouse.move(960, 1080 - BAND / 2); // park the pointer on the band: no hover tooltips on camera
    };
    const type = async (loc, text, perChar = 90) => {
      await loc.focus();
      for (const ch of text) {
        await page.keyboard.type(ch);
        await frames(perChar);
      }
    };

    // ---------------------------------------------------------------- 1 · sign in (8 s)
    await beat(0);
    await frames(1500);
    const user = page.locator("input[name=username]");
    await point(user, 500);
    await type(user, USER, 130);
    await frames(300);
    await type(page.locator("input[name=password]"), pw, 45);
    const signIn = page.getByRole("button", { name: "Sign in" });
    await frames(Math.max(0, beatEnd - elapsed - 900)); // the filled form holds; the click lands on the beat's end
    await point(signIn, 900);
    await click(signIn);
    await fill();
    await until(page, async () => (await page.locator("#pbody .start .panel").count()) >= 5, "Start here");

    // ---------------------------------------------------------------- 2 · Start here, slow scroll (18 s)
    await beat(1);
    await scrollTo(page, 0);
    await frames(2500);
    const max = await page.evaluate(() => { const b = document.getElementById("pbody"); return b.scrollHeight - b.clientHeight; });
    await frames(12000, (i, n) => scrollTo(page, Math.round(max * ease((i + 1) / n))));
    const toResults = page.locator("a.rail-btn[data-plugin=results]");
    await frames(Math.max(0, beatEnd - elapsed - 1200));
    await point(toResults, 900);
    await click(toResults);
    await fill();
    const rq1 = page.getByRole("tab", { name: /Nothing in view/ });
    await until(page, async () => (await rq1.count()) > 0, "Results tabs");
    await until(page, async () => (await page.locator("#pbody .loading").count()) === 0, "Results loaded");

    // ---------------------------------------------------------------- 3 · Results, tab RQ1 (16 s)
    await beat(2);
    await scrollTo(page, 0);
    await frames(1200);
    await point(rq1.first(), 900);
    await click(rq1.first());
    await frames(2500);
    const max3 = await page.evaluate(() => { const b = document.getElementById("pbody"); return b.scrollHeight - b.clientHeight; });
    await frames(8000, (i, n) => scrollTo(page, Math.round(Math.min(max3, 900) * ease((i + 1) / n))));
    const toReplay = page.locator("a.rail-btn[data-plugin=replay]");
    await frames(Math.max(0, beatEnd - elapsed - 1200));
    await point(toReplay, 900);
    await click(toReplay);
    await fill();
    const frame = page.frameLocator("#pbody iframe");
    const picker = frame.locator("select[aria-label='Run to replay']");
    await until(page, async () => (await picker.count()) > 0
      && (await picker.locator("option").count()) > 2, "the theater's run list");
    const play = frame.getByRole("button", { name: /^Play \(Space\)/ });
    // The theater opens on the first run of the list (a trial run whose spec has the rule: at its first moment the
    // rule's label sits on the Architecture library's). Off camera, open another main-test run with no rule first, so
    // the beat starts on a clean office and the pick below is a visible change.
    const opener = await picker.evaluate((sel, label) => {
      const o = [...sel.options].find((x) => {
        const t = ` · ${x.textContent.trim()} · `;
        return !x.disabled && /· Main test · run \d+ ·/.test(t) && t.includes(" · No rule · ") && !t.includes(` · ${label} · `);
      });
      return o ? o.value : null;
    }, RUN_LABEL);
    if (opener) {
      await picker.selectOption(opener);
      await until(page, async () => (await play.count()) > 0, "the opening run");
      for (let i = 0; i < 15; i++) { await page.clock.runFor(100); await sleep(100); }
    }

    // ---------------------------------------------------------------- 4 · Replay Theater: pick a run, Play at 1× (24 s)
    await beat(3);
    await frames(1500);
    await point(picker, 1200);
    const value = await picker.evaluate((sel, label) => {
      const o = [...sel.options].find((x) => !x.disabled && ` · ${x.textContent.trim()} · `.includes(` · ${label} · `));
      return o ? o.value : null;
    }, RUN_LABEL);
    if (!value) throw new Error(`no "${RUN_LABEL}" in the theater's run list`);
    await picker.selectOption(value);
    await until(page, async () => (await play.count()) > 0, "the replay");
    await frames(2500);
    const oneX = frame.locator(".speed-control button", { hasText: /^1×$/ });
    if (await oneX.count()) {
      await point(oneX.first(), 700);
      await click(oneX.first());
    }
    await point(play, 900);
    await click(play);
    const compareBtn = frame.getByRole("button", { name: "Compare AI-SDLC models" });
    await frames(Math.max(0, beatEnd - elapsed - 1200));
    await point(compareBtn, 900);
    await click(compareBtn);
    // the lanes grid was laid out for the full window; the subtitle band takes 84 px, so the theater document is drawn
    // at 90 % for this beat (else the badges of the last columns run into each other)
    const theater = await (await page.locator("#pbody iframe").elementHandle()).contentFrame();
    await theater.evaluate(() => { document.documentElement.style.zoom = "0.9"; });
    await fill();
    const lanesPlay = frame.locator(".lanes").getByRole("button", { name: "Play", exact: true });
    await until(page, async () => (await lanesPlay.count()) > 0, "the lanes view");

    // ---------------------------------------------------------------- 5 · Compare AI-SDLC models (16 s)
    await beat(4);
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

// -------------------------------------------------------------------- page helpers

/** Not filmed: advance the paused clock in small steps (real time passes too) until `ok()` holds. */
export async function until(page, ok, what, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ok().catch(() => false)) {
      await page.clock.runFor(300);
      await sleep(150);
      return;
    }
    await page.clock.runFor(100);
    await sleep(100);
  }
  throw new Error(`console tour: timed out waiting for ${what}`);
}

export const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

export function scrollTo(page, y) {
  return page.evaluate((y) => { const b = document.getElementById("pbody"); if (b) b.scrollTop = y; }, y);
}

/** The subtitle, in the band that presentation() adds under the console. */
export function subtitle(page, text) {
  return page.evaluate((text) => { document.getElementById("tour-sub").textContent = text; }, text);
}

/** Init script (top document only): the subtitle band under the console, and plain words on screen (see the top). */
export function presentation({ band }) {
  if (window.top !== window) return;
  const CODE = String.raw`(?:X-[a-z]+|X1c?|X2|[VSW][0-2](?:[-·][VSW][0-2])*|P\d|C8|RQ\d|HS-V2|H2|R-S[02]|R-C|D\d{1,2}|(?:p\d|x1c?|x2|c8|st)-\d{4})`;
  const LIST = String.raw`(?:${CODE})(?:[\s,·/–-]+(?:${CODE}))*`;
  // in brackets also a data field name such as (staging_break)
  const inParens = new RegExp(String.raw`\s*\((?:${LIST}|[a-z]+(?:_[a-z]+)+)\)`, "g");
  const alone = new RegExp(String.raw`^\s*${LIST}\s*$`);
  const scrub = (t) => {
    const v = t.nodeValue;
    if (!v || !v.trim()) return;
    const w = alone.test(v) ? "" : v.replace(inParens, "");
    if (w === v) return;
    t.nodeValue = w;
    const el = t.parentElement;
    if (el && el !== document.body && !el.textContent.trim()) el.style.display = "none";
  };
  const scan = (n) => {
    if (n.nodeType === 3) return scrub(n);
    if (n.nodeType !== 1 || n.id === "tour-band") return;
    const it = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    for (let t = it.nextNode(); t; t = it.nextNode()) scrub(t);
  };
  const start = () => {
    const css = document.createElement("style");
    css.textContent = `.app,.main{height:calc(100vh - ${band}px)!important}.auth{min-height:calc(100vh - ${band}px)!important}`
      + ".res-gloss,details.code-legend{display:none!important}"
      // the namespace switch (REAL | MOCK) is chrome: the tour only shows real data, and no frame says MOCK
      + "span.ns-switch[aria-label=Namespace]{display:none!important}"
      + `#tour-band{position:fixed;left:0;right:0;bottom:0;height:${band}px;z-index:99999;pointer-events:none;display:flex;`
      + "align-items:center;justify-content:center;background:#fff;border-top:1px solid #dfe3e8}"
      + "#tour-sub{font:500 26px 'IBM Plex Sans',system-ui,sans-serif;color:#2f3744;background:#fff;border:1.5px solid #c4cad3;"
      + "border-radius:6px;padding:6px 18px;white-space:nowrap}#tour-sub:empty{display:none}";
    document.head.appendChild(css);
    const b = document.createElement("div");
    b.id = "tour-band";
    const sub = document.createElement("div");
    sub.id = "tour-sub";
    b.appendChild(sub);
    document.body.appendChild(b);
    scan(document.body);
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "characterData") scrub(m.target);
        else m.addedNodes.forEach(scan);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}

/** A ring around what is about to be clicked (the headless browser has no visible pointer); null removes it. */
export function ring(page, box) {
  return page.evaluate((box) => {
    let r = document.getElementById("tour-ring");
    if (!box) { r?.remove(); return; }
    if (!r) {
      r = document.createElement("div");
      r.id = "tour-ring";
      r.style.cssText = "position:fixed;z-index:99998;pointer-events:none;border:3px solid #5b6474;border-radius:8px;"
        + "box-shadow:0 0 0 4px rgba(91,100,116,.18);";
      document.body.appendChild(r);
    }
    const pad = 6;
    Object.assign(r.style, { left: `${box.x - pad}px`, top: `${box.y - pad}px`, width: `${box.width + 2 * pad}px`,
      height: `${box.height + 2 * pad}px` });
  }, box);
}
