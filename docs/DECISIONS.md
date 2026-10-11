# Decisions taken without asking (§0.2)

Format: date · decision · discarded alternative · why. Proposals for Alfredo are marked **PROPOSAL**.

## WP0 · Contracts and base (2026-10-10, night)

- 2026-10-10 · Results are namespaced `results/<ns>/{manifest.json,state.json,runs/<id>/…}` with `ns ∈ {real, mock}`
  · flat `results/runs/<id>` of §10.7 · §21.6 requires real and mock never to mix; the namespace is derived from the
  unit (adapter `mock` → `mock`).
- 2026-10-10 · Mock batches use their own workers `C:\avg\wm1..wm3`, the selftest uses `C:\avg\wst` · sharing
  `w1..w3` · a mock batch launched from the console must never disturb a real run's worker.
- 2026-10-10 · Selftest runs are archived in `results/mock/runs/st-*` with `stage: "selftest"`, always unblinded · a
  separate namespace · gives the Replay Theater and Run Explorer mock material from the first morning (§22.5.2).
- 2026-10-10 · CI, oracle and ticket_done run `tsc` and `depcruise` from the repo's `node_modules` via
  `node <entry>` (`harness.paths.tool`) · resolving from the worker · one pinned toolchain, no `cmd.exe` shims.
  `npm test` inside the workspace still resolves from the worker's `node_modules` (§5.2).
- 2026-10-10 · `trace/schema/simulation-log-event-2.1.0.json` was generated in WP0 (it is the contract between the
  harness emitter and the replay exporter); `trace/validate.py` and the examples go with the harness package (WP2),
  so emitter and validator are built together · leaving all of `trace/` to WP6 · avoids a late, blocking contract.
  WP6 is reduced to the Scenario plugin. The 2.1 schema also enforces the required payload fields of spec-logs §4
  (2.0 left payloads unchecked) — additive.
- 2026-10-10 · Python package named `trace` shadows the stdlib `trace` module when running from the repo root · rename
  · §13.4 fixes the command `python -m trace.validate`; nothing in the project imports the stdlib `trace`.
- 2026-10-10 · Truth-table cells marked "—" in the Detectors column are checked as "no detector fires" ·
  "not evaluated" · stricter: a reference patch that trips a detector by accident would hide a detector bug.
