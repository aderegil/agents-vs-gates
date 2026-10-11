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
