# Agents vs. Gates

**Does a coding agent break another team's service it cannot see? And what stops it: rules in its context, or a check in CI?**

A pre-registered experiment: 1,187 recorded runs of Claude Code, Codex and Gemini (Antigravity CLI) on the four repos of a fictional retailer. The analysis was written down and frozen before the first run.

![The console: the scenario, the results, one run, the Replay Theater](docs/media/console-tour.gif)

## What it found

Two tickets ask the agent to rename or remove a field of an event that two other teams read. Each agent ran 100 times per condition (50 per ticket). Each agent is counted on its own: the numbers are never added across agents, and this is not a race between agents.

| Broke another team on the first try | Own repo, no rule | Own repo, rule in the spec | Sees every repo, no rule |
|---|---|---|---|
| Claude Code + Sonnet 5.5 | **100** of 100 | **0** of 100 | **51** of 100 |
| Codex CLI + gpt-5.6-terra | **100** of 100 | **35** of 100 | **100** of 100 |
| Antigravity CLI + Gemini 3.8 Flash | **100** of 100 | **0** of 100 | **80** of 100 |

- A rule in the spec stopped the breaks for Claude Code and Gemini, and about two thirds of them for Codex.
- Seeing every repo was not enough.
- A consumer-contract check in CI, kept outside the agent's repo, caught every break on the first pull request: Claude Code 172 of 172, Codex 256 of 256, Gemini 180 of 180 (every run where the check was out of the agent's reach).
- It is not the whole answer. After repairing on CI's feedback, 19 Codex runs turned CI green and still broke another team (the right shape, the wrong meaning); Claude Code and Gemini, none. When the contracts sat inside the agent's repo, Codex edited them so CI would pass.

"Broke another team" means the other teams' own tests failed. The agent never sees those tests. It is not CI's verdict and not the agent's last message.

## Watch it in three commands

No model calls, nothing to sign in to. Windows 11, Python 3.13 or later:

```
git clone https://github.com/aderegil/agents-vs-gates && cd agents-vs-gates
py -3 -m venv .venv && .venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m console
```

Open http://127.0.0.1:8765: the results, every run (its diff, CI's checks, the other teams' tests) and the Replay Theater.

## Try it

Section 5 of [Using this repo](docs/USING.md) runs the same cycle on your code. You bring:

1. **Your repo**: a folder; the agent works on a clean copy of it.
2. **Your rules**: one file, given to the agent as its context file.
3. **Your tickets**: plain-text files, one ticket each.

And your gates: your CI command, and tests for the other teams that the agent never sees. Try it first with the example and the mock agent (no model calls). Your CI and your teams' tests are yours, so the numbers are not comparable with the experiment.

The same guide also covers exploring the runs, demos with the mock agent, your rules on the experiment's tickets, and Claude Code, Codex, Gemini or your own agent on them.

## Videos

Watch them on the [Releases](../../releases) page (MP4, 1920×1080, no audio; they are files of the release, so the repository stays small):

- [One real run](../../releases/latest/download/exp-one-run.mp4) (3:51): the ticket, the change, CI's red build, the other teams' tests, the repair, with the run's own log next to the animation.
- [AI-SDLC models, side by side](../../releases/latest/download/aisdlc-compare-neutral.mp4) (2:15): where the architecture rule lives in four public models, and what can block the merge. An illustration scripted from public documentation.
- [A tour of the console](../../releases/latest/download/console-tour-full.mp4) (1:52): the scenario, the results, one run, the Replay Theater.

## More

- **Pre-registration:** [PREREGISTRATION.md](PREREGISTRATION.md) and its addenda [1](PREREGISTRATION-ADDENDUM-1.md), [2](PREREGISTRATION-ADDENDUM-2.md) and [3](PREREGISTRATION-ADDENDUM-3.md), each frozen by a lock file before its runs, and [erratum 1](PREREGISTRATION-ERRATUM-1.md) (one line of the introduction, nothing of the plan). `python -m harness.prereg --verify` checks them.
- **Results:** every run in `results/real/` (record, diffs, CI, the other teams' tests, transcript, trace); the summary in [`results/real/summary.md`](results/real/summary.md); the numbers above in [`results/real/deck-numbers-ext.md`](results/real/deck-numbers-ext.md). Machine and account identifiers in the published copy are redacted.
- **Decisions:** every deviation and decision taken along the way, in [`docs/DECISIONS.md`](docs/DECISIONS.md). The internal build documents it and the pre-registration name (the build spec, the build log, QA screenshots) are not published.
- **Formats:** the trace and record contracts in [`docs/contracts/`](docs/contracts/README.md).

Made for the talk *The AI-SDLC Governance Gap*. Meridian Retail, its teams and its people are fictional.

## Cite it

See [`CITATION.cff`](CITATION.cff) (GitHub shows "Cite this repository" on the right).

## License

License: PolyForm Strict 1.0.0 with an additional permission (see [LICENSE](LICENSE)). Third-party fonts and icons keep their own licenses ([NOTICE](NOTICE)). © 2026 Alfredo De Regil.
