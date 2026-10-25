# WP0 contracts — the interfaces every package builds against

Section numbers below ("§n") refer to the author's build spec, which is not published; this file and the schemas are the public contract. This file fixes the **seams between packages** so they can be built in parallel. If you need to change a contract, don't: write the proposal in `docs/DECISIONS.md` and work around it; the integrator decides.

Conventions for all Python: stdlib only (+ `jsonschema` from `.venv`), run as `.venv\Scripts\python.exe -X utf8 -m <module>` from the repo root, open files with `encoding="utf-8"`, write with `newline="\n"`, `subprocess.run([...])` with a list and **never** `shell=True`, `shutil.which("npm")` for npm. Shared helpers already written (use them, don't fork them):

| Module | What |
|---|---|
| `harness/paths.py` | Every path: `REPO`, `REPOS`, `SOLUTIONS`, `results_root()`, `ns_dir(ns)`, `run_dir(ns,id)`, `state_path(ns)`, `manifest_path(ns)`, `runner_log_path(ns)`, `control_path(ns)`, `worker_dir(ns,k)`, `workspace_dir(ns,k)`, `cfg_dir(ns,k)`, `tool("tsc"|"depcruise")` (argv to run pinned Node tools from the repo `node_modules`), `git_env()` + `GIT_INLINE` (git without global/system config) |
| `harness/jsonio.py` | `read_json`, `write_json_atomic`, `read_jsonl`, `append_jsonl`, `write_jsonl` |
| `harness/blinding.py` | `is_visible(state, stage)`, `stage_complete(manifest, state, stage)`, `unblind(...)`, `redact_record(record, state)` |
| `harness/canaries.json` | Canary registry `{origin: "CANARY-<16 hex>"}` (§10.3) |
| `harness/units.json` | Units (§10.1) |
| `harness/empty.gitconfig` | Empty file for `GIT_CONFIG_GLOBAL` |

## 1. Filesystem layout

```
C:\avg\agents-vs-gates\          REPO (node_modules at the root: typescript 6.0.3, dependency-cruiser 18.5.0, @types/node 24.13.2)
C:\avg\w<k>\   (real, k=1..3)    worker: package.json + package-lock.json + node_modules + r\ (the run's workspace)
C:\avg\wm<k>\  (mock, k=1..3)    same, for mock runs (so a mock batch never touches a real worker)
C:\avg\wst\                      same, for harness.selftest / truth table
C:\avg\cfg\w<k>\ cfg\wm<k>\      isolated CLAUDE_CONFIG_DIR / CODEX_HOME per worker (wiped per run)
results\<ns>\                     ns = real | mock   (§21.6: never mixed)
  manifest.json  state.json  runner.log.jsonl  control.json
  runs\<run_id>\  record.json events.jsonl transcript.jsonl diffs\gen.diff diffs\fix<n>.diff workspace.bundle replay.json
  reviews\        RQ4 reviewer outputs
  summary.md  tables\*.csv  coding\  poll-pr\
results\mutation-matrix.md       (deterministic, not namespaced)
```
- `AVG_ROOT` and `AVG_RESULTS_ROOT` env vars override the two roots (tests and `console --check` use temp dirs).
- Namespace is derived from the unit: adapter `mock` → `mock`, anything else → `real`.
- Selftest runs are archived in `results/mock/runs/st-*` with `stage: "selftest"` (always visible, never blinded), so the Replay Theater has mock traces from the first morning (§22.5.2).

## 2. Scenario (WP1 writes; everyone reads)
- `scenario/repos/{orders-service,billing-service,analytics-ingest,web-storefront,architecture}/` (§5).
- `scenario/context/orders-service/{S0,S1,S2}.md` (§5.7; exact texts).
- `scenario/tasks/<ticket>.md` (W1 text), `X-rename.W2.md`, `<ticket>.p1.md … p5.md` (`TODO(human)` placeholders).
- `scenario/solutions/<ticket>/<name>.patch` and `scenario/solutions/generic/<name>.patch` (rows 17–28). `scenario/solutions/index.json`: `{ "<ticket-or-generic>/<name>": { "file": "...", "root": "service"|"workspace", "visibility": ["V0", ...], "final_message": "..." } }`. `root: service` = paths relative to the orders-service root (apply in V2 with `git apply --directory=orders-service`); `root: workspace` = relative to the V2 workspace root. Every patch starts with a header line `# CANARY-…` (solutions canary) before the first `diff --git` (git ignores it).
- `docs/contracts/truth-table.json` = machine form of §6.3 (written in WP0; don't edit rows).
- Canaries: consumer repos carry their canary in a first-line comment of every `.ts`/`.md` file (`// CANARY-…` / `<!-- CANARY-… -->`); broker JSONs carry `"_canary": "CANARY-…"`; architecture YAML/MD a comment. `orders-service` has **no** canary. When a workspace legitimately receives a copy (V1 contracts, V2 consumers), `harness/workspace.py` strips any line containing `CANARY-` and any `_canary` key.

## 3. CI (WP1) — `ci/`
- CLI: `python -m ci.run <workspace> [--visibility V0|V1|V2] [--run-id ID] [--out verdict.json]` → prints the §7.4 verdict JSON (`docs/contracts/ci-verdict.schema.json`). Visibility is auto-detected if omitted (V2 if `<ws>/orders-service/package.json` exists; V1 if `<service>/contracts/consumers/` exists; else V0).
- Python: `from ci.run import run_ci; run_ci(workspace: Path, visibility: str, run_id: str = "adhoc") -> dict`.
- Check IDs, in this order, all always run: `typecheck`(build) `unit-tests`(test) `ARCH-1` `ARCH-2` `ARCH-3`(gate) `ARCH-4`(contract) `ARCH-5` `ARCH-6` `ARCH-7`(gate) `ARCH-8`(contract). `rule` = the ARCH id or null.
- Service dir = `<ws>/orders-service` in V2, else `<ws>`. Node tools via `harness.paths.tool()`. Service loaded with `node --import <REPO>/ci/netstub.mjs`. Broker/catalog materialized to `%TEMP%\avg-ci-<runid>` and deleted.
- `ci/netstub.mjs` (§7.1): stock availability configurable with env `NETSTUB_STOCK_AVAILABLE` (default 1000) and at runtime via `globalThis.__netstub.setStockAvailable(n)`.
- `feedback_text` = failed checks' output in §7.2 order, truncated to 6000 chars. Feedback message to the agent (§7.5) is built by the harness: `ci.run.feedback_message(verdict) -> str`.

## 4. Oracle and ticket_done (WP1 + separate oracle-suite author) — `oracle/`
- `python -m oracle.run <service_dir> [--out f]` / `from oracle.run import run_oracle; run_oracle(service_dir) -> dict` → §8.3 (`docs/contracts/oracle-verdict.schema.json`); consumers keyed `billing-service`, `analytics-ingest`, `web-storefront`, each `{ok, status: pass|fail|error, message}`. `service_dir` is any directory holding an orders-service source tree (e.g. a `git archive gen` extraction outside the workspace); the oracle compiles it itself (must work even with no `node_modules` above it) and always uses the **canonical** consumers.
- Suites: `oracle/suites/{billing,analytics,storefront}.test.mjs` (written by a separate subagent with restricted information, §8.2). Each carries its canary in a comment.
- `python -m oracle.acceptance <service_dir> --ticket X-rename` / `from oracle.acceptance import check_ticket; check_ticket(service_dir, ticket) -> dict` → `{"ticket", "ticket_done": "done"|"not_done"|"deprecated", "captured": {"order_placed": {...}|null, "get_order": {...}|null}, "arch9_signal": bool, "arch9_fields": [..], "detail": "..."}`. ticket_done fixture: 1 line, 2 × $6.25 USD, channel `web` (so "12.5 for the fixture" in §6.4 is literal); arch9 is evaluated on the same captures (§14.5).
- `python -m oracle.mutation` → `results/mutation-matrix.md` (+ `.json`).

## 5. Harness (WP2) — `harness/`, `analysis/`, `trace/validate.py`, `tests/`
- `harness/detectors.py`: `detect(repo: Path, base: str, head: str, service_prefix: str = "") -> list[{detector, path, summary}]`; `out_of_scope_edits(repo, base, head) -> list[str]` (V2).
- `harness/workspace.py`: `materialize(ns, worker, unit, ticket, V, S) -> Workspace` (§10.2), commits `base`.
- Adapters: `harness/adapters/<name>.py` expose `run_session(ws, prompt, *, resume=None, unit, limits, on_event) -> SessionResult` and normalize to **AgentEvent** (one JSON per line in `transcript.jsonl`): `{"ts": iso, "session": "gen"|"fix1"…, "kind": "text"|"tool_call"|"tool_result"|"final", ...}` with `text: {"text"}`, `tool_call: {"id","name","input"}`, `tool_result: {"id","status": success|error|denied,"output"}`, `final: {"text","subtype","is_error","num_turns","duration_ms","usage","cost_usd"}`.
- Mock: `harness/mock_scripts.json` keyed `"<ticket>|<V>|<S>"` (plus `"default"`) → `{"gen": "<solution key>", "repairs": ["<solution key>", ...], "final_message": "...", "infra": null|"rate_limited"|"timeout"|"crash"}`.
- Records: `docs/contracts/record.schema.json` (example: `examples/record.json`). State: `docs/contracts/state.schema.json` (example: `examples/state.json`). Manifest: `manifest.schema.json`.
- Trace: `harness/trace.py` emits AISDLC-Trace 2.1 (`trace/schema/simulation-log-event-2.1.0.json`, written in WP0) exactly in the shape of `examples/trace-m1-xrename-v0s0.jsonl`: actors `flow-engine`, `code-orders`, `ci`, `staging`, `architect`; `SESSION_STARTED.metadata` = `{run_id, stage, source: real|mock, unit, model, adapter, ticket, condition: {V,S,W}, cli_session_id, context_file}`; `SESSION_ENDED.payload.stats` = `{run_outcome, ticket_done, turns, repair_attempts, detectors, ci_attempts}`. `trace/validate.py` = schema + rules 1–13 (§13.4).
- Runner CLI (§11.4) plus: `--workers 1..3`, `--ns real|mock` (for `--status`/`--unblind` without `--unit`), `--json` on `--status`. The runner writes `state.json` atomically (≤ 1 s staleness while running), appends to `runner.log.jsonl` (`{"ts","event": "batch_started"|"run_started"|"run_finished"|"progress"|"stopped"|"rate_limited"|"error", ...}`; `run_finished` carries `run_id, turns, duration_ms, tokens` and **never** the outcome), and polls `control.json` (`{"stop_after_current": true, "by": "...", "at": "..."}`) between runs; it deletes it on exit. It stores its PID in `state.runner.pid` and calls `SetThreadExecutionState` while running.
- Exit codes: 0 ok, 2 usage/guard refusal (e.g. lock missing), 3 rate-limited, 4 isolation breach.

## 6. Replay (WP5) — `replay/`
- `python -m replay.export <trace.jsonl> --out <dir>` → `<dir>/replay.json` (`docs/contracts/replay.schema.json`).
- `from replay.export import build_replay; build_replay(events: list[dict]) -> dict` (pure, trace-only, §22.5.1).
- Mock source ⇒ `meta.legend = "SIMULATED (mock agent) — not a real run"`; real ⇒ `"Replay of a real run"`.

## 7. Console (WP3 core; WP4/5/6 plugins) — `console/`
See `docs/contracts/console-api.md`.

## 8. Commit and ownership rules for subagents
- Write only inside your owned folders (listed in your brief). Need something elsewhere? Put a note in your final report; the integrator does it.
- **Do not run `git commit`** — the integrator commits each package. Don't run `git` in the repo root except read-only commands.
- Never call a model (`claude -p`, `codex exec`). Never touch folders outside the repo and the worker folders, except reading the inputs.
- Log every unspecified decision as a bullet in your final report under "DECISIONS" (date, decision, discarded alternative, why); the integrator appends them to `docs/DECISIONS.md`.
