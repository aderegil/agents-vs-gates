# Talk video and deck clips

A 4–5 minute, 1920×1080, silent MP4 for "The AI-SDLC Governance Gap" (Alfredo narrates live). Subtitles are drawn
into the frames. Storyboard: `docs/qa/video-storyboard.md`.

## Regenerate (one command)

```
cd video
npm ci            # once: playwright-core + ffmpeg-static (no browser download; uses the installed Edge)
npm run build     # -> video/out/agents-vs-gates-talk-draft.mp4 (+ out/timings.txt, docs/qa/video-*.png)
```

When the X1 pilot closes, refresh `results/real/x1-summary.json` (`python -m analysis.pilot_x1`, Alfredo's call) and
re-render only what depends on it:

```
node build.mjs --only 02-experiment,05-results,04c-stop-answer --skip-console
```

Options: `--only <ids>` (comma list, then re-concatenates), `--skip-prepare`, `--skip-console` (reuse
`work/shots/*.png`), `--stills-only`, `--fps 15`, `--port 8793`, `--break-run x1-0002`, `--stop-run x1-0003`,
`--summary auto|file|live`.

## How it works
1. `prepare.py` (repo `.venv`, read-only on `results/` and `scenario/`) writes `video/work/`: the two replays built in
   memory with `replay.export.build_replay` (never cached into `results/`), the X1 summary, the scenario (catalog,
   broker contracts, ARCH rules; canary markers stripped), the runner timeline, facts from the two featured records, and
   a snapshot of `results/real` without workspace bundles.
   `--summary auto` uses `results/real/x1-summary.json` when it covers every X1 record, else computes the same
   `analysis.pilot_x1.summarize("real")` in memory; the results segment shows "DRAFT · N runs so far".
2. `console-shots.mjs` starts a **private** console (`python -m console --port 8793 --data-dir video/work/console-data`,
   `AVG_RESULTS_ROOT=video/work/results`, `AVG_ROOT=` an empty folder), creates a throwaway owner, takes the Run
   Control and Results stills, and stops only the PID it started. It never touches `:8765`.
3. `build.mjs` drives headless Edge through playwright-core on a virtual clock: the scene pages (`scenes/`, a pure
   `render(t)` per frame) and the Replay Theater build (`console/plugins/replay/web/dist`, copied to `work/theater` at
   prepare time) opened with `?replay=…&present=1` (and `&cut=1` for the director's cut). Frames are JPEG screenshots at
   15 fps piped to ffmpeg (`-threads 2`, libx264 CRF 20, repeated to 30 fps); segments are concatenated without
   re-encoding.

Segments: `01-company` (45 s) · `02-experiment` (45 s) · `03a/b/c` break case x1-0002 (intro, director's cut, record)
· `04a/b/c` contrast x1-0003 (intro, 0.5× replay, the agent's final message verbatim) · `05-results` (≥ 45 s).

## Deck clips (night of 2026-10-13): one MP4 per slide

```
cd video
node clips.mjs --fps 30                       # prepare_clips.py, every clip, out/manifest.json
node clips.mjs --fps 30 --only exp-one-run    # one clip (the manifest keeps the others)
```

`out/manifest.json` lists each clip with `file`, `duration_s`, `shows`, `source`, `label`, `format`. All 1920×1080,
H.264, 30 fps, no audio, short English subtitles in frame.

| File | What it shows | Data |
|---|---|---|
| `exp-one-run.mp4` | One real run (the poll-PR run, `analysis.select_poll_pr`), ~2.5 min: ticket → rename → own tests → PR → CI red (ARCH-4) → the other teams' tests on that first PR → red build back to the agent → @deprecated aliases → CI green | `results/real/runs/<run>` |
| `exp-codex-contract.mp4` | One P6 Codex X-remove V1·S0 run (first in manifest order with a D6 flag): edits the analytics contract and the check script, CI green, analytics broken | same |
| `exp-company-design.mp4` | Meridian Retail (fictional), the design and the gates | `scenario/` |
| `aisdlc-<model>.mp4` | The scripted AI-SDLC scenes (anthropic, aws, kiro, speckit, gate): **Illustration · scripted from public documentation** on every frame | `replay/scenes` |
| `aisdlc-compare.mp4` | The five scenes on one phase axis (the theater's lanes view) | `public/scenes/index.json` |
| `console-tour.mp4` | The console itself, 82 s: sign in → Start here → Results → one run in the Theater → the lanes (see "Console tour") | `work/results` snapshot |

`prepare_clips.py` builds the two real replays in memory (never written to `results/`), the card facts
(`work/clip-facts.json`, from the records) and freezes the theater build in `work/theater`. Theater segments run on a
**paused** virtual clock (`page.clock.pauseAt`): installed but running, Playwright's clock also follows wall time, and
every slow screenshot pushed the replay ahead (the first night renders ran ~3× fast; fixed before delivery).

## Rules it keeps
- Nothing is written outside `video/work`, `video/out` and `docs/qa/video-*.png`; `results/` is read only.
- No model calls, no experiment runner. CPU: one browser at a time, 15 fps on a virtual clock, ffmpeg `-threads 2`.
- Disk: the build stops if C: has less than 5 GB free. Frames are piped, never written to disk.
- Light palette; cyan = pass, pink = fail only. Fictional people only (the theater's owners are labelled fictional).
- `video/work`, `video/out` and `node_modules` are gitignored; the MP4 stays out of git.

## Theater QA (theater-1016)
```
node qa-stills.mjs --tag after                 # fixed-moment stills -> docs/qa/theater-1016-<shot>-<tag>.png
node qa-overlap.mjs --tag after                # overlap sweep, every 250 ms of 8 replays -> docs/qa/theater-1016-overlap-<tag>.txt
node qa-avatars.mjs --tag after                # portrait contact sheet (pure pixel code, no browser)
```
`--dist <folder>` points the first two at another theater build (e.g. a saved copy for "before"). They need
`work/replays/` from `prepare_clips.py` for the two real runs.

## Console tour (built 2026-10-17, theater-1016)
`out/console-tour.mp4`: 82 s, 1920×1080, H.264, 30 fps, silent (~4.5 MB), with its entry in `out/manifest.json`
(`label: "Console tour"`): sign in → Start here → Results → one run in the Replay Theater → the AI-SDLC lanes. Real
namespace, from the read-only snapshot of `results/real`; no mock runs, no made-up numbers (a stage still sealed shows
its lock: "Third agent · Blinded until stage complete").
- **Code:** `video/console-tour.mjs`, `captureTour(context, enc, { fps, port })`. The private console now lives in
  `console-shots.mjs` as `startPrivateConsole()` + `createOwner()` (shared with the stills): `python -m console --port
  8793 --data-dir video/work/console-data`, `AVG_RESULTS_ROOT=video/work/results`, `AVG_ROOT=video/work/avg-empty`, a
  throwaway owner `demo`; it stops only its own PID and refuses `:8765`. The interpreter is the repo's `.venv`, or
  `AVG_PYTHON` (a worktree has no `.venv`; the console still runs the worktree's code: cwd = repo, `-m console`).
  `clips.mjs` has the entry (`segments: [{ kind: "console" }]`) and the `renderSegment` branch; `--port` is passed on.
- **How it films:** `context.clock.install` + `pauseAt` (the Theater iframe follows it), one `runFor(1000 / FPS)` +
  `lib.mjs` `shot` per frame. Each beat ends on the click that opens the next page; the load is waited for off camera
  (the clock steps on until the page is ready), so every beat opens on a finished page. A grey ring marks what is about
  to be clicked (headless has no visible pointer) and the pointer is parked off the page after each click.
- **Subtitles** sit in an 84 px white band under the console (the console's `.app`/`.main` are shortened by the band,
  so a subtitle never covers page text), in the theater chip's style. For the film only, an init script in the top
  document takes codes off screen as `labels.js` asks of the clips: a code in brackets ("Main test (P1)", "(V0-S0)",
  "(staging_break)") is dropped, text that is only a code ("X-remove", "RQ1") is hidden, and the "What the codes mean"
  legends are hidden. The Theater iframe is left as it is, except its lanes view, drawn at 90 % so the grid fits.
- **Beats (82 s):** sign in on the real form, typed (8 s, «Sign in») · Start here, slow scroll through the five blocks
  (18 s, «Start here: the experiment in five short parts») · Results, tab «Nothing in view» (16 s, «Results: one tab
  per question») · Replay Theater: pick «Main test · run 2», 1×, Play (24 s, «Watch one run: pick it, press Play»;
  off camera the theater is first set to another main-test run with no rule, because the run it opens on by default
  has a label overlap at its first moment) · «Compare AI-SDLC models», Play 8 s, then End (16 s, «Five ways of
  working, one change»).
- **Commands that built it** (Git Bash, from the worktree, 2026-10-17; the copy step reads the main checkout's
  `results/` read-only, writes only `video/work/`):
  ```
  cd /c/avg/theater-1016
  AVG_RESULTS_ROOT='C:\avg\agents-vs-gates\results' AVG_ROOT='C:\avg\theater-1016\video\work\avg-empty' \
    /c/avg/agents-vs-gates/.venv/Scripts/python.exe -X utf8 video/prepare.py
  cd video
  AVG_PYTHON='C:\avg\agents-vs-gates\.venv\Scripts\python.exe' node clips.mjs --fps 30 --skip-prepare --only console-tour
  ```
  From the main checkout after the merge: `.venv\Scripts\python.exe -X utf8 video\prepare.py`, then `cd video` and
  `node clips.mjs --fps 30 --skip-prepare --only console-tour` (no `AVG_PYTHON` needed). Render: ~4 min wall; it
  stops if free RAM < 6 GB. Stills for QA: `node_modules/ffmpeg-static/ffmpeg.exe -ss <s> -i out/console-tour.mp4
  -frames:v 1 work/tour-frames/<name>.png`.
