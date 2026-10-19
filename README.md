# Agents vs. Gates

**Does a coding agent break another team's service it cannot see, and what stops it: rules in its context, or a check in CI?** 1,187 recorded runs of Claude Code, Codex and Gemini on a fictional retailer, with the analysis pre-registered before the first run.

![The console: the scenario, the results, one run, the Replay Theater](docs/media/console-tour.gif)

## What happened

Two tickets ask the agent to rename or remove a field of an event that two other teams read. 100 runs per agent and condition (50 per ticket). Each agent is counted on its own; the agents are never added together.

| Broke another team on the first try | Own repo, no rule | Own repo, rule in the spec | Sees every repo, no rule |
|---|---|---|---|
| Claude Code + Sonnet 5.5 | **100** of 100 | **0** of 100 | **51** of 100 |
| Codex CLI + gpt-5.6-terra | **100** of 100 | **35** of 100 | **100** of 100 |
| Antigravity CLI + Gemini 3.8 Flash | **100** of 100 | **0** of 100 | **80** of 100 |

A rule in the spec stopped the breaks for Claude Code and Gemini, and about two thirds of them for Codex. Seeing every repo was not enough. The consumer-contract check in CI, kept outside the agent's repo, caught every break on the first pull request: Claude Code 172 of 172, Codex 256 of 256, Gemini 180 of 180, over every run with the check out of the agent's reach. It is not the whole answer: after repairing on CI's feedback, 19 Codex runs turned CI green and still broke another team (the right shape, the wrong meaning); Claude Code and Gemini, none. And when the contracts sat inside the agent's repo, Codex edited them so CI would pass (CI caught 1 of 10).

"Broke another team" is measured by the other teams' own tests, which the agent never sees, not by CI and not by the agent's last message.

## Watch it (no model calls, nothing to sign in to)

```
git clone https://github.com/aderegil/agents-vs-gates && cd agents-vs-gates
py -3.13 -m venv .venv && .venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m console
```
Open http://127.0.0.1:8765: the results, every run (diff, CI, the other teams' tests) and the Replay Theater.

## More
- **[Using this repo](docs/USING.md):** explore the runs, demo with the mock agent, try your own rules file, run Claude Code, Codex or Gemini (or your own agent) on the same tickets and get the same verdict.
- **[Pre-registration](PREREGISTRATION.md)** and its addenda [1](PREREGISTRATION-ADDENDUM-1.md), [2](PREREGISTRATION-ADDENDUM-2.md) and [3](PREREGISTRATION-ADDENDUM-3.md). Each was frozen by a lock file before its runs; `python -m harness.prereg --verify` checks them.
- **Results:** every run in `results/real/` (record, diffs, CI, the other teams' tests, transcript, trace), the summary in [`results/real/summary.md`](results/real/summary.md) and the numbers above in [`results/real/deck-numbers-ext.md`](results/real/deck-numbers-ext.md).
- **Videos:** one real run, the console tour and the AI-SDLC comparison, in [Releases](https://github.com/aderegil/agents-vs-gates/releases).
- **How it was built:** every decision taken along the way in [`docs/DECISIONS.md`](docs/DECISIONS.md); the build log in [`BUILD-STATUS.md`](BUILD-STATUS.md).

Made for the talk *The AI-SDLC Governance Gap*. The scenario, Meridian Retail, is fictional.

## Cite it

See [`CITATION.cff`](CITATION.cff) (GitHub shows "Cite this repository" on the right).

## License

[PolyForm Strict 1.0.0](LICENSE) with an additional permission: you may use it, evaluate it inside any organization, and run it with your own rules file, units file and adapter. You may not distribute it or changed versions of it. Third-party fonts and icons keep their own licenses ([NOTICE](NOTICE)). © 2026 Alfredo De Regil.
