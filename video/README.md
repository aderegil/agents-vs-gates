# Talk video (draft)

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

## Rules it keeps
- Nothing is written outside `video/work`, `video/out` and `docs/qa/video-*.png`; `results/` is read only.
- No model calls, no experiment runner. CPU: one browser at a time, 15 fps on a virtual clock, ffmpeg `-threads 2`.
- Disk: the build stops if C: has less than 5 GB free. Frames are piped, never written to disk.
- Light palette; cyan = pass, pink = fail only. Fictional people only (the theater's owners are labelled fictional).
- `video/work`, `video/out` and `node_modules` are gitignored; the MP4 stays out of git.
