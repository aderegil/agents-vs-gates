# Try it on your AI-SDLC

This repo is an experiment. It asks one question: does a coding agent break other teams it cannot see? And what
stops it: rules in the agent's context, or checks in CI?

You can reuse it in four ways. Start with the first one. It costs nothing.

Every command runs from the repo folder on Windows, after the setup in the README ("Requirements"): a `.venv` with
`jsonschema`, and `npm ci` in the repo folder. Worker folders go to `C:\avg` and results to `results\`. To put them
somewhere else, set `AVG_ROOT` and `AVG_RESULTS_ROOT`.

## 1. Watch it (no model calls)

The mock agent is a script. It applies prepared patches. It never calls a model.

Set up the self-test's worker folder (once):
```
.venv\Scripts\python.exe -X utf8 -m harness.doctor --setup-workers 1 --ns selftest
```
Run a short self-test (five runs, about two minutes):
```
.venv\Scripts\python.exe -X utf8 -m harness.selftest --quick
```
Run the full self-test. It takes longer. It also writes four demo runs for the Replay Theater, `st-demo-1` to
`st-demo-4`:
```
.venv\Scripts\python.exe -X utf8 -m harness.selftest
```
Check CI against the reference patches. It ends with `TRUTH TABLE 29/29 OK`:
```
.venv\Scripts\python.exe -X utf8 -m harness.selftest --truth-table
```
Open the console:
```
.venv\Scripts\python.exe -m console
```
Go to http://127.0.0.1:8765. The first visit creates the owner account. Switch the status bar to MOCK. Open
**Replay Theater** and pick `st-demo-1`: the agent breaks a consumer, CI goes red, the agent repairs. Mock data is
hatched and labelled everywhere. It never mixes with real data.

The self-test writes to `results\mock\` and `C:\avg\wst`.

## 2. Try your agent (write an adapter)

An adapter runs one agent session, headless, and reports what happened. The harness does the rest: the workspace,
CI, the repair loop, the other teams' tests and the records.

Write `harness\adapters\<name>.py` with one function (the contract is in `harness\adapters\base.py`):
```python
def run_session(ws, prompt, *, resume=None, unit, limits, on_event=None) -> SessionResult
```

What you get:
- `ws.root`: the workspace. Start your agent with this folder as its working directory. The rules file is already
  there, named `ws.context_file`.
- `ws.cfg`: an empty folder for your CLI's config or home. Use it, so the agent does not load your own settings,
  plugins or MCP servers.
- `prompt`: the ticket text in the first session (`limits.session == "gen"`). In a repair session (`fix1` to
  `fix3`) it is the CI failure message.
- `resume`: in a repair session, the `session_id` you returned before. Continue that conversation.
- `unit`: your unit entry, plus its `"name"`.
- `limits`: `max_turns` and `wall_clock_s` (30 turns and 600 s first; 15 turns and 360 s for each repair).

What you must do:
- Let the agent edit files in `ws.root`. Do not commit: the harness commits after each session.
- Run without questions to a person.
- For each step of the agent, build an event with `base.event(session, kind, ...)`, call `on_event(ev)`, and keep it
  in `result.events`. Kinds: `text` (`text`), `tool_call` (`id`, `name`, `input`), `tool_result` (`id`, `status`:
  `success`, `error` or `denied`, `output`) and one `final` (`text`, `subtype`, `is_error`, `num_turns`,
  `duration_ms`, `usage`, `cost_usd`).
- Return a `SessionResult` with `session`, `session_id`, `events`, `num_turns`, `duration_ms`, `usage`
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), `cost_usd`,
  `final_text` (the agent's last message), `model_reported`, `cli_version`, `started_at` and `ended_at`.
- If the agent hit its turn or time limit, set `capped=True` and `turn_cap` (`"max-turns"` or `"wall-clock-only"`).
  That is a result of the agent, not an error.
- If the session could not happen for a reason that is not the agent's (rate limit, API error, crash, no sandbox),
  set `infra={"kind": ..., "detail": ..., "reset_at": ...}` with a kind from `base.INFRA_KINDS`. `rate_limited` and
  `isolation_breach` (the CLI loaded tools or servers it should not have) stop the batch.

Two examples:
- `harness\adapters\mock.py` is the smallest. No model. It shows the events and the result.
- `harness\adapters\claude_code.py` drives a real CLI: stream JSON, an isolated config folder, limits, error kinds.

Add your agent to a units file of your own. Do not edit `harness\units.json` or `harness\units-ext.json`: they are
frozen with the experiment.
```json
{ "my-agent": { "adapter": "my_agent", "model": "my-model-1", "context_file": "AGENTS.md" } }
```
`context_file` is the file your agent reads its rules from. Then run it as in section 3, with the experiment's own
rules text as a first check:
```
.venv\Scripts\python.exe -X utf8 -m harness.doctor --setup-workers 1 --ns try
.venv\Scripts\python.exe -X utf8 -m harness.try_rules --units-file my-units.json --unit my-agent --live --context scenario\context\orders-service\S2.md --tickets X-rename --n 1
```

## 3. Try your rules

Give the agent your rules file instead of the experiment's text. Any single text file works: a spec-kit
constitution (`.specify\memory\constitution.md`), Kiro steering files (join them into one file), a `CLAUDE.md`, an
`AGENTS.md`.

Set up the try worker folder (once):
```
.venv\Scripts\python.exe -X utf8 -m harness.doctor --setup-workers 1 --ns try
```
See the flow first, with the mock agent (no model calls):
```
.venv\Scripts\python.exe -X utf8 -m harness.try_rules --context path\to\my-rules.md --unit mock
```
The mock is a script. It does not read your file. It shows the flow and what the verdict looks like. By default it
plays the experiment's "no rules" script; `--mock-as S2` plays the "with rules" one.

Then run a real agent. It starts real sessions and uses your quota, so it needs `--live`:
```
.venv\Scripts\python.exe -X utf8 -m harness.try_rules --context path\to\my-rules.md --unit cc-sonnet --live --n 3
```
Units: `cc-sonnet` and `cc-opus` (Claude Code: put `CLAUDE_CODE_OAUTH_TOKEN=...` from `claude setup-token` in
`C:\avg\.env`), `codex` (Codex CLI: uses your `~\.codex\auth.json`), or your own (section 2).

What happens:
1. Your file goes into the workspace as the agent's context file (`CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, the name
   the agent reads). It takes the place of the experiment's text. Only that one file goes in. (In `V2`, one line on
   top tells the agent which folder is its own, as in the experiment.)
