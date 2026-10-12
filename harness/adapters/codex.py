"""Codex CLI adapter (spec 10.9). Built and tested dry: no account yet, so no live verification.

Invoked through its native entry (never the npm .cmd shim / cmd.exe), prompt on stdin (`-`), CODEX_HOME per run
holding only a copy of auth.json. `exec resume` takes neither --sandbox nor -C: the sandbox goes in `-c` and the
workspace is the subprocess cwd. No --ephemeral (it prevents resuming). No --ignore-rules: CODEX_HOME holds only
auth.json and harness/adapters/codex_rules/*.rules (exec policy mirroring the Claude allowlist's denials).

Model and effort are explicit (units.json): --ignore-user-config means ~/.codex/config.toml never applies, so the
effort goes in `-c model_reasoning_effort=...` (exec and resume) and the model in `-m` (exec) / `-c model=...` (resume).
`approval_policy="never"`: exec has nobody to ask, so a command outside the sandbox policy fails instead of waiting.

Turn cap (Codex audit 2026-10-11, #6): `codex exec` has no --max-turns, so the adapter counts turns in the --json
stream like Claude Code's num_turns: one turn per tool call the model issues (command_execution, file_change,
mcp_tool_call, web_search) plus the final answer, so num_turns = tool_calls + 1. When the model starts its
max_turns-th tool call the process tree is killed and the session ends `capped` with subtype "error_max_turns" and
turn_cap "max-turns", like Claude's `--max-turns N` (N turns, the last one cut). The wall clock stays as a second cap.

Sandbox (spec 10.9): `sandbox_mode` comes from the unit ("workspace-write" by default) and the Windows backend from
unit "windows_sandbox" (`-c windows.sandbox=...`). On this machine the default unelevated restricted-token backend
refuses every command in workspace-write; "mxc" runs them (probed without a model, see DECISIONS); "elevated" needs a
one-time admin setup. A command the sandbox backend refuses ends the session as an isolation failure that stops the
batch: a run whose agent cannot use the shell is never data.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from harness import authenv, gitutil, paths, proc
from harness.adapters.base import Limits, SessionResult, event, now_iso

CALLS = 0
PRICES = paths.REPO / "harness" / "prices.json"
_VERSION: str | None = None


def entry_argv() -> list[str]:
    from harness.doctor import codex_native_entry
    entry = codex_native_entry()
    if not entry:
        raise RuntimeError("codex native entry not found (harness.doctor.codex_native_entry)")
    if entry.lower().endswith(".js"):
        return [shutil.which("node") or "node", entry]
    return [entry]


def cli_version() -> str | None:
    global _VERSION
    if _VERSION is None:
        try:
            p = subprocess.run(entry_argv() + ["--version"], capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=30, env=authenv.clean_env())
            _VERSION = (p.stdout or p.stderr).strip().splitlines()[0] if (p.stdout or p.stderr).strip() else None
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            _VERSION = None
    return _VERSION


def _toml(v) -> str:
    return json.dumps(str(v))


# Codex 0.162.1 turns on, by default and even with an empty CODEX_HOME, capabilities the Claude unit does not have
# (remote plugins with skills, ChatGPT apps, browser/computer use, image generation, sub-agents, hooks, goals...); off.
# Code mode stays ON: gpt-5.6-terra only runs commands through its `exec` (code-mode) tool — with code_mode_host off it
# answered "command execution is unavailable" (smoke 3, 2026-10-11). The TTY is off (npm test hung under it, smoke 1).
# The turn cap still counts one turn per command: the --json stream emits one command_execution item per command, even
# when a single `exec` script runs several. Skills instructions are dropped from the prompt (skills.include_instructions).
# Verified offline with `codex -c features.<f>=false features list` (DECISIONS, smoke diagnosis 2026-10-11).
FEATURES_OFF = ("unified_exec_tty", "apps", "plugins", "remote_plugin", "plugin_sharing",
                "browser_use", "browser_use_external", "computer_use", "image_generation", "multi_agent",
                "skill_search", "skill_mcp_dependency_install", "tool_suggest", "goals", "hooks", "in_app_browser")


def _config_args(unit: dict) -> list[str]:
    out = ["-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "skills.include_instructions=false"]
    for f in FEATURES_OFF:
        out += ["-c", f"features.{f}=false"]
    if unit.get("effort"):
        out += ["-c", f"model_reasoning_effort={_toml(unit['effort'])}"]
    if unit.get("windows_sandbox"):
        out += ["-c", f"windows.sandbox={_toml(unit['windows_sandbox'])}"]
    return out


def build_argv(unit: dict, ws_root, resume: str | None = None) -> list[str]:
    """argv after the executable; the trailing '-' reads the prompt from stdin."""
    mode = unit.get("sandbox") or "workspace-write"
    if resume:
        argv = ["exec", "resume", resume, "--json", "-c", f"sandbox_mode={_toml(mode)}"]
        if unit.get("model"):
            argv += ["-c", f"model={_toml(unit['model'])}"]
        return argv + _config_args(unit) + ["--ignore-user-config", "-"]
    argv = ["exec", "--json"]
    if unit.get("model"):
        argv += ["-m", str(unit["model"])]
    return argv + _config_args(unit) + ["--sandbox", mode, "--ignore-user-config", "-C", str(ws_root), "-"]


RULES = Path(__file__).parent / "codex_rules"


def prepare_home(cfg_dir, auth_source: Path | None = None) -> Path:
    """Wipe CODEX_HOME; copy only auth.json (never logged) and our exec-policy rules (parity with the Claude
    allowlist) into it. No --ignore-rules: the only rules Codex can load are these."""
    home = Path(cfg_dir)
    if home.exists():
        try:
            gitutil.rmtree(home)     # clears ReadOnly attributes and retries; whatever is left is caught below
        except OSError:
            pass
    home.mkdir(parents=True, exist_ok=True)
    left = sorted(p.name for p in home.iterdir())
    if left:   # a previous session's memories/goals/state databases would carry over into this run
        raise RuntimeError(f"CODEX_HOME could not be wiped ({', '.join(left[:5])} left): refusing to start")
    src = auth_source or (Path.home() / ".codex" / "auth.json")
    if src.exists():
        shutil.copyfile(src, home / "auth.json")
    (home / "rules").mkdir()
    for r in sorted(RULES.glob("*.rules")):
        shutil.copyfile(r, home / "rules" / r.name)
    return home


def build_env(codex_home) -> dict:
    return authenv.clean_env({"CODEX_HOME": str(codex_home)})


def price_cost(model: str | None, usage: dict, prices: dict | None = None) -> float | None:
    if prices is None:
        try:
            prices = json.loads(PRICES.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
    p = (prices.get("models") or {}).get(model or "")
    if not p:
        return None
    m = 1e-6
    return round(usage.get("input_tokens", 0) * p.get("input_per_mtok", 0) * m
                 + usage.get("cache_read_input_tokens", 0) * p.get("cached_input_per_mtok", 0) * m
                 + usage.get("output_tokens", 0) * p.get("output_per_mtok", 0) * m, 6)


# ChatGPT-plan and API limit texts: "You've hit your usage limit ... try again in 2 hours 5 minutes",
# "usage_limit_reached", "Rate limit reached for ...", "429 Too Many Requests", "insufficient_quota"
_RATE = re.compile(r"(usage[ _-]?limit|rate[ _-]?limit|\b429\b|too many requests|quota)", re.I)
# the Windows sandbox backend refusing to run a command (seen with the unelevated backend in workspace-write)
_SANDBOX = re.compile(r"(restricted-token sandbox cannot|refusing to run unsandboxed|requires the elevated Windows "
                      r"sandbox|sandbox (?:setup|provisioning) (?:required|failed|incomplete))", re.I)
_TRANSIENT = re.compile(r"^\s*(reconnecting|retrying)\b", re.I)
# the Windows sandbox launcher (MXC) failing to create a command's process before the command runs: the shell is dead
# for that session through no act of the agent (P6, 2026-10-12: 13 runs on all three workers, 16:11-16:21 UTC,
# HRESULT 0x80070020). An infrastructure failure, re-queued (PREREGISTRATION §5), never an agent outcome.
_SANDBOX_DEAD = re.compile(r"(CreateProcessSecurityEnvironment failed|MXC launcher: failed to create)", re.I)


def parse_reset_codex(text: str, now=None) -> str | None:
    """'try again in 4 days 20 hours 9 minutes' / 'in 1.5s' / 'try again at 3:05 PM' -> ISO; else Claude's parser."""
    from datetime import datetime, timedelta
    from harness.adapters.claude_code import parse_reset
    now = now or datetime.now().astimezone()
    m = re.search(r"try again in ([^.\n]+(?:\.\d+s)?)", text, re.I)
    if m:
        secs = 0.0
        for n, u in re.findall(r"(\d+(?:\.\d+)?)\s*(days?|d\b|hours?|hrs?|h\b|minutes?|mins?|m\b|seconds?|secs?|s\b)",
                               m.group(1), re.I):
            secs += float(n) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[u[0].lower()]
        if secs:
            return (now + timedelta(seconds=secs)).isoformat(timespec="seconds")
    m = re.search(r"try again at (\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)", text, re.I)
    if m:
        return parse_reset("resets at " + m.group(1), now)
    return parse_reset(text, now)


