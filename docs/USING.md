# Using this repo

This repo is an experiment. It asks one question: does a coding agent break other teams it cannot see? And what stops it: rules in the agent's context, or checks in CI?

You can use it in five ways. The first two make no model calls and cost nothing.

1. **Explore the experiment** with its real runs: the results, every run, the Replay Theater.
2. **Learn and demo** with the mock agent: a script, no model.
3. **Try your rules**: one file of yours, the scenario's tickets.
4. **Try your agents**: Claude Code, Codex or Gemini (Antigravity CLI), one or all three, or your own.
5. **Try your repo, your rules and your tickets**: your own service, your CI, your other teams' tests.

Every command runs from the repo folder on Windows 11, in a `.venv` with `requirements.txt`. Uses 2 to 4 also need Node 24 and `npm ci` in the repo folder. Worker folders go to `C:\avg` and results to `results\`. To put them somewhere else, set `AVG_ROOT` and `AVG_RESULTS_ROOT`.

## 1. Explore the experiment (no model calls)

`results\real\` holds every run of the experiment: 1,187 runs with their record, diffs, CI verdicts, the other teams' tests, transcript and trace. Open the console on them:
```
py -3.13 -m venv .venv && .venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m console
```
Go to http://127.0.0.1:8765. The first visit creates the owner account (it stays on your machine). Then:
- **Start here** explains the experiment in five short parts.
- **Results** opens on "Three agents · 100 runs": how often each agent broke another team, per condition. The other tabs answer one research question each.
- **Run Explorer** lists every run. Pick one to see its diff, CI's verdict and the other teams' tests.
- **Replay Theater** plays a run as a scene: the agent, the pull request, CI, the other teams.
- **Scenario** shows the four repos, the architecture rules, the tickets and the consumer contracts.

The numbers in `results\real\summary.md` and `results\real\deck-numbers-ext.md` come from the same runs (`python -m analysis.summarize --ns real` writes them again). What was decided before the first run is in `PREREGISTRATION.md` and its three addenda; `python -m harness.prereg --verify` checks that the frozen files did not change.

## 2. Learn and demo with the mock agent (no model calls)

The mock agent is a script. It applies prepared patches. It never calls a model.

Set up the self-test's worker folder (once):
```
.venv\Scripts\python.exe -X utf8 -m harness.doctor --setup-workers 1 --ns selftest
```
Run a short self-test (five runs, about two minutes):
```
.venv\Scripts\python.exe -X utf8 -m harness.selftest --quick
```
Run the full self-test. It takes longer. It also writes four demo runs for the Replay Theater, `st-demo-1` to `st-demo-4`:
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
Go to http://127.0.0.1:8765. The first visit creates the owner account. Switch the status bar to MOCK. Open **Replay Theater** and pick `st-demo-1`: the agent breaks a consumer, CI goes red, the agent repairs. Mock data is hatched and labelled everywhere. It never mixes with real data.

The self-test writes to `results\mock\` and `C:\avg\wst`.

## 3. Try your rules

Give the agent your rules file instead of the experiment's text. Any single text file works: a spec-kit constitution (`.specify\memory\constitution.md`), Kiro steering files (join them into one file), a `CLAUDE.md`, an `AGENTS.md`.

Set up the try worker folder (once):
```
.venv\Scripts\python.exe -X utf8 -m harness.doctor --setup-workers 1 --ns try
```
See the flow first, with the mock agent (no model calls):
```
.venv\Scripts\python.exe -X utf8 -m harness.try_rules --context path\to\my-rules.md --unit mock
```
The mock is a script. It does not read your file. It shows the flow and what the verdict looks like. By default it plays the experiment's "no rules" script; `--mock-as S2` plays the "with rules" one.

Then run a real agent. It starts real sessions and uses your quota, so it needs `--live`:
```
.venv\Scripts\python.exe -X utf8 -m harness.try_rules --context path\to\my-rules.md --unit cc-sonnet --live --n 3
```
Units: `cc-sonnet` and `cc-opus` (Claude Code), `codex` (Codex CLI), `agy-flash` (Gemini 3.8 Flash through the Antigravity CLI), or your own. Section 4 says how to sign each one in.

What happens:
1. Your file goes into the workspace as the agent's context file (`CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, the name the agent reads). It takes the place of the experiment's text. Only that one file goes in. (In `V2`, one line on top tells the agent which folder is its own, as in the experiment.)
2. Each ticket runs `--n` times (default 3). The default tickets are `X-rename` and `X-remove`. Both change the `OrderPlaced` event, which two other teams read.
3. The agent sees `orders-service` only. It does not see the other teams' code (`--visibility V0`; `V1` adds their contracts, `V2` their repos).
4. CI runs the architecture checks. If CI fails, the agent gets the output and up to 3 tries to fix it.
5. The other teams' tests run on a copy of the result, outside the workspace: once on the first try, once on the final state.

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
- The other teams' tests decide if a change broke them. Not the agent: its last message may say all is well. Not CI: CI only knows the rules someone wrote into it.
- "Broke another team on the first try" shows how much your rules help, before any feedback.
- "CI caught it" and "CI missed it" show how much the gate helps.
- "At the end" shows what would ship.
- For `X-remove`, "kept as deprecated" is the safe answer: the field stays until its readers move.
- 3 runs say little. Agents vary from run to run. Treat a small run as a smoke test, not a result.

