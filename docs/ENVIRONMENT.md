# Environment (verified 2026-10-10 by the builder; `python -m harness.doctor` re-checks)

| Item | Value |
|---|---|
| OS | Windows 11 Enterprise 10.0.26100 |
| Node / npm | v24.21.0 / 11.19.0 |
| Git | 2.55.0.windows.5 |
| Python | 3.13.15 in `.venv` (+ jsonschema 4.26.0) |
| Claude Code | 2.1.296 (`claude --help` saved in `docs/cli-help/claude-help.txt`) |
| Codex CLI | codex-cli **0.162.1** (2026-10-11; was 0.154.0; signed in with ChatGPT; same native entry, re-verified by `harness.doctor.codex_native_entry`): native entry `~\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe` (the `codex` shim on PATH is a `.cmd`; never invoke through it) |
| npm toolchain (repo + every worker) | typescript 6.0.3, dependency-cruiser 18.5.0, @types/node 24.13.2 (`package-lock.json` versioned) |
| Workers | `C:\avg\w1..w3` (real), `C:\avg\wm1..wm3` (mock), `C:\avg\wst` (selftest), each with `npm ci` done |

## Ancestors of `C:\avg\w1\r`
`C:\avg\w1`, `C:\avg`, `C:\` contain no `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude\` or `.codex\` (doctor check).
The repo's own `CLAUDE.md` and `.claude\` live in `C:\avg\agents-vs-gates\`, a sibling of the workers, not an ancestor.

## Configuration that could leak into runs (to be neutralized by §10.3 isolation; verified by the smoke test)
- Managed settings: `C:\Program Files\ClaudeCode\managed-settings.json` and `C:\ProgramData\ClaudeCode\managed-settings.json` — absent.
- `~\.claude\remote-settings-consent.json`, `~\.claude\policy-limits.json` — present (account/org remote settings and policy limits).
- `~\.claude\settings.json` — present; `~\.claude\hook-pretool.ps1` — present (a PreToolUse hook). `~\.claude\skills\`, `~\.claude\plugins\` — present.
- claude.ai connectors on the account (Gmail, Google Calendar/Drive, Microsoft 365, GitHub…) — present in the builder's
  own session; runs must not see them: `CLAUDE_CONFIG_DIR` per run, `--strict-mcp-config`, `--disable-slash-commands`,
  `ENABLE_CLAUDEAI_MCP_SERVERS=false`. **Unverified until the smoke test (§10.8), which needs Alfredo's authorization.**

## Flags in `claude --help` (2.1.296), checked against §10.4 without calling a model
Present in the help text: `--effort`, `--exclude-dynamic-system-prompt-sections`, `--include-hook-events`,
`--json-schema`, `--max-budget-usd`, `--permission-prompts`, `--strict-mcp-config`, `--disable-slash-commands`,
`--tools`, `--resume`. `--max-turns` is not in the help (hidden flag per §10.4) — **to verify in smoke #2**.

## Smoke test
- **#1 (2026-10-11 15:11 UTC, run by Alfredo):** FAIL, 11 of 12. CLI `2.1.296 (Claude Code)`, model `claude-sonnet-5-5`.
  Verified: token auth with an isolated `CLAUDE_CONFIG_DIR`; `--max-turns` is accepted and closes with
  `error_max_turns`; acceptEdits; the Bash allowlist (npm allowed; curl, `node -e` and reads outside the workspace
  denied); `--resume`; the token does not reach the agent's Bash. Failed: system/init listed the built-in plugins
  `cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring`. Now disabled per run in the isolated
  `settings.json` (see DECISIONS, "Smoke test #1 follow-up"). Details: `results/smoke.json`.
- **#2 (2026-10-11 17:00 UTC, run by Alfredo):** **PASS, 12 of 12.** system/init is clean with the three built-in
  plugins disabled in the isolated `settings.json`; every other check as in #1. `--max-turns` is verified.

## Codex sandbox on this machine (2026-10-11, probed without a model: `codex sandbox`, native entry, isolated CODEX_HOME)
- Default backend (unelevated restricted token) + `workspace-write`: every command refused ("windows unelevated restricted-token sandbox cannot enforce split writable root sets directly; refusing to run unsandboxed", reported by the design session; `codex sandbox -P :workspace` hung 40 s without output here). `-P :read-only` runs reads and `npm test` and refuses writes.
- **MXC backend** (`-c windows.sandbox="mxc"`, no admin setup) + `:workspace`, workspace under `C:\avg\`: `echo` ok, write inside ok, write outside refused, `npm test` of a real orders-service copy ok (tsc build into dist, 39 tests pass). Reads outside the workspace are allowed (Codex's sandbox restricts writes and network, not reads; the out-of-workspace detector flags them). With the workspace under `%TEMP%` (AppData) MXC also refused writes inside, so workspaces must stay under `C:\avg\`. Files created inside the sandbox are owned by `BUILTIN\Administrators` (a `git` run *by the sandbox* in a repo it created hits "dubious ownership"; the harness creates the run repos itself, so it does not apply; the harness could delete those files).
- Elevated backend: `codex sandbox setup --elevated --current-user` once from an admin shell (creates machine-wide accounts and network rules; `codex sandbox uninstall` removes them). Not used.
- `codex execpolicy check --rules harness/adapters/codex_rules/agents-vs-gates.rules <cmd>` verified offline: node, curl, find, rm, git commit → forbidden; npm test, git status, sed, cat → no rule.
- Four `codex.exe` processes from the first probe (PIDs 268252, 388768, 170328, 284864, 16:48–16:51) run under the sandbox token and could not be terminated ("Access is denied"); they go away with a reboot.