class JsonlParser:
    """codex exec --json → AgentEvents. Tool-like items become tool_call/tool_result pairs; agent messages and
    reasoning become text (reasoning carries "reasoning": true)."""

    TOOL_NAMES = {"command_execution": "Bash", "file_change": "Edit", "web_search": "WebSearch"}

    def __init__(self, session: str, on_event=None, max_turns: int | None = None):
        self.session, self.on_event = session, on_event or (lambda e: None)
        self.max_turns = max_turns
        self.capped = False                 # the model started its max_turns-th tool call: the process is killed
        self.model: str | None = None       # model id, when the stream reports one
        self.notices: list[str] = []        # transient stream errors (reconnecting...), not failures
        self.sandbox_error: str | None = None
        self.sandbox_dead: str | None = None    # the launcher could not start a command (_SANDBOX_DEAD)
        self.first_failure: str | None = None   # "breach" or "sandbox_dead", whichever the stream showed first
        self.events: list[dict] = []
        self.thread_id: str | None = None
        self.usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0,
                      "cache_creation_input_tokens": 0}
        self.turns_completed = 0
        self.tool_calls = 0
        self.messages: list[str] = []
        self.errors: list[str] = []
        self.breach: str | None = None
        self._started: set[str] = set()

    def _emit(self, ev):
        self.events.append(ev)
        self.on_event(ev)

    def _call(self, item, ts):
        it = item.get("type")
        if it == "mcp_tool_call":
            name = f"mcp:{item.get('server')}/{item.get('tool')}"
            self.breach = self.breach or f"mcp tool call {name}"
            self.first_failure = self.first_failure or "breach"
            inp = {"arguments": item.get("arguments")}
        elif it == "command_execution":
            name, inp = "Bash", {"command": item.get("command", "")}
        elif it == "file_change":
            name, inp = "Edit", {"changes": item.get("changes") or []}
        else:
            name, inp = self.TOOL_NAMES.get(it, it), {"query": item.get("query", "")}
        self.tool_calls += 1
        if self.max_turns and self.tool_calls >= self.max_turns:
            self.capped = True
        self._emit(event(self.session, "tool_call", ts=ts, id=item.get("id"), name=name, input=inp))

    def feed(self, line: str, ts: str | None = None):
        ts = ts or now_iso()
        try:
            msg = json.loads(line)
        except ValueError:
            return
        t = msg.get("type")
        for src in (msg, msg.get("item") if isinstance(msg.get("item"), dict) else {}):
            if isinstance(src.get("model"), str) and src["model"]:
                self.model = src["model"]
        if t == "thread.started":
            self.thread_id = msg.get("thread_id")
        elif t in ("item.started", "item.completed"):
            item = msg.get("item") or {}
            it, iid = item.get("type"), item.get("id")
            if it in ("agent_message", "reasoning"):
                if t == "item.completed" and item.get("text"):
                    if it == "agent_message":
                        self.messages.append(item["text"])
                        self._emit(event(self.session, "text", ts=ts, text=item["text"]))
                    else:
                        self._emit(event(self.session, "text", ts=ts, text=item["text"], reasoning=True))
                return
            if it not in ("command_execution", "file_change", "mcp_tool_call", "web_search"):
                return
            if t == "item.started":
                self._started.add(iid)
                self._call(item, ts)
                return
            if iid not in self._started:
                self._call(item, ts)
            st = item.get("status")
            if st in ("declined", "rejected"):
                status = "denied"
            elif st == "failed" or (it == "command_execution" and item.get("exit_code") not in (0, None)):
                status = "error"
            else:
                status = "success"
            out = item.get("aggregated_output")
            said = (out if isinstance(out, str) else "") + " " + json.dumps(item.get("error") or "")
            if status == "error" and _SANDBOX.search(said):
                self.sandbox_error = self.sandbox_error or said.strip()[:300]
            if status == "error" and it == "command_execution" and _SANDBOX_DEAD.search(said):
                self.sandbox_dead = self.sandbox_dead or said.strip()[:300]
                self.first_failure = self.first_failure or "sandbox_dead"
            if out is None:
                out = item.get("result") if it == "mcp_tool_call" else \
                    ", ".join(f"{c.get('kind')} {c.get('path')}" for c in item.get("changes") or []) or ""
            self._emit(event(self.session, "tool_result", ts=ts, id=iid, status=status,
                             output=out if isinstance(out, str) else json.dumps(out)))
        elif t == "turn.completed":
            self.turns_completed += 1
            u = msg.get("usage") or {}
            self.usage["input_tokens"] += int(u.get("input_tokens") or 0)
            self.usage["output_tokens"] += int(u.get("output_tokens") or 0)
            self.usage["cache_read_input_tokens"] += int(u.get("cached_input_tokens") or 0)
        elif t == "turn.failed":
            self.errors.append(str((msg.get("error") or {}).get("message", "turn failed")))
        elif t == "error":
            text = str(msg.get("message", "error"))
            (self.notices if _TRANSIENT.search(text) else self.errors).append(text)