Where it writes: only `results\try\` (`manifest.json`, `state.json`, `runs\<run_id>\`, `verdicts\<try_id>.json`, and `contexts\` with a copy of your file) and the worker folders `C:\avg\wt<k>`. It never reads or writes the experiment's results (`results\real\`, `results\mock\`) or its worker folders. It needs no pre-registration lock. If a path would overlap the experiment's (for example through a junction), it refuses to start. Do not put a `CLAUDE.md`, `AGENTS.md` or `GEMINI.md` in `C:\avg` or above it: the agent would read that file too.

Options: `--tickets X-rename,X-remove` (any ticket in `scenario\tasks\`), `--n 3`, `--visibility V0|V1|V2`, `--workers 1..3` (set up that many folders with `--setup-workers N --ns try`), `--units-file`, `--mock-as S0|S1|S2`, `--quiet`.

## 4. Try your agents

The experiment ran three agents through their own command-line tools, headless, on your own subscriptions. A try does the same. Sign each one in once, then run section 3 with `--unit` and `--live`:

| Agent | `--unit` | Sign in once | Its rules file |
|---|---|---|---|
| Claude Code + Sonnet 5.5 (or Opus 5.5) | `cc-sonnet` (`cc-opus`) | `claude setup-token`, then put `CLAUDE_CODE_OAUTH_TOKEN=...` in `C:\avg\.env` | `CLAUDE.md` |
| Codex CLI | `codex` | `codex login` (the try copies only `~\.codex\auth.json`) | `AGENTS.md` |
| Gemini 3.8 Flash, Antigravity CLI | `agy-flash` | sign in to `agy` with your Google account (the try copies only the sign-in files from `~\.gemini`) | `GEMINI.md` |

```
.venv\Scripts\python.exe -X utf8 -m harness.try_rules --context path\to\my-rules.md --unit agy-flash --live --n 3
```
Run one agent at a time, or one after the other: each try is one command. Each agent starts with an empty home folder of its own, so it does not load your settings, memory, plugins or MCP servers. With `agy-flash`:
- Do not use `agy` yourself while a try runs. The try watches the real `~\.gemini` for writes, and a write there stops the try as an isolation breach (exit code 4).
- Its file tools can read outside its workspace, even with `--sandbox`. In the experiment it sometimes walked up into this repo and read the reference fixes (`scenario\solutions\`) and the other teams' tests (`oracle\`); see addendum 1 §4.4. A try records such reads but does not block them, and a run that read a reference fix is not a clean test.

### Your own agent

An adapter runs one agent session, headless, and reports what happened. The harness does the rest: the workspace, CI, the repair loop, the other teams' tests and the records.

Write `harness\adapters\<name>.py` with one function (the contract is in `harness\adapters\base.py`):
```python
def run_session(ws, prompt, *, resume=None, unit, limits, on_event=None) -> SessionResult
```

What you get:
- `ws.root`: the workspace. Start your agent with this folder as its working directory. The rules file is already there, named `ws.context_file`.
- `ws.cfg`: an empty folder for your CLI's config or home. Use it, so the agent does not load your own settings, plugins or MCP servers.
- `prompt`: the ticket text in the first session (`limits.session == "gen"`). In a repair session (`fix1` to `fix3`) it is the CI failure message.
- `resume`: in a repair session, the `session_id` you returned before. Continue that conversation.
- `unit`: your unit entry, plus its `"name"`.
- `limits`: `max_turns` and `wall_clock_s` (30 turns and 600 s first; 15 turns and 360 s for each repair).

What you must do:
- Let the agent edit files in `ws.root`. Do not commit: the harness commits after each session.
- Run without questions to a person.
- For each step of the agent, build an event with `base.event(session, kind, ...)`, call `on_event(ev)`, and keep it in `result.events`. Kinds: `text` (`text`), `tool_call` (`id`, `name`, `input`), `tool_result` (`id`, `status`: `success`, `error` or `denied`, `output`) and one `final` (`text`, `subtype`, `is_error`, `num_turns`, `duration_ms`, `usage`, `cost_usd`).
- Return a `SessionResult` with `session`, `session_id`, `events`, `num_turns`, `duration_ms`, `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), `cost_usd`, `final_text` (the agent's last message), `model_reported`, `cli_version`, `started_at` and `ended_at`.
- If the agent hit its turn or time limit, set `capped=True` and `turn_cap` (`"max-turns"` or `"wall-clock-only"`). That is a result of the agent, not an error.
- If the session could not happen for a reason that is not the agent's (rate limit, API error, crash, no sandbox), set `infra={"kind": ..., "detail": ..., "reset_at": ...}` with a kind from `base.INFRA_KINDS`. `rate_limited` and `isolation_breach` (the CLI loaded tools or servers it should not have) stop the batch.

Two examples:
- `harness\adapters\mock.py` is the smallest. No model. It shows the events and the result.
- `harness\adapters\claude_code.py` drives a real CLI: stream JSON, an isolated config folder, limits, error kinds.

Add your agent to a units file of your own. Do not edit `harness\units.json` or `harness\units-ext.json`: they are frozen with the experiment.
```json
{ "my-agent": { "adapter": "my_agent", "model": "my-model-1", "context_file": "AGENTS.md" } }
```
`context_file` is the file your agent reads its rules from. Then run it as in section 3, with the experiment's own rules text as a first check:
```
.venv\Scripts\python.exe -X utf8 -m harness.doctor --setup-workers 1 --ns try
.venv\Scripts\python.exe -X utf8 -m harness.try_rules --units-file my-units.json --unit my-agent --live --context scenario\context\orders-service\S2.md --tickets X-rename --n 1
```

## 5. Try your repo, your rules and your tickets

The same cycle as section 3, on your code instead of the scenario. You bring four things:

1. **Your repo**: a folder (a git checkout works). The agent works on a clean copy of it: no `.git`, no history, no remotes, nothing else in its workspace.
2. **Your rules**: one file, as in section 3. It goes into the copy as the file the agent reads (`CLAUDE.md`, `AGENTS.md` or `GEMINI.md`).
3. **Your tickets**: plain-text files, one ticket each (`--tickets a.md,b.md`). The file name, without its extension, is the ticket's id.
4. **Your gates**:
   - **CI**: one command (`--ci`), run in the agent's copy. Exit 0 passes; anything else fails, and its output goes back to the agent, which gets up to 3 repairs. Without `--ci` nothing gates the pull request.
   - **The other teams**: tests you bring (`--their-tests <folder>`, one subfolder per team, and `--their-cmd`). The agent never sees them. They run outside its workspace, on a copy of the result, once on the first try and once at the end. `SERVICE_DIR` points at that copy.
   - Optional: `--accept-cmd` says whether the ticket is done (exit 0). It runs from the folder you start the try in, with `SERVICE_DIR` and `TICKET` set. Without it, the ticket is "not evaluated".
   - Optional: `--setup-cmd` runs once in every fresh copy before the agent starts (for example `npm ci`).

Try it first with the example and the mock agent. No model calls, about a minute, Node 24 on `PATH`:

```
.venv\Scripts\python.exe -X utf8 -m harness.try_rules --unit mock ^
  --repo examples\try-own-repo\my-service ^
  --context examples\try-own-repo\my-rules.md ^
  --tickets examples\try-own-repo\tickets\rename-total.md,examples\try-own-repo\tickets\add-currency.md ^
  --ci "npm run ci" ^
  --their-tests examples\try-own-repo\other-teams --their-cmd "node --test" ^
  --accept-cmd "node examples\try-own-repo\accept.mjs" ^
  --mock-script examples\try-own-repo\mock\mock.json --n 1
```

The mock agent does not read your rules. It applies the patches in `--mock-script`. In the example it renames a field that the invoicing team reads: your CI fails, the invoicing team's test breaks, and the repair keeps the old name next to the new one.

Then your own, with a real agent (real sessions, real quota):

```
.venv\Scripts\python.exe -X utf8 -m harness.try_rules --unit cc-sonnet --live --n 3 ^
  --repo C:\code\my-service --context C:\code\my-rules.md ^
  --tickets C:\code\tickets\first.md,C:\code\tickets\second.md ^
  --ci "npm test" --their-tests C:\code\other-teams --their-cmd "npm test"
```

The verdict is printed as in section 3: how often the first try broke another team, how often your CI caught it, what is left at the end, and whether the ticket is done.

What it does not do. Read this before you use the numbers:
- **Your CI and your other teams' tests are yours.** The experiment's ARCH-1…8, its contract checks and its consumer repos do not apply to your repo. If your CI does not check what the other teams read, nothing catches a break before their tests run.
- **It is not comparable with the experiment.** Different code, different gates, different tickets. Use it to see how your agent, your rules and your gates behave on your code, not to compare with the talk's numbers.
- **One repo in the agent's workspace.** No monorepo or several-repo setups (the experiment's V1 and V2). The other teams exist only as your tests.
- **It does not install anything for you.** Leave the repo ready to run your commands, or give `--setup-cmd`.
- **No git URLs.** Clone first and pass the folder. Nothing goes to the network from the harness; the agent runs with the same isolation as in section 4.
- **Folders it refuses**: your repo or your other teams' tests inside the experiment's `scenario\`, `oracle\`, `ci\`, `harness\` or `results\`, and other teams' tests inside your repo (the agent would see them).

Where it writes: as in section 3, only `results\try\` and the worker folders `C:\avg\wt<k>`.