- 2026-10-10 · ticket_done uses its own fixture: 1 line, 2 × $6.25 USD, channel `web` (§6.4 says "12.5 for the
  fixture"); `arch9_signal` is evaluated on the same captures · oracle fixture A ($24.97) as §14.5 suggests · §6.4 is
  the more specific text; ticket_done is not the oracle, so sharing CI's shape does not affect oracle independence.
- 2026-10-10 · Canaries: one per origin (docs, broker, architecture, solutions, each oracle suite, acceptance, each
  consumer repo), registry in `harness/canaries.json`; planted as a comment in each consumer `.ts`/`.md` file, a
  `_canary` key in broker JSONs, a header line in each patch, a trailing comment in each `docs/` file. Workspaces
  that legitimately receive copies get them with canary lines/keys stripped (§5.8).
- 2026-10-10 · Avatars are served at `/api/teams/avatars` instead of `/api/avatars` · a core alias · keeps every
  plugin route under its own prefix (§21.2).
- 2026-10-10 · `@types/node` pinned to 24.13.2 (an exact 24.x) · `^24` · reproducible `npm ci` across workers.
- 2026-10-10 · `C:\avg\pixel-souls\SOURCE.txt` does not exist (the folder and its sources do; not a git checkout).
  Recorded in `console/plugins/replay/app/ORIGIN.md` as "commit unknown" · stopping to ask · the source is present.
- 2026-10-10 · The builder's subagents do not commit; the lead commits each package when it closes · subagents
  committing in parallel · avoids index races in one working tree.

## WP1a · Scenario repos (2026-10-10, night; Sonnet subagent)
- 2026-10-10 · ESM `nodenext` with `.js` import suffixes in all four TS repos · CommonJS · works with the `.cjs`
  dependency-cruiser config; all builds and `arch` green.
- 2026-10-10 · `arch` = `depcruise src --config .dependency-cruiser.cjs --ignore-known` (default baseline file name),
  `tsPreCompilationDeps: true` so type-only imports count (freezes `legacyExport`'s adapter import) · explicit file arg.
- 2026-10-10 · LOC ranges (§5.2) are met by all three measures (total, non-blank, code-only) by adding genuine
  features (customer order listing with cursor, 30-day cancel window, payment retry, `/health`; billing reminders and
  payment recording; storefront cache, receipt, status badge) · padding · the metric is unspecified.
- 2026-10-10 · Payments gateway exposes only `authorize` (no void on cancel) · a void call · one payments call is what
  CI's netstub models.
- 2026-10-10 · `POST /orders` and cancel return the same body as `GET /orders/{id}` (no `customerEmail`, no
  `cancelledAt`) · full order · avoids PII in responses and keeps one response mapping (`toOrderResponse`).
- 2026-10-10 · Consumers ignore unknown fields (incl. `schemaVersion`) · strict schema · additive changes must stay
  compatible (ARCH-4).
- 2026-10-10 · Broker `requires` use only the §5.4 field lists; storefront's `status` is a plain `string` · enum ·
  new statuses stay compatible.
- 2026-10-10 · Invented catalog hosts for M2 services (customer-api `customer.identity.internal`, erp-api
  `erp.integration.internal`, `PaymentCaptured` on `payments.captured`); `envAliases` on every provided API ·
  the spec leaves them open. inventory-service is a third catalog consumer of `OrderPlaced` without a broker file (M2).
- 2026-10-10 · Consumer `.dependency-cruiser.cjs` files also carry the canary line · `.ts`/`.md` only · stripping
  works on any line containing `CANARY-`.
- 2026-10-10 · Known gap: `npm test` per repo takes ~5 s of test time but `tsc` adds 14–20 s and node startup ~2.8 s
  on this machine, so the "< 10 s" target (§5.2) is not met end to end · not fixable without changing the toolchain.
- 2026-10-11 · Oracle-suite author prompt recorded verbatim in `docs/ORACLE-AUTHOR-PROMPT.md` (§8.2) · inline here · it is long.

## WP3 · Console shell (2026-10-11; Opus subagent)
- 2026-10-11 · Namespace default: `?ns=` > session switch > `real` only if `results/real` has a non-pending/archived run, else `mock` · always `real` · mock until a real run exists.
- 2026-10-11 · Sessions persisted in `console/data/sessions.json` keyed by SHA-256 of the token; 12 h absolute expiry · memory only · a restart must not log everyone out.
- 2026-10-11 · Login/setup protected by a pre-session CSRF token (`avg_csrf` cookie) · no CSRF before login · login CSRF.
- 2026-10-11 · Writes (POST/PUT/DELETE) by a role in `readonly_roles` get 403 at the core unless the route lists that role in `roles=[…]` · per-plugin enforcement only · defence in depth.
- 2026-10-11 · Host header must be `127.0.0.1:<port>`/`localhost:<port>` (else 421); foreign Origin on POST → 403; CSP `script-src 'self'` · no checks · DNS rebinding and cross-site posts.
- 2026-10-11 · Only `/plugins/<id>/web/**` is served statically · the whole plugin folder · keeps `api.py`/`plugin.json` private.
- 2026-10-11 · SSE sends both namespaces to every client (each event carries `ns`); `audit.new` to owners only; a `runner.progress` snapshot on connect · per-session filtering · the status bar shows both runners.
- 2026-10-11 · `runner.run_finished.outcome` comes from `record.json` only when `blinding.is_visible` · from the log · the log never carries outcomes.
- 2026-10-11 · Scheduled resume in `console/data/scheduled.json`; `state.resume_at` mirrored only while no runner is alive · writing state.json any time · state.json belongs to the runner.
- 2026-10-11 · Passwords ≥ 10 chars; usernames `[a-z0-9][a-z0-9._-]{1,31}`; users disabled, never deleted; no self-disable/demote; ≥ 1 active owner · hard delete · audit trail stays readable.
- 2026-10-11 · `g`+digit uses manifest `order` · rail position · same shortcuts for every role.
- 2026-10-11 · Login rate limit: 5 failures per IP or username in 5 min → 429 · lockout · simple.
- 2026-10-11 · Doctor result cached in `console/data/readiness/doctor.json`, "Re-check" re-runs it · run on every view · ~15 s.
- 2026-10-11 · Checklist item ids = sha1(section|text); marks in `console/data/checklist.json`; `[x]` in the file counts as checked "by file" · positional ids · edits elsewhere keep marks.
- 2026-10-11 · units.json editor writes only `model`/`effort`, refuses once `PREREGISTRATION.lock` exists, audits a diff · free JSON editing · only those fields change.
- 2026-10-11 · Lucide icons generated from local lucide-react 1.45.0 (ISC) · 0.460.0 · the copy on disk, no internet.
- 2026-10-11 · Plugin `api.py` imported as package `avg_plugin_<id>` · `console.plugins.<id>` · ids contain hyphens.
- 2026-10-11 · The server always drains the request body before an early error response · replying first · Windows resets the connection otherwise.
- 2026-10-11 · `console --check` treats missing plugins as SKIP, not FAIL (integration makes it strict once all 9 exist).
