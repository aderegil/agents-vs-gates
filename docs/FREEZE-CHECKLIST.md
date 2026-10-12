# Freeze checklist: PREREGISTRATION.md (prepared 2026-10-12, not frozen)

Prepared by the builder for Alfredo. Read-only on `PREREGISTRATION.md`: nothing here has been applied, nothing is
frozen, nothing has been launched. Line numbers are those of `PREREGISTRATION.md` at commit cfdbbd6.

Kind: **fact** = a measured value, copy it in; **judgment** = Alfredo decides (a proposal is given).

## 1. The [FILL] markers

| Line | Text now | Proposed value | Evidence | Kind |
|---|---|---|---|---|
| 36 | `[FILL: paraphrases used yes/no]` | **yes**: p1..p5 × 2 for X-rename, X-remove and X-api (Codex-generated, the declared deviation in the same bullet) | `results/real/manifest.json` → `paraphrases`: all three `"p1..p5 x2"`; `scenario_io.paraphrases_ready()` is True for all three; the files `scenario/tasks/<ticket>.p1.md … p5.md` exist (15) | fact |
| 46 | `measured value: [FILL from builder report]` | **S1 100 / S2 107 added words; spread 7.0 % (limit 20 %)** | Measured today with the console Scenario plugin's own `count_words` / `added_section` / `fairness` (`console/plugins/scenario/api.py`) on `scenario/context/orders-service/S0–S2.md`; same as DECISIONS "WP6 · Scenario plugin" (S1 +100, S2 +107 → 7.0 %, green). Context files unchanged since 2853840 | fact |
| 97 | `effort [FILL after P0: medium by default]` | **medium** | All 5 P0 records: `effort` = medium; the 30 cc-sonnet X1 runs and the 10 X2 runs ran with medium too, so changing it now would break comparability with the pilots | fact (confirming it is judgment, but the pilots already assume it) |
| 97–98 | `full model id [FILL from P0 system/init]` | **`claude-sonnet-5-5`** (Claude Code `2.1.296`) | `model_reported` = `claude-sonnet-5-5` and `cli_version` = `2.1.296 (Claude Code)` in all 5 P0 records (taken from the `system/init` event) and in all 55 real cc-sonnet records (P0, X1, X2); `results/smoke.json` `model_id` = `claude-sonnet-5-5` | fact |
| 98 | `Codex later (P6), when an account exists.` (no marker, but out of date) | see §2 below | `results/smoke-codex.json`; the 40 `x1c-*` records | judgment (wording) |
| 102 | `Verified by the smoke test: [FILL]` | **yes**: `results/smoke.json` ok, 12 of 12 checks, 2026-10-11T17:00:39Z, Claude Code 2.1.296, `claude-sonnet-5-5`, token not in the environment. See the two caveats in §3 | `results/smoke.json` (`ok: true`, 12/12, `token_in_env: "no"`, `max_turns_subtype: error_max_turns`); every one of the 55 real cc-sonnet records has `contamination.flag: false` and `token_exposed: false` | fact + judgment (the caveats) |
| 258 | `Frozen on [FILL by harness.prereg --freeze], lock hash [FILL]` | **Leave as it is**, or replace it before the freeze with: "The freeze record is `PREREGISTRATION.lock` (UTC time and aggregate SHA-256) and the commit `Freeze pre-registration`; this file is one of the hashed files, so the record cannot be written into it." | `harness/prereg.py`: `PREREGISTRATION.md` is in `GLOBS`, so it is hashed. Writing the time or hash into it after the freeze makes `prereg --verify` report `changed: PREREGISTRATION.md`, and the runner then refuses P1. `freeze()` does not edit this file | judgment |

## 2. Proposed wording for line 98 (Codex)

Replace "Codex later (P6), when an account exists." with:

> `codex` = Codex CLI 0.162.1 + `gpt-5.6-terra`, effort medium, `workspace-write` sandbox on the Windows MXC
> backend, exec policy `harness/adapters/codex_rules/agents-vs-gates.rules` (`harness/units.json`). Live smoke test
> passed (`results/smoke-codex.json`, 18 of 18 checks, 2026-10-12T04:38:17Z). Used in Pilot X1 (exploratory, 40
> runs) and in P6, the replication; P6's scope is unchanged (§6). Declared parity differences: DECISIONS
> 2026-10-11 (reads outside the workspace are detected, not blocked; `node <file>` / `node --test` allowed).

