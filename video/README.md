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
