// The README's animated GIF (docs/media/console-tour.gif): five short cuts of out/console-tour-full.mp4, ~14 s, under
// 5 MB. Palette per clip, 10 fps, 960 px wide.
//
//   cd video && node readme-gif.mjs [--width 960] [--fps 10]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FFMPEG, OUT, REPO } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const WIDTH = Number(opt("--width", 960));
const FPS = Number(opt("--fps", 10));
const SRC = path.join(OUT, "console-tour-full.mp4");
const DST = path.join(REPO, "docs", "media", "console-tour.gif");

/** [from, to] seconds of the full tour: the rules, the three agents, one run's other teams' tests, the theater at the
 * moment CI fails the pull request, the AI-SDLC lanes. */
export const CUTS = [[19.0, 21.5], [52.5, 55.5], [76.0, 78.5], [94.5, 97.5], [108.0, 111.0]];

function main() {
  if (!fs.existsSync(SRC)) throw new Error(`${SRC} is missing: render console-tour-full first`);
  fs.mkdirSync(path.dirname(DST), { recursive: true });
  const parts = CUTS.map(([a, b], i) => `[0:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS,fps=${FPS},scale=${WIDTH}:-1:flags=lanczos[c${i}]`);
  const concat = `${CUTS.map((_, i) => `[c${i}]`).join("")}concat=n=${CUTS.length}:v=1:a=0[v]`;
  const pal = "[v]split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", SRC, "-filter_complex",
    [...parts, concat, pal].join(";"), "-loop", "0", DST], { stdio: "inherit" });
  const mb = fs.statSync(DST).size / 1024 ** 2;
  const secs = CUTS.reduce((s, [a, b]) => s + b - a, 0);
  console.log(`${path.relative(REPO, DST)}: ${secs.toFixed(1)} s · ${WIDTH} px · ${FPS} fps · ${mb.toFixed(2)} MB`);
  if (mb >= 5) console.log("over 5 MB: try --width 800 or --fps 8");
}

main();
