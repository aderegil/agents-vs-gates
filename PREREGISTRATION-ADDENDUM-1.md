# Pre-registration addendum 1 — P7 (more runs on the P1 cells) and P8 (a third unit, `agy-flash`)

> Status: **final text for freezing** (the freeze is proven by `PREREGISTRATION-ADDENDUM-1.lock`, not by this line). Written 2026-10-15/16 on branch `ext-1016`, before any P7, P8 or C8 run.
> It is frozen by Alfredo (🔒) with `.venv\Scripts\python.exe -X utf8 -m harness.prereg --freeze-addendum 1`, after
> the agy smoke test (passed 2026-10-16) and before C8: P8's N is fixed here (§2); C8 only decides whether P8
> starts. The command writes
> `PREREGISTRATION-ADDENDUM-1.lock` with the UTC time, the SHA-256 of this file and of the files P7 and P8 add
> (`harness/units-ext.json`, `harness/adapters/agy.py`, `results/real/manifest-ext1.json`), and the hashes of the
> original lock it extends. The runner starts P7 or P8 only if **both** locks verify.
>
> `PREREGISTRATION.md` and `PREREGISTRATION.lock` (file SHA-256 `a9e01cfc…`, aggregate `3bc8017e…`, frozen
> 2026-10-12 12:20 UTC) are **not edited and not re-frozen**. Where this addendum says nothing, the original applies.
> P0–P6, their records and their p-values are not touched.

## 1. Why this addendum exists
- **Sharper numbers on the cells the talk relies on.** With N = 10 per cell, "0 of 10" only bounds the true rate
  below 30.8 % (95 % Clopper-Pearson); "0 of 20" below 16.8 %. With 40 new runs per cell, "0 of 40" bounds it below
  8.8 %; P1 + P7 combined (50 per cell) below 7.1 %; 100 per condition (two tickets) below 3.6 %.
- **A third unit from a third vendor.** The design uses **one mid-tier model per vendor, the everyday one**:
  Sonnet 5.5 (`cc-sonnet`), gpt-5.6-terra (`codex`) and Gemini 3.8 Flash (`agy-flash`, decided by Alfredo on
  2026-10-15). By Alfredo's own enquiry the three are comparable; that is context for choosing them, **not something
  this experiment tests or reports**. The high-tier question was answered by P5 (`cc-opus` behaved like `cc-sonnet`).
  Gemini 4 Argon (high tier, available with Google AI Pro) is out of scope and is not calibrated.

## 2. Stages, N, seed

| Stage | Unit | Cells | New runs per cell | Runs |
|---|---|---|---|---|
| C8 calibration (exploratory; not analysed; exempt from both locks) | `agy-flash` | X-rename V0·S0 ×3, V0·S2 ×2 (base text, as P0) | — | 5 |
| **P7** (extension of P1) | `cc-sonnet` | the 6 P1 cells: {X-rename, X-remove} × {V0·S0, V0·S2, V2·S0} | 40 | 240 |
| **P7** | `codex` | the same 6 cells (V2·S0 added by Alfredo on 2026-10-16, before the freeze) | 40 | 240 |
| **P8** (third unit) | `agy-flash` | the 6 P1 cells | 20 (fixed by Alfredo on 2026-10-16, before C8) | 120 |

- **Same as P1 and P6:** ticket texts and paraphrases, context texts (S0/S1/S2), scenario (hash `b02008da…`,
  recorded per run), limits (gen 30 turns / 600 s; each repair 15 turns / 360 s; at most 3 repairs), CI feedback text,
  effort medium, oracle, detectors and blinding. Paraphrases: in round r every cell uses slot p((r − 1) mod 5 + 1),
  so each P7 cell sees each of p1..p5 eight times and each P8 cell four times.
- **Manifest:** generated once with the new seed **20261016** into the sidecar `results/real/manifest-ext1.json`
  (`python -m harness.manifest --ext1-sidecar --with-p7 --with-p8 [--p8-n N]`), block-randomized by rounds like the
  original (round r holds one replicate of every cell of the stage, shuffled with
  `random.Random(f"20261016:{stage}:{r}")`; the units of P7 share the rounds). Run ids `p7-0001..0480`,
  `p8-0001..0120`, `c8-0001..0005`. The frozen `manifest.json` is not touched. The runner runs one unit per process
  (`--unit`). P7 `cc-sonnet`, P7 `codex` and C8 may run at the same time (different accounts, different worker
  folders); P8 starts after C8, once Alfredo authorizes it.
