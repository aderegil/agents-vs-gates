# AI-SDLC scenes (illustrations)

One scripted scene per public AI-SDLC model, played by the Replay Theater, plus a compare view. **They are illustrations scripted from public documentation, not measured runs**: every trace says `metadata.source = "illustration"`, every frame carries "Illustration · scripted from public documentation" with the model's source and date (dashed watermark, ILLUSTRATION chip), and the real runs keep "Replay of a real run · <run id>".

| Scene | Source | Where the rule lives | What blocks the merge | Scripted case ends |
|---|---|---|---|---|
| `aisdlc-anthropic` | Anthropic, *The AI-native SDLC playbook* (21 Aug 2026) | CLAUDE.md · Architecture | code owner approval (branch protection); review findings advise | caught at review: LLM compliance pass + human |
| `aisdlc-aws` | AWS AI-DLC blog (31 Jul 2025) + `awslabs/aidlc-workflows` 2.11.0 | design artifacts (Contract Design), reviewed by an LLM | manual approval (tech lead or product owner) | escapes: billing and analytics break |
| `aisdlc-kiro` | Kiro docs: Specs, Steering, Hooks, Custom agents (captured 10 Oct 2026) | steering `structure.md` + `design.md` | the user reviewing the PR (no CI step described) | escapes |
| `aisdlc-speckit` | `github/spec-kit` README + `spec-driven.md` (public docs, read 13 Oct 2026) | the constitution (a project article) + plan gates | team review (no CI or PR step described) | escapes |
| `aisdlc-gate` | this talk's proposal | the spec **and** a required CI check (ARCH-4) | the required check ARCH-4 | caught in CI, repaired, consumers keep working |

- **Same feature everywhere**: Meridian Retail (fictional) renames `totalCents`/`placedAt` on `OrderPlaced` (the experiment's X-rename). People are fictional (names from the Teams plugin rosters).
- **Same scripted premise**: in every scene the agent's first attempt drops the old field names although the rule is in its context. That is the case being illustrated, not a rate. For how often it happens with the rule in view, see the experiment (`results/real/summary.md`): X-rename with the rule in the spec broke 0 of 10 runs on each unit, while Codex X-remove with the rule in the spec broke 7 of 10. A rule the agent can see helps, but it does not guarantee.
- **No invented stages or roles**: each beat cites the section it stages. Where a source is silent (CI in Kiro's and spec-kit's docs; any architecture check in CI in all four), the scene shows that silence ("not described", "no architecture check in CI").
- Role mapping into the AISDLC-Trace role set (only where the trace schema forces it): AWS's Architect Agent plays `task_planner` (it leads Units Generation), because `architect` is a human role in the trace schema; Kiro's "User" and spec-kit's developer are `engineer`; spec-kit's maintainer is `tech_lead`.

Beat → source table, per scene: [`SOURCES.md`](SOURCES.md) (generated).

## Regenerate and play

```
.venv\Scripts\python.exe -X utf8 -m replay.scenes.make_scenes        # traces/, the theater's public/scenes/, SOURCES.md
cd console\plugins\replay\app && npm run build                       # bundles public/scenes into web/dist
```

In the theater: the run picker's group "AI-SDLC models (Illustration · scripted from public documentation)", and the "Compare AI-SDLC models" button (or `?lanes=1`, `?lanes=anthropic,gate`). Tests: `python -m unittest replay.tests.test_scenes`.
