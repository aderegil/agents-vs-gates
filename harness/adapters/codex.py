"""Codex CLI adapter (spec 10.9). Built and tested dry: no account yet, so no live verification.

Invoked through its native entry (never the npm .cmd shim / cmd.exe), prompt on stdin (`-`), CODEX_HOME per run
holding only a copy of auth.json. `exec resume` takes neither --sandbox nor -C: the sandbox goes in `-c` and the
workspace is the subprocess cwd. No --ephemeral (it prevents resuming).
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from harness import authenv, paths, proc
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


def build_argv(unit: dict, ws_root, resume: str | None = None) -> list[str]:
    """argv after the executable; the trailing '-' reads the prompt from stdin."""
    if resume:
        return ["exec", "resume", resume, "--json", "-c", 'sandbox_mode="workspace-write"',
                "--ignore-user-config", "--ignore-rules", "-"]
    argv = ["exec", "--json"]
    if unit.get("model"):
        argv += ["-m", str(unit["model"])]
    return argv + ["--sandbox", "workspace-write", "--ignore-user-config", "--ignore-rules", "-C", str(ws_root), "-"]


def prepare_home(cfg_dir, auth_source: Path | None = None) -> Path:
    """Wipe CODEX_HOME and copy only auth.json into it (never logged)."""
    home = Path(cfg_dir)
    if home.exists():
        shutil.rmtree(home, ignore_errors=True)
    home.mkdir(parents=True, exist_ok=True)
    src = auth_source or (Path.home() / ".codex" / "auth.json")
    if src.exists():
        shutil.copyfile(src, home / "auth.json")
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


_RATE = re.compile(r"(usage limit|rate[ _-]?limit|\b429\b|too many requests|quota)", re.I)


class JsonlParser:
    """codex exec --json → AgentEvents. Tool-like items become tool_call/tool_result pairs; agent messages and
    reasoning become text (reasoning carries "reasoning": true)."""

    TOOL_NAMES = {"command_execution": "Bash", "file_change": "Edit", "web_search": "WebSearch"}

    def __init__(self, session: str, on_event=None):
        self.session, self.on_event = session, on_event or (lambda e: None)
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
            inp = {"arguments": item.get("arguments")}
        elif it == "command_execution":
            name, inp = "Bash", {"command": item.get("command", "")}
        elif it == "file_change":
            name, inp = "Edit", {"changes": item.get("changes") or []}
        else:
            name, inp = self.TOOL_NAMES.get(it, it), {"query": item.get("query", "")}
        self.tool_calls += 1
        self._emit(event(self.session, "tool_call", ts=ts, id=item.get("id"), name=name, input=inp))

    def feed(self, line: str, ts: str | None = None):
        ts = ts or now_iso()
        try:
            msg = json.loads(line)
        except ValueError:
            return
        t = msg.get("type")
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
            self.errors.append(str(msg.get("message", "error")))


def parse_jsonl(lines, session: str) -> JsonlParser:
    p = JsonlParser(session)
    for item in lines:
        line, ts = item if isinstance(item, tuple) else (item, None)
        if line.strip():
            p.feed(line, ts)
    return p


def classify(parser: JsonlParser, rc: int | None, stderr: str, timed_out: bool) -> dict:
    out = {"subtype": "success", "is_error": False, "capped": False, "turn_cap": "wall-clock-only", "infra": None}
    if parser.breach:
        out.update(subtype="error", is_error=True, infra={"kind": "isolation_breach", "detail": parser.breach, "reset_at": None})
        return out
    if timed_out:
        out.update(subtype="wall_clock", capped=True)
        return out
    text = " ".join(parser.errors + [stderr or ""])
    if parser.errors or rc not in (0, None):
        out.update(subtype="error", is_error=True)
        if _RATE.search(text):
            from harness.adapters.claude_code import parse_reset
            out["infra"] = {"kind": "rate_limited", "detail": text.strip()[:300], "reset_at": parse_reset(text)}
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
    parser = JsonlParser(limits.session, on_event)

    def on_line(line, ts):
        parser.feed(line, ts)
        if parser.breach:
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
        infra=cls["infra"], model_reported=unit.get("model"), cli_version=version, isolation=None,
        started_at=started, ended_at=now_iso())