Evidence:
- `harness/units.json`: codex = `{"adapter":"codex","model":"gpt-5.6-terra","effort":"medium","sandbox":"workspace-write","windows_sandbox":"mxc"}`.
- `results/smoke-codex.json`: `ok: true`, `at: 2026-10-12T04:38:17.365Z`, `cli_version: codex-cli 0.162.1`, 18 checks, all ok. (The design session's note says 17/17; the file has 18 checks, all passing.)
- All 40 `x1c-*` records: `model_reported` gpt-5.6-terra, effort medium, codex-cli 0.162.1, `contamination.flag` false, `token_exposed` false.

P6's scope stays as written (121 runs, §6). Only the wording changes.

## 3. Not [FILL]s, but they touch the frozen text

| Line | What | Proposal | Kind |
|---|---|---|---|
| 1, 3–6 | Title "(TEMPLATE — not frozen)" and status "draft template written by the builder on 2026-10-10" | Before freezing, change the title to "Pre-registration — Agents vs. Gates" and the status to "Frozen; see §11 and `PREREGISTRATION.lock`". Otherwise the frozen file calls itself a template | judgment |
| 102 | The Claude smoke (2026-10-11T17:00:39Z) **predates** the widened shell allowlist (commit 43a5d31, 2026-10-11T23:11Z). The smoke's refusal checks (node, curl, git commit, outside writes) do not depend on the added reading commands, and X1/X2 then ran 50 cc-sonnet runs with the widened list (first one 2026-10-12T00:21Z) and no contamination | Either state it ("smoke run before the allowlist was widened; the added commands are read-only"), or re-run `python -m harness.smoke --i-am-authorized` before P1 (live, about 6 calls, Alfredo authorizes) | judgment |
| 102 | `out_of_workspace_access` is not empty in 13 of 55 cc-sonnet records (2 P0, 10 X1, 1 X2; 17 hits). All 17 hits are the agent reading **its own background Bash task's output** under `~\AppData\Local\Temp\claude\C--avg-wN-r\<session>\tasks\*.output`. That is a Claude Code mechanism, not another repo. For Codex all 40 records are non-empty, but most hits are parsing noise: `C:\Program` (from the quoted `pwsh.exe` path) and search patterns such as `\.placedAt` or `\bchannel\b`. There are also reads such as `..\billing-service`, which the declared parity difference covers. Not declared anywhere yet | Declare it in §9 or DECISIONS before P1 ("the detector also flags Claude Code's own task-output files and, for Codex, regex patterns; these are reviewed by hand, not counted as breaches"). Read-only finding; nothing changed | judgment |

## 4. Order of steps (all in `C:\avg\agents-vs-gates`, PowerShell)

1. Edit `PREREGISTRATION.md` (§1 and §2 above, plus whatever is chosen in §3), then **commit it on its own**.
   `harness.prereg --freeze` hashes the files on disk but commits only `PREREGISTRATION.lock` and the manifest. An
   uncommitted edit would be frozen without being in git.
   ```powershell
   git commit -q -m "PREREGISTRATION: fill the freeze-time values" -- PREREGISTRATION.md
   git status --short -- PREREGISTRATION.md scenario ci harness/texts harness/units.json analysis/RUBRIC.md
   git diff --cached --name-only
   ```
   Both status commands must print nothing: no changes in any frozen file and nothing staged.
2. Freeze, then check:
   ```powershell
   .venv\Scripts\python.exe -X utf8 -m harness.prereg --freeze
   .venv\Scripts\python.exe -X utf8 -m harness.prereg --verify
   ```
   `--freeze` writes `PREREGISTRATION.lock` and commits `Freeze pre-registration` together with
   `results/real/manifest.json` (sha256 `118d4a9c1c5709d8e26955cdb96745bf2dfb7b0f77ed4f55e98ade1877401aa2`). It
   refuses if a lock already exists. `--verify` must report no problems.
3. Before P1: no other runner active, at least 6 GB free RAM, then a last dry-run (60 runs, p1-0001..0060):
   ```powershell
   .venv\Scripts\python.exe -X utf8 -m harness.runner --ns real --stage P1 --dry-run
   ```
4. Launch P1 with 3 workers:
   ```powershell
   .venv\Scripts\python.exe -X utf8 -m harness.runner --ns real --stage P1 --workers 3
   ```
   The runner refuses unless `results/smoke.json` is ok and `prereg --verify` passes. P1 is blinded; follow it with
   `harness.runner --ns real --status`. Estimate: about 590 worker-minutes, so 3.5–4 h with 3 workers. This uses
   X1/X2 means per cell (X-rename V0·S0 18 min/run). The V0·S2 cells are unmeasured and assumed equal to V0·S0.