def parse_jsonl(lines, session: str) -> JsonlParser:
    p = JsonlParser(session)
    for item in lines:
        line, ts = item if isinstance(item, tuple) else (item, None)
        if line.strip():
            p.feed(line, ts)
    return p


def classify(parser: JsonlParser, rc: int | None, stderr: str, timed_out: bool) -> dict:
    out = {"subtype": "success", "is_error": False, "capped": False, "turn_cap": "max-turns", "infra": None}
    # a dead sandbox is an infrastructure failure (re-queued); it wins over a breach only when it came first, since an
    # agent with no shell may go looking for other tools (p6-0062/0063: list_mcp_resources after the shell died)
    if parser.sandbox_dead and (not parser.breach or parser.first_failure == "sandbox_dead"):
        out.update(subtype="error", is_error=True, infra={"kind": "sandbox_unavailable", "reset_at": None,
                                                          "detail": "sandbox could not start a command: "
                                                                    + parser.sandbox_dead})
        return out
    if parser.breach:
        out.update(subtype="error", is_error=True, infra={"kind": "isolation_breach", "detail": parser.breach, "reset_at": None})
        return out
    if parser.sandbox_error:
        out.update(subtype="error", is_error=True, infra={"kind": "isolation_breach", "reset_at": None,
                                                          "detail": "sandbox unavailable: " + parser.sandbox_error})
        return out
    if parser.capped:
        out.update(subtype="error_max_turns", is_error=True, capped=True, turn_cap="max-turns")
        return out
    if timed_out:
        out.update(subtype="wall_clock", capped=True, turn_cap="wall-clock-only")
        return out
    text = " ".join(parser.errors + [stderr or ""])
    if parser.errors or rc not in (0, None):
        out.update(subtype="error", is_error=True)
        if _RATE.search(text):
            out["infra"] = {"kind": "rate_limited", "detail": text.strip()[:300], "reset_at": parse_reset_codex(text)}
        elif parser.errors:
            out["infra"] = {"kind": "api_error", "detail": text.strip()[:300], "reset_at": None}
        else:
            out["infra"] = {"kind": "cli_crash", "detail": f"exit {rc}; {(stderr or '').strip()}"[:300], "reset_at": None}
    return out


