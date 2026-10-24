// Measures, in the filmed frames, when each sentence shows in the black narration band and compares it with the
// clip's cue list (out/<clip>.cues.json). Round 4 (2026-10-24): the cue lists were the plan; this checks the film.
//
//   node measure-band.mjs exp-one-run            # or aisdlc-compare-neutral
//
// ffmpeg reads the band (the bottom 120 px) at 30 fps as tiny grey frames; a frame "has text" when enough of its
// pixels are bright. Runs of text frames are the sentences, in order.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FFMPEG, OUT } from "./lib.mjs";

const clip = process.argv[2] || "exp-one-run";
const file = path.join(OUT, `${clip}.mp4`);
const cues = JSON.parse(fs.readFileSync(path.join(OUT, `${clip}.cues.json`), "utf8")).cues;
const W = 240, H = 15;
const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf",
  `fps=30,crop=1920:120:0:960,scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
if (r.status !== 0) throw new Error(String(r.stderr));
const buf = r.stdout;
const n = buf.length / (W * H);
const lit = [];
for (let i = 0; i < n; i++) {
  let bright = 0;
  for (let k = i * W * H; k < (i + 1) * W * H; k++) if (buf[k] > 110) bright++;
  lit.push(bright > 12);
}
const runs = [];
for (let i = 0; i < n; i++) {
  if (lit[i] && (i === 0 || !lit[i - 1])) runs.push({ a: i });
  if (lit[i] && (i === n - 1 || !lit[i + 1])) runs.at(-1).b = i + 1;
}
console.log(`${clip}: ${runs.length} sentences seen, ${cues.length} in the cue list`);
runs.forEach((run, i) => {
  const c = cues[i] || {};
  const a = run.a / 30, b = run.b / 30;
  const id = c.id ?? c.n ?? "?";
  console.log(`${String(id).padEnd(3)} film ${a.toFixed(2)} → ${b.toFixed(2)}   plan ${c.start_s?.toFixed(2)} → ${c.end_s?.toFixed(2)}`
    + `   Δstart ${(a - c.start_s).toFixed(2)}  Δend ${(b - c.end_s).toFixed(2)}`);
});