- **What C8 decides.** Only whether P8 starts (the CLI works over 5 sessions and the quota readout makes 120 runs
  before the deadline plausible). It does not change N, cells or analysis. If Alfredo does not start P8, P8 is reported
  as not run, with the reason.
- **V0·S0 is the concurrent control.** It already gave 10 of 10 in P1; it is repeated so that a change in the model
  or the CLI since 12 Oct (Claude Code 2.1.296, codex-cli 0.162.1) shows up in the same rounds. Every run records
  `cli_version` and `model_reported`. A change is a **declared deviation** (the runner notes it in
  `state.drift_notes` and keeps going), not a reason to stop.
- **Stopping rule:** N is fixed. No result is unblinded before its stage is complete (P7 is complete when both units
  are). An infrastructure failure is re-queued with the same id, at most twice, then `infra_failure_final` (original
  §5), as in P6. A rate limit pauses the runner (exit 3) and is resumed later; it is never a reason to stop. There is
  no stop for results. If quota or time runs out, the stage stops after k complete rounds and is reported with k.
- **P8 quota stop (declared before any P8 run).** If the Google AI Pro quota is exhausted and P8 cannot be completed by
  **23 Oct 2026, 23:59 Monterrey time**, P8 ends at the last complete round k (each of the 6 cells has k runs) and is
  reported as "stopped by quota after k of 20 rounds", a deviation caused by quota, not by results. Runs of the
  incomplete round are listed but not analysed. Nothing is unblinded to make this decision.
- **Deadline:** P7 and P8 run, unblinded and summarized **by 24 Oct 2026** (the talk is on 27 Oct).

## 3. Analysis plan (written before any run)
1. **Confirmatory, per unit, on the new runs only:**
   - **H2:** `staging_break` (oracle on `gen`) V0·S0 vs V0·S2, two-sided Fisher exact per ticket (X-rename,
     X-remove), **Holm over the 2 tickets within each unit**: P7 for `cc-sonnet`, P7 for `codex`, P8 for
     `agy-flash`. Three separate families; no correction across units.
   - **HS-V2** (secondary): V2·S0 vs V0·S0, two-sided Fisher per ticket, **uncorrected**, labelled secondary, as in
     the original §7, for each unit: P7 `cc-sonnet`, P7 `codex` and P8 `agy-flash`. It stays outside the Holm families.
2. **Descriptive:** P1 + P7 combined for `cc-sonnet`, and P6 (P1 part) + P7 for `codex`: N = 50 per cell, 100 per
   condition (both tickets). P6 had no V2·S0 cell for `codex`, so its V2·S0 figures are P7 only (N = 40 per cell, 80
   per condition). **Counts and 95 % Clopper-Pearson intervals only. No p-values on combined data.**
   Percentages are allowed only with N ≥ 20 (original §7).
3. **Units are never compared with each other** (no test, no ranking, no "better/worse"; §5).
4. Everything else as in the original §5–§7: three boxes (done & safe / done & breaks / not done), CI↔oracle with the
   by-construction note, repair outcomes, gate edits (T1/T2/T3) and `no_change` confirmed by blind coding (two
   independent AI coders, the declared deviation already in use since P1), exclusions (canary hits, exposed tokens,
   isolation breaches) listed apart.
5. **Deck table** (`results/real/deck-numbers-ext.md`), exact numerators and denominators per unit and condition:
   without the rule / seeing every repo / rule in the spec; CI caught X of Y breaks; final PR that breaks; gate edits.