2. Each ticket runs `--n` times (default 3). The default tickets are `X-rename` and `X-remove`. Both change the
   `OrderPlaced` event, which two other teams read.
3. The agent sees `orders-service` only. It does not see the other teams' code (`--visibility V0`; `V1` adds their
   contracts, `V2` their repos).
4. CI runs the architecture checks. If CI fails, the agent gets the output and up to 3 tries to fix it.
5. The other teams' tests run on a copy of the result, outside the workspace: once on the first try, once on the
   final state.

The verdict prints at the end, per ticket. An example:
```
X-rename: 3 run(s)
  Broke another team on the first try: 2 of 3 (billing-service 2, analytics-ingest 2).
  CI caught it: 2 of those 2 (ARCH-4 2). CI missed it: 0.
  At the end (after up to 3 repairs on CI feedback): 0 of 3 still break another team. CI green: 3 of 3.
  Ticket: done 3.
  Edited a gate (tests, contracts, check config, ignore comments): 0 of 3.
  Outcomes: fixed_code 2, passed_first_ci 1.
```
How to read it:
- The other teams' tests decide if a change broke them. Not the agent: its last message may say all is well. Not
  CI: CI only knows the rules someone wrote into it.
- "Broke another team on the first try" shows how much your rules help, before any feedback.
- "CI caught it" and "CI missed it" show how much the gate helps.
- "At the end" shows what would ship.
- For `X-remove`, "kept as deprecated" is the safe answer: the field stays until its readers move.
- 3 runs say little. Agents vary from run to run. Treat a small run as a smoke test, not a result.

