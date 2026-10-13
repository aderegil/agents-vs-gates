// Shared helpers for the talk video: Edge via playwright-core (no browser download), a routed origin that serves
// local files, and an ffmpeg pipe that turns JPEG screenshots into an H.264 segment.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const VIDEO = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.dirname(VIDEO);
export const WORK = path.join(VIDEO, "work");
export const OUT = path.join(VIDEO, "out");
export const FFMPEG = require("ffmpeg-static");
export const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
export const ORIGIN = "http://video.local";
export const W = 1920;
export const H = 1080;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};

/** URL prefix -> local folder, served at ORIGIN by Playwright routing (no HTTP server, nothing listens). */
export function mounts() {
  return {
    "/theater/": path.join(WORK, "theater"),
    "/replays/": path.join(WORK, "replays"),
    "/data/": WORK,
    "/shots/": path.join(WORK, "shots"),
    "/scenes/": path.join(VIDEO, "scenes"),
    "/fonts/": path.join(REPO, "console", "web", "fonts"),
  };
}

/** Edge through a browser server, so the exact PID we started is known and can be stopped if close() hangs. */
export async function launch() {
  const { chromium } = require("playwright-core");
  const server = await chromium.launchServer({ executablePath: EDGE, headless: true, args: ["--disable-gpu-vsync", "--hide-scrollbars"] });
  const browser = await chromium.connect(server.wsEndpoint());
  browser.shutdown = async () => {
    const pid = server.process()?.pid;
    await Promise.race([browser.close().then(() => server.close()), sleep(20000)]).catch(() => undefined);
    if (pid && isAlive(pid)) { try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }
  };
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "light",
    reducedMotion: "no-preference", locale: "en-US" });
  const table = mounts();
  await context.route(`${ORIGIN}/**`, async (route) => {
    const u = new URL(route.request().url());
    const prefix = Object.keys(table).find((p) => u.pathname.startsWith(p));
    if (!prefix) return route.fulfill({ status: 404, body: "not mounted" });
    const rel = decodeURIComponent(u.pathname.slice(prefix.length)) || "index.html";
    const file = path.resolve(table[prefix], rel);
    if (!file.startsWith(path.resolve(table[prefix])) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return route.fulfill({ status: 404, body: `missing ${u.pathname}` });
    }
    return route.fulfill({ status: 200, body: fs.readFileSync(file),
      headers: { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" } });
  });
  return { browser, context };
}

/** An ffmpeg process that reads JPEG frames on stdin at `fps` and writes an H.264 MP4 at 30 fps (frames repeated). */
export function encoder(outFile, fps) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg",
    "-i", "-", "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-threads", "2",
    "-movflags", "+faststart", "-an", outFile];
  const p = spawn(FFMPEG, args, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  let failed = null;
  p.on("error", (e) => { failed = e; });
  const done = new Promise((resolve, reject) => p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code} for ${outFile}`)))));
  return {
    frames: 0,
    async push(buf) {
      if (failed) throw failed;
      this.frames += 1;
      if (!p.stdin.write(buf)) await new Promise((r) => p.stdin.once("drain", r));
    },
    async close() { p.stdin.end(); await done; },
  };
}

export async function shot(page) {
  return page.screenshot({ type: "jpeg", quality: 90, animations: "allow", caret: "hide" });
}

export function ffprobeDuration(file) {
  // ffmpeg-static ships no ffprobe: read "Duration: hh:mm:ss.xx" from ffmpeg -i
  let txt = "";
  try { execFileSync(FFMPEG, ["-hide_banner", "-i", file], { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { txt = String(e.stderr || ""); }
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(txt);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export function freeGB() {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-PSDrive C).Free"], { encoding: "utf8" });
  return Number(out.trim()) / 1024 ** 3;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