def run_session(ws, prompt: str, *, resume: str | None = None, unit: dict, limits: Limits, on_event=None) -> SessionResult:
    global CALLS
    started = now_iso()
    home = Path(ws.cfg)
    if resume is None:
        prepare_home(home)
    argv = entry_argv() + build_argv(unit, ws.root, resume)
    parser = JsonlParser(limits.session, on_event, max_turns=limits.max_turns)

    def on_line(line, ts):
        parser.feed(line, ts)
        if parser.breach or parser.capped or parser.sandbox_error or parser.sandbox_dead:
            return "kill"

    CALLS += 1
    version = cli_version()
    r = proc.run_streaming(argv, cwd=ws.root, env=build_env(home), stdin_text=prompt,
                           wall_clock_s=limits.wall_clock_s, on_line=on_line)
    cls = classify(parser, r["rc"], r["stderr"], r["timed_out"])
    num_turns = parser.tool_calls + 1 if (parser.messages or parser.tool_calls) else 0
    cost = price_cost(unit.get("model"), parser.usage)
    final_text = parser.messages[-1] if parser.messages else None
    final = event(limits.session, "final", text=final_text, subtype=cls["subtype"], is_error=cls["is_error"],
                  num_turns=num_turns, duration_ms=r["duration_ms"], usage=dict(parser.usage), cost_usd=cost)
    parser._emit(final)
    return SessionResult(
        session=limits.session, session_id=parser.thread_id or resume, events=parser.events, num_turns=num_turns,
        duration_ms=r["duration_ms"], usage=dict(parser.usage), cost_usd=cost, subtype=cls["subtype"],
        is_error=cls["is_error"], capped=cls["capped"], turn_cap=cls["turn_cap"], final_text=final_text,
        infra=cls["infra"], model_reported=parser.model or unit.get("model"), cli_version=version, isolation=None,
        started_at=started, ended_at=now_iso())