## 4. Parity: how `agy-flash` differs from the other units (declared)
`agy-flash` = Antigravity CLI (`agy`) + `gemini-3.8-flash-medium`, signed in with Alfredo's Google account
(Google AI Pro since 15 Oct; no API key). The CLI updated itself from 1.3.6 to 1.4.0 during the smoke on 2026-10-16;
every run records `cli_version`, and a later change is a declared deviation (as in §2), not a stop. Adapter: `harness/adapters/agy.py`; smoke: `harness/smoke_agy.py`.
1. **Memory between runs (main risk).** agy keeps memory in `~\.gemini\antigravity-cli\` (`brain\`, `conversations\`,
   `annotations\`, `knowledge\`, `implicit\`, `conversation_summaries.db`, `history.jsonl`, summaries). Each run gets
   its own HOME (`USERPROFILE`/`HOME` = the worker's cfg folder, wiped at every run), seeded only with a copy of the
   sign-in files; no folder is copied, so no memory, global rules, skills, plugins, MCP servers or saved permissions.
   The real HOME's memory is fingerprinted (names, sizes, times; never contents) before and after every session: any
   change makes the session an `isolation_breach` (the batch stops; the run is never data). Nothing in Alfredo's real
   `~\.gemini` is written or deleted. The repairs resume the same conversation (`--conversation`) inside the run's HOME.
2. **Context file.** The S text goes in `GEMINI.md` at the workspace root (`CLAUDE.md` for Claude Code, `AGENTS.md`
   for Codex; same bytes). agy also reads global rules from `~\.gemini\GEMINI.md`, `AGENTS.md` and `config\`: none is
   seeded. No `.agents\`, `.agent\`, `GEMINI.md` or `AGENTS.md` exists above the workspaces (`harness.doctor`). The
   smoke records whether agy also reads a workspace `AGENTS.md` (informational).
3. **Turn cap.** agy has no `--max-turns`. Its cap is the wall clock only, through `--print-timeout` with the same
   seconds as the other units (600 / 360), plus 45 s of grace for the process watchdog; sessions record
   `turn_cap: "wall-clock-only"`. At the limit agy ends with status `SUCCESS` and a tool step still open (smoke); the
   adapter counts that, or a result within 2 s of the limit, as capped by the wall clock. (Claude Code: `--max-turns` 30 / 15; Codex: counted by the adapter.)
4. **Permissions and sandbox.** `--dangerously-skip-permissions` (print mode has nobody to ask) and `--sandbox`
   (terminal restrictions). There is no command allowlist like Claude Code's and no exec policy like Codex's, so
   `node`, `curl` or `git commit` are not blocked by a list, and the sandbox can let the agent ask for a bypass that
   skip-permissions approves. The smoke showed that `--sandbox` does **not** stop the file tools: `write_to_file` and
   `view_file` worked outside the workspace. Reads and writes outside the workspace are detected (`out_of_workspace_access`) and
   reported descriptively, as for the other units (original §5); canary hits exclude the run, as for every unit.
5. **Tools.** Web search/fetch and subagents cannot be switched off from the CLI; their use is recorded per session
   (`isolation.web_calls`, `isolation.subagent_calls`), not stopped. An MCP tool call is an isolation breach (as with
   Codex). Agent tool names are mapped to the harness's (`run_command` → Bash, `view_file` → Read, …) so detectors,
   covariates and traces read them the same way.
6. **Trust.** The run's own `settings.json` trusts only the run workspace; Alfredo's `trustedWorkspaces` is untouched.
7. **Prompt delivery.** The prompt is the value of `-p` (agy has no stdin prompt in print mode); the bytes are the
   same ticket or CI-feedback text the other units receive on stdin.
8. **Effort.** The model variant `gemini-3.8-flash-medium` carries the medium thinking level; no `--effort` flag.
9. **Tokens.** `output_tokens` = output + thinking tokens (as Claude's and OpenAI's output counts include thinking);
   the raw split is kept in `sessions[].usage_extra`.
10. **Quota.** Google AI Pro renews every 5 hours, with a weekly cap Google does not publish. A quota error pauses the
    runner (`rate_limited`), never counts as an agent result. `GEMINI_*`, `GOOGLE_*` and `AGY_*` variables are removed
    from agy's environment, so no API key or ADC can be used by accident.
11. **Stream format.** Learned from the smoke (2026-10-16, three tries; raw streams kept): every line is
    `{"event": X, X: {...}}` with `init`, `step_update` (step types `user_input`, `agent_response` with `text_delta`,
    `tool` with `tool_info {name, parameters, output}`, `system_message`) and `result`. The parser was fixed between
    tries, **before** this addendum is frozen, and the adapter file is in the addendum lock.
12. **Paraphrases** were written by Codex (original §9); `agy-flash` is a third-party reader of them.
- *Idea, out of scope:* agy also offers `claude-sonnet-5-5-medium`; running the same model through another tool would
  separate the tool's effect from the model's. Noted in `docs/DECISIONS.md`, not run.

## 5. Sentences that will not be said (added to the original §10)
- Any comparison between units: "Gemini is better (or worse) than Claude", "Codex beat Gemini", rankings.
- "Gemini 3.8 Flash is comparable to Sonnet 5.5 and gpt-5.6-terra" as a result of this experiment.
- p-values on P1 + P7 (or P6 + P7) combined.
- Counts that pool units ("x of 100 agents").
- Anything about the C8 calibration runs as results.

## 6. Freeze record
P8 N per cell: **20** (fixed by Alfredo on 2026-10-16, before C8). Frozen by Alfredo De Regil with
`harness.prereg --freeze-addendum 1`; the UTC time and the hashes are in `PREREGISTRATION-ADDENDUM-1.lock` (a file
cannot hold its own hash).
