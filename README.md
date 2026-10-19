# Agents vs. Gates

Experiment and local console for **"The AI-SDLC Governance Gap"**. The experiment asks
whether a coding agent breaks deployed consumers it cannot see, and whether a spec that carries rules (S), visibility
of consumers (V) or a CI gate stops it. The scenario is 100 % synthetic: Meridian Retail's `orders-service` and three
consumers (`billing-service`, `analytics-ingest`, `web-storefront`).

- **Part I, the experiment:** scenario, CI with the ARCH-1..8 gates, an independent staging oracle, tamper detectors,
  a resumable and blinded batch runner, the RQ4 reviewer, AISDLC-Trace 2.1 traces, analysis.
- **Part II, the console:** a local web console with plugins (Overview, Run Control, Results, Run Explorer, Replay
  Theater, Teams & Avatars, Scenario, Readiness, Users & Audit).

**Try it on your AI-SDLC:** `docs/USING.md` — watch it with the mock agent, plug in your own agent, run the tickets
with your own rules file (`python -m harness.try_rules`, results only in `results/try/`), or copy the checks into your
CI.

Full build spec (Spanish): `docs/construccion-experimento.md`. Seams between packages: `docs/contracts/`.
Build progress: `BUILD-STATUS.md`. Every decision taken without asking: `docs/DECISIONS.md`.
Environment and verified flags: `docs/ENVIRONMENT.md`.

## Requirements
Windows 11, Node 24, Git, Python 3.13 with a `.venv` holding `jsonschema` (nothing else). From this folder:

```
py -3.13 -m venv .venv && .venv\Scripts\python.exe -m pip install jsonschema
npm ci
.venv\Scripts\python.exe -X utf8 -m harness.doctor --setup-workers 3 --ns real
.venv\Scripts\python.exe -X utf8 -m harness.doctor --setup-workers 3 --ns mock
.venv\Scripts\python.exe -X utf8 -m harness.doctor --setup-workers 1 --ns selftest
.venv\Scripts\python.exe -X utf8 -m harness.doctor            # must print DOCTOR OK
```

Run workspaces live in `C:\avg\w<k>\r` (real), `C:\avg\wm<k>` (mock) and `C:\avg\wst` (selftest). Never put a
`CLAUDE.md`, `AGENTS.md` or `.claude\` in `C:\avg\` — it is an ancestor of every run workspace.

## Console
```
.venv\Scripts\python.exe -m console            # http://127.0.0.1:8765 — the first visit creates the owner account
.venv\Scripts\python.exe -m console --check    # headless end-to-end check (prints CHECK OK)
```
The status bar has a REAL / MOCK switch; mock data is hatched and watermarked everywhere and never mixes with real
data (`results/real/`, `results/mock/`).

## Tests (zero model calls)
```
.venv\Scripts\python.exe -X utf8 -m unittest                       # backend + console + replay
.venv\Scripts\python.exe -X utf8 -m harness.selftest --truth-table  # 29 reference patches → TRUTH TABLE 29/29 OK
.venv\Scripts\python.exe -X utf8 -m harness.selftest               # every ticket × V × S with the mock agent
.venv\Scripts\python.exe -X utf8 -m oracle.mutation                # results/mutation-matrix.md (CI vs. oracle)
cd console\plugins\replay\app && npm ci && npm run build && npm test
```

## Running the real experiment (Alfredo only, in this order)
Nothing below has been run. Each step spends quota or freezes something, so each needs a deliberate decision.

1. **Smoke test** (5 live calls, §10.8): `.venv\Scripts\python.exe -X utf8 -m harness.smoke --i-am-authorized`
   (or Readiness → Smoke test). Writes `results/smoke.json`; record the verified flags in `docs/ENVIRONMENT.md`.
2. **Paraphrases:** write `scenario/tasks/<ticket>.p1.md … p5.md` for X-rename, X-remove and X-api by hand, or record
   in `PREREGISTRATION.md` that the base text is used ×10.
3. **Real manifest:** `.venv\Scripts\python.exe -X utf8 -m harness.manifest --ns real` (add `--force` to regenerate
   before the freeze).
4. **Calibration (P0):** `.venv\Scripts\python.exe -X utf8 -m harness.runner --calibrate` — then put the full model id
   and the chosen effort in `harness/units.json` (Readiness → Units).
5. **Review** `docs/REVIEW-CHECKLIST.md`, fill every `[FILL]` in `PREREGISTRATION.md`, then **freeze**:
   `.venv\Scripts\python.exe -X utf8 -m harness.prereg --freeze` (verify any time with `--verify`).
6. **P1 in batches:** `.venv\Scripts\python.exe -X utf8 -m harness.runner --stage P1 --batch 10` (or
   `--max-minutes 60`; `--workers 1..3`), or Run Control → Run batch. Rate limits stop the batch (exit 3); resume with
   the same command or Run Control → Resume at HH:MM.
7. **Status:** `.venv\Scripts\python.exe -X utf8 -m harness.runner --status` (blind: no outcomes for blinded stages).
8. **Unblind and summarize** once P1 is complete: `.venv\Scripts\python.exe -X utf8 -m harness.runner --unblind P1`,
   then `.venv\Scripts\python.exe -X utf8 -m analysis.summarize --ns real` (writes `results/real/summary.md` and `tables/*.csv`).

## Layout
| Folder | What |
|---|---|
| `scenario/` | the four TS repos, the architecture repo (rules, catalog, broker), S0/S1/S2 contexts, tickets, reference patches |
| `ci/` | `python -m ci.run` — typecheck, unit tests, ARCH-1..8; `netstub.mjs` (no network) |
| `oracle/` | staging oracle (`run.py`, suites written with restricted information), `ticket_done`, mutation test |
| `harness/` | workspaces, adapters (Claude Code, Codex, mock), repair loop, detectors D1–D8, runner, reviewer, pre-registration, selftest |
| `analysis/` | summary, statistics (stdlib), PR set, blind coding |
| `trace/` | AISDLC-Trace 2.1 schema, validator, examples |
| `replay/` | trace → `replay.json` exporter for the Replay Theater |
| `console/` | the web console (stdlib HTTP server, ES-module shell, plugins) |
| `docs/` | spec, contracts, decisions, environment, QA screenshots |

License: see `LICENSE.TODO`.