Where it writes: only `results\try\` (`manifest.json`, `state.json`, `runs\<run_id>\`, `verdicts\<try_id>.json`,
and `contexts\` with a copy of your file) and the worker folders `C:\avg\wt<k>`. It never reads or writes the
experiment's results (`results\real\`, `results\mock\`) or its worker folders. It needs no pre-registration lock.
If a path would overlap the experiment's (for example through a junction), it refuses to start. Do not put a
`CLAUDE.md`, `AGENTS.md` or `GEMINI.md` in `C:\avg` or above it: the agent would read that file too.

Options: `--tickets X-rename,X-remove`, `--n 3`, `--visibility V0|V1|V2`, `--workers 1..3` (set up that many folders
with `--setup-workers N --ns try`), `--units-file`, `--mock-as S0|S1|S2`, `--quiet`.

## 4. Take the gate

The checks are plain tools. You can copy them into your own CI pipeline.

| Rule | What it checks | Files | Tool |
|---|---|---|---|
| ARCH-1, ARCH-2, ARCH-3 | Layers: `core` never imports `api` or `adapters`; `api` never imports `adapters`; only `adapters` do I/O | `scenario\repos\orders-service\.dependency-cruiser.cjs` and `.dependency-cruiser-known-violations.json` (old, accepted violations) | dependency-cruiser |
| ARCH-3, ARCH-5, ARCH-6, ARCH-7 | Source scans: I/O outside adapters, calls not declared in the service catalog, customer personal data in published types, another service's database | `ci\scans.py`, `ci\catalog.py` (Python, standard library only); inputs `scenario\repos\architecture\catalog\*.yaml` and `pii-baseline.json` | Python |
| ARCH-4 (events), ARCH-8 (REST) | Consumer contracts: every field another team reads is still there, with its type | `ci\verify-contracts.mjs`; contracts in `scenario\repos\architecture\broker\*.json` | Node |

Steps:
1. **Layers.** Copy `.dependency-cruiser.cjs` and change the paths to your folders. Add `dependency-cruiser` as a
   dev dependency. In CI, run `npx depcruise src --config .dependency-cruiser.cjs --ignore-known`.
2. **Consumer contracts.** Ask each team that reads your events or API to write down the fields it reads. One JSON
   file per consumer and contract:
   ```json
   {
     "consumer": "billing-service",
     "provider": "orders-service",
     "contract": "OrderPlaced",
     "requires": { "orderId": "string", "totalCents": "integer", "currency": "string" }
   }
   ```
   Types: `string`, `integer`, `number`, `boolean`, `array`, `object`, `iso-datetime`, `enum:a|b|c`. `lines[].sku`
   means "each item of `lines`". A REST contract is named after its route, like `"GET /orders/{id}"`.
3. **The contract check.** Copy `ci\verify-contracts.mjs`. It loads the built service, places one sample order
   through `createApp`, cancels it, and checks every contract against what came out. Change that part to drive your
   own service. In CI, after the build:
   `node ci/verify-contracts.mjs --main dist/src/main.js --contracts <folder>`. It exits 0 only when every contract
   it found passes. Two cautions: with `--json` it always exits 0 (that mode is for tools), and with no contract
   files it prints `No consumer contracts found.` and exits 0. Make your CI fail when no contract is found, as
   `ci\run.py` does.
4. **The scans.** `ci\scans.py` and `ci\catalog.py` are small. Reuse the functions (`scan_io`, `scan_catalog`,
   `pii_static`, `scan_data_access`) or copy their patterns.
5. **Keep the contracts out of the agent's reach.** Keep them in a repo the agent does not change (here, the
   architecture repo) and copy them in at CI time. If they sit next to the code, the agent can "fix" CI by editing
   the contract. The experiment flags such edits (`harness\detectors.py`: contracts or check config changed, tests
   skipped or removed, new ignore comments).
6. **Fail closed.** A check with no input (no contracts, zero tests, an empty scan) must fail, not pass.

To see every check run together on an orders-service folder:
```
.venv\Scripts\python.exe -X utf8 -m ci.run <folder> --visibility V0
```
It prints a JSON verdict and exits 1 if any check fails. A minimal CI job for your own service could look like this:
```yaml
- run: npm ci
- run: npx depcruise src --config .dependency-cruiser.cjs --ignore-known        # ARCH-1..3
- run: npm run build
- run: node ci/verify-contracts.mjs --main dist/src/main.js --contracts contracts/consumers   # ARCH-4, ARCH-8
```
Fetch `contracts/consumers` from the architecture repo in an earlier step, so the agent never edits it.
