# Environment (verified 2026-10-10 by the builder; `python -m harness.doctor` re-checks)

| Item | Value |
|---|---|
| OS | Windows 11 Enterprise 10.0.26100 |
| Node / npm | v24.21.0 / 11.19.0 |
| Git | 2.55.0.windows.5 |
| Python | 3.13.15 in `.venv` (+ jsonschema 4.26.0) |
| Claude Code | 2.1.296 (`claude --help` saved in `docs/cli-help/claude-help.txt`) |
| Codex CLI | codex-cli 0.154.0; native entry `~\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe` (the `codex` shim on PATH is a `.cmd`; never invoke through it) |
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
Not run. It requires Alfredo's explicit authorization (§0.1, §10.8, §17).
