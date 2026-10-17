// Stills of the console for segment 2, from a PRIVATE console (never Alfredo's :8765):
//   python -m console --port 8793 --data-dir video/work/console-data
// with AVG_RESULTS_ROOT = video/work/results (prepare.py's snapshot of results/real, no bundles) and AVG_ROOT = an
// empty folder, so nothing it caches or writes can land in results/ or the workers. Stops only the PID it started.
// startPrivateConsole and createOwner are shared with console-tour.mjs.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO, WORK, isAlive, sleep } from "./lib.mjs";

/** The repo's .venv; AVG_PYTHON overrides it (a git worktree has no .venv of its own: point it at the main checkout's
 * interpreter; the console still runs this checkout's code, since it starts with cwd = REPO and -m console). */
export function python() {
  const py = process.env.AVG_PYTHON || path.join(REPO, ".venv", "Scripts", "python.exe");
  if (!fs.existsSync(py)) throw new Error(`no Python at ${py} (set AVG_PYTHON to the main checkout's .venv\Scripts\python.exe)`);
  return py;
}

async function waitUp(port, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/session`);
      if (r.ok) return;
    } catch { /* not yet */ }
    await sleep(1000);
  }
  throw new Error(`private console on :${port} did not start`);
}

/** Starts the private console on a fresh data dir. Returns { base, stop }; stop() ends only the PID started here. */
export async function startPrivateConsole({ port = 8793 } = {}) {
  if (port === 8765) throw new Error("8765 is Alfredo's console; use another port");
  const data = path.join(WORK, "console-data");
  const aw = path.join(WORK, "avg-empty");
  const results = path.join(WORK, "results");
  if (!fs.existsSync(path.join(results, "real", "runs"))) throw new Error("no video/work/results snapshot: run prepare.py first");
  fs.rmSync(data, { recursive: true, force: true });
  fs.mkdirSync(aw, { recursive: true });
  const env = { ...process.env, AVG_RESULTS_ROOT: results, AVG_ROOT: aw, PYTHONUTF8: "1" };
  const proc = spawn(python(), ["-X", "utf8", "-m", "console", "--port", String(port), "--data-dir", data],
    { cwd: REPO, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let err = "";
  proc.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
  console.log(`  private console pid ${proc.pid} on :${port}`);
  const stop = () => {
    if (isAlive(proc.pid)) { try { execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }
    if (err && /Traceback/.test(err)) console.log(err);
  };
  try {
    await waitUp(port);
  } catch (e) {
    stop();
    throw e;
  }
  return { base: `http://127.0.0.1:${port}`, stop };
}

/** Creates the throwaway owner through the first-run API (that signs the page in) and picks the real namespace. */
export async function createOwner(page, base, username = "video") {
  await page.goto(`${base}/`);
  const pw = crypto.randomBytes(12).toString("hex") + "-Aa1";
  const ok = await page.evaluate(async ([user, pw]) => {
    const s = await (await fetch("/api/session")).json();
    const r = await fetch("/api/setup", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": s.csrf },
      body: JSON.stringify({ username: user, password: pw, confirm: pw }) });
    if (r.status !== 201 && r.status !== 200) return `setup ${r.status}`;
    const j = await r.json();
    const n = await fetch("/api/session/ns", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": j.csrf },
      body: JSON.stringify({ ns: "real" }) });
    return n.ok ? "ok" : `ns ${n.status}`;
  }, [username, pw]);
  if (ok !== "ok") throw new Error(`console setup failed: ${ok}`);
  return pw;
}

export async function captureConsole(context, { port = 8793 } = {}) {
  const shots = path.join(WORK, "shots");
  fs.mkdirSync(shots, { recursive: true });
  const { base, stop } = await startPrivateConsole({ port });
  try {
    const page = await context.newPage();
    await createOwner(page, base);
    await page.goto(`${base}/#/run-control`);
    await page.reload();
    await page.waitForTimeout(6000);
    await page.screenshot({ path: path.join(shots, "run-control.png") });
    await page.goto(`${base}/#/results`);
    await page.waitForTimeout(6000);
    const tab = page.getByRole("tab", { name: /Pilot X1/ });
    if (await tab.count()) await tab.first().click();
    else await page.getByText("Pilot X1 · exploratory").first().click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(shots, "results-x1.png") });
    await page.close();
  } finally {
    stop();
  }
}
