"""Claude Code adapter (spec 10.3-10.4): `claude -p` with stream-json output, prompt on stdin, isolated config.

Never imported side effects: the CLI version is read lazily inside run_session. `CALLS` counts real spawns
(harness.selftest asserts it stays 0).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from harness import authenv, proc
from harness.adapters.base import Limits, SessionResult, event, now_iso

CALLS = 0
EXPECTED_TOOLS = {"Read", "Edit", "Write", "Glob", "Grep", "Bash"}
TOOLS_ARG = "Read,Edit,Write,Glob,Grep,Bash"
ALLOWED_TOOLS = ["Bash(npm run *)", "Bash(npm test)", "Bash(npm test *)", "Bash(npx tsc)", "Bash(npx tsc *)",
                 "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)"]
DISALLOWED_TOOLS = ["WebFetch", "WebSearch", "Agent"]
_VERSION: str | None = None


def claude_exe() -> str:
    return shutil.which("claude") or "claude"


def cli_version() -> str | None:
    global _VERSION
    if _VERSION is None:
        try:
            p = subprocess.run([claude_exe(), "--version"], capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=30, env=authenv.clean_env())
            _VERSION = (p.stdout or p.stderr).strip().splitlines()[0] if (p.stdout or p.stderr).strip() else None
        except (OSError, subprocess.TimeoutExpired):
            _VERSION = None
    return _VERSION


def isolation_flags() -> list[str]:
    """Flags shared by every isolated call (agent sessions, reviewer, smoke)."""
    return ["--strict-mcp-config", "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections",
            "--permission-prompts", "none"]


def build_argv(unit: dict, limits: Limits, resume: str | None = None) -> list[str]:
    """argv after the executable. The prompt goes on stdin, never as an argument."""
    argv = ["-p", "--model", str(unit["model"])]
    if unit.get("effort"):
        argv += ["--effort", str(unit["effort"])]
    argv += ["--output-format", "stream-json", "--verbose", "--include-hook-events",
             "--permission-mode", "acceptEdits",
             "--tools", TOOLS_ARG,
             "--allowedTools", *ALLOWED_TOOLS,
             "--disallowedTools", *DISALLOWED_TOOLS]
    argv += isolation_flags()
    if unit.get("max_turns_supported", True):
        argv += ["--max-turns", str(limits.max_turns)]
    if unit.get("max_budget_usd") is not None:
        argv += ["--max-budget-usd", str(unit["max_budget_usd"])]
    if resume:
        argv += ["--resume", resume]
    return argv


def build_env(cfg_dir) -> dict:
    extra = {"CLAUDE_CONFIG_DIR": str(cfg_dir), "ENABLE_CLAUDEAI_MCP_SERVERS": "false"}
    tok = authenv.oauth_token()
    if tok:
        extra[authenv.TOKEN_VAR] = tok
    return authenv.clean_env(extra)


def prepare_cfg(cfg_dir) -> Path:
    cfg = Path(cfg_dir)
    if cfg.exists():
        shutil.rmtree(cfg, ignore_errors=True)
    cfg.mkdir(parents=True, exist_ok=True)
    return cfg


def _same_path(a, b) -> bool:
    try:
        return os.path.normcase(os.path.realpath(str(a))) == os.path.normcase(os.path.realpath(str(b)))
    except OSError:
        return False


def check_init(init: dict, ws_root) -> str | None:
    """Reason string if system/init shows anything the isolation of 10.3 should have removed, else None."""
    reasons = []
    mcp = init.get("mcp_servers") or []
    if mcp:
        reasons.append("mcp_servers: " + ", ".join(str(m.get("name", m)) if isinstance(m, dict) else str(m) for m in mcp))
    plugins = init.get("plugins") or []
    if plugins:
        reasons.append("plugins: " + ", ".join(str(p.get("name", p)) if isinstance(p, dict) else str(p) for p in plugins))
    skills = init.get("skills") or []
    if skills:
        reasons.append("skills: " + ", ".join(str(s) for s in skills))
    tools = set(init.get("tools") or [])
    extra = sorted(tools - EXPECTED_TOOLS)
    if extra:
        reasons.append("unexpected tools: " + ", ".join(extra))
    if init.get("permissionMode") not in (None, "acceptEdits"):
        reasons.append(f"permissionMode {init.get('permissionMode')}")
    if ws_root is not None and init.get("cwd") and not _same_path(init["cwd"], ws_root):
        reasons.append("cwd is not the workspace")
    return "; ".join(reasons) or None


def _is_hook_line(msg: dict) -> bool:
    t, st = str(msg.get("type", "")), str(msg.get("subtype", ""))
    return "hook" in t.lower() or (t == "system" and st.lower().startswith("hook"))


_DENIED = re.compile(r"(haven't granted|has been denied|permission to use .* (was|has been) denied|"
                     r"requested permissions? to use|not allowed|permission denied by)", re.I)


def _result_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") if isinstance(c, dict) else str(c) for c in content)
    return "" if content is None else json.dumps(content)


class StreamParser:
    """Incremental stream-json → AgentEvent normalizer. Feed one line at a time."""

    def __init__(self, session: str, ws_root=None, on_event=None):
        self.session, self.ws_root, self.on_event = session, ws_root, on_event or (lambda e: None)
        self.events: list[dict] = []
        self.init: dict | None = None
        self.result: dict | None = None
        self.session_id: str | None = None
        self.breach: str | None = None
        self.rate_limit: dict | None = None
        self.texts: list[str] = []
        self.denied_ids: set[str] = set()
        self._usage_by_msg: dict[str, dict] = {}
        self.bad_lines = 0

    def _emit(self, ev: dict):
        self.events.append(ev)
        self.on_event(ev)

    def feed(self, line: str, ts: str | None = None) -> None:
        ts = ts or now_iso()
        try:
            msg = json.loads(line)
        except ValueError:
            self.bad_lines += 1
            return
        if not isinstance(msg, dict):
            return
        t = msg.get("type")
        if _is_hook_line(msg):
            self.breach = self.breach or f"hook event: {msg.get('hook_name') or msg.get('subtype') or t}"
            return
        if t == "system" and msg.get("subtype") == "init":
            self.init = msg
            self.session_id = msg.get("session_id") or self.session_id
            reason = check_init(msg, self.ws_root)
            if reason:
                self.breach = self.breach or reason
            return
        if t == "rate_limit_event":
            info = msg.get("rate_limit_info") or {}
            if str(info.get("status", "")).lower() in ("rejected", "blocked"):
                self.rate_limit = {"detail": "rate_limit_event rejected", "reset_at": _epoch_iso(info.get("resetsAt"))}
            return
        if t == "assistant":
            m = msg.get("message") or {}
            if m.get("id") and m.get("usage"):
                self._usage_by_msg[m["id"]] = m["usage"]
            for block in m.get("content") or []:
                bt = block.get("type")
                if bt == "text" and block.get("text", "").strip():
                    self.texts.append(block["text"])
                    self._emit(event(self.session, "text", ts=ts, text=block["text"]))
                elif bt == "tool_use":
                    self._emit(event(self.session, "tool_call", ts=ts, id=block.get("id"), name=block.get("name"),
                                     input=block.get("input") or {}))
            return
        if t == "user":
            m = msg.get("message") or {}
            content = m.get("content")
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                out = _result_text(block.get("content"))
                status = "success"
                if block.get("is_error"):
                    status = "denied" if _DENIED.search(out) else "error"
                if block.get("tool_use_id") in self.denied_ids:
                    status = "denied"
                self._emit(event(self.session, "tool_result", ts=ts, id=block.get("tool_use_id"), status=status,
                                 output=out))
            return
        if t == "result":
            self.result = msg
            self.session_id = msg.get("session_id") or self.session_id
            for d in msg.get("permission_denials") or []:
                if isinstance(d, dict) and d.get("tool_use_id"):
                    self.denied_ids.add(d["tool_use_id"])
            for ev in self.events:  # denials are only listed in the result: patch the already-emitted results
                if ev["kind"] == "tool_result" and ev.get("id") in self.denied_ids:
                    ev["status"] = "denied"

    def usage(self) -> dict:
        if self.result and isinstance(self.result.get("usage"), dict):
            return self.result["usage"]
        tot: dict = {}
        for u in self._usage_by_msg.values():
            for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
                tot[k] = tot.get(k, 0) + int(u.get(k) or 0)
        return tot


def parse_stream(lines_with_ts, session: str, ws_root=None) -> StreamParser:
    """Parse an iterable of (line, ts) or plain lines. Used by tests and offline re-parsing."""
    p = StreamParser(session, ws_root)
    for item in lines_with_ts:
        line, ts = item if isinstance(item, tuple) else (item, None)
        if line.strip():
            p.feed(line, ts)
    return p


# ---------------------------------------------------------------- closure classification (spec 10.4)

_RATE = re.compile(r"(usage limit|rate[ _-]?limit|\b429\b|too many requests|you've hit your limit|limit reached)", re.I)
_API = re.compile(r"(api error|overloaded|\b5\d\d\b|internal server error|connection error|request timed out|"
                  r"authentication|invalid api key|unauthori[sz]ed|oauth)", re.I)


def _epoch_iso(v) -> str | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if x > 1e12:
        x /= 1000.0
    return datetime.fromtimestamp(x, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_reset(text: str, now: datetime | None = None) -> str | None:
    """Reset time from a usage-limit message: 'limit reached|<epoch>' or 'resets 3pm' / 'resets at 3:30 pm'."""
    m = re.search(r"limit reached\|(\d{9,13})", text, re.I)
    if m:
        return _epoch_iso(m.group(1))
    m = re.search(r"resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?", text, re.I)
    if not m:
        return None
    hour, minute, ampm = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower().replace(".", "")
    if ampm == "pm" and hour < 12:
        hour += 12
    if ampm == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None
    now = now or datetime.now().astimezone()
    cand = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if cand <= now:
        cand += timedelta(days=1)
    return cand.isoformat(timespec="seconds")


def classify(result_msg: dict | None, stderr: str = "", timed_out: bool = False, *, extra_text: str = "",
             rc: int | None = 0, turn_cap_mode: str = "max-turns") -> dict:
    """→ {"subtype", "is_error", "capped", "turn_cap", "infra"}. Capping is an agent outcome, never infra."""
    r = result_msg or {}
    subtype, is_error = r.get("subtype"), r.get("is_error")
    text = " ".join(str(x) for x in (r.get("result") or "", stderr or "", extra_text or "") if x)
    out = {"subtype": subtype, "is_error": is_error, "capped": False, "turn_cap": turn_cap_mode, "infra": None}
    if timed_out:
        out.update(capped=True, turn_cap="wall-clock-only", subtype=subtype or "wall_clock")
        return out
    if subtype == "error_max_turns":
        out.update(capped=True, turn_cap="max-turns")
        return out
    erroneous = bool(is_error) or (subtype not in (None, "success")) or not result_msg or (rc not in (0, None))
    if erroneous and _RATE.search(text):
        out["infra"] = {"kind": "rate_limited", "detail": text.strip()[:300], "reset_at": parse_reset(text)}
        return out
    if not result_msg:
        out["infra"] = {"kind": "cli_crash", "detail": (f"exit {rc}; " + (stderr or "").strip())[:300], "reset_at": None}
        return out
    if is_error or subtype not in ("success",):
        out["infra"] = {"kind": "api_error", "detail": (text.strip() or str(subtype))[:300], "reset_at": None}
    return out


# ---------------------------------------------------------------- session

def run_session(ws, prompt: str, *, resume: str | None = None, unit: dict, limits: Limits, on_event=None) -> SessionResult:
    global CALLS
    started = now_iso()
    cfg = Path(ws.cfg)
    if resume is None:
        prepare_cfg(cfg)
    argv = [claude_exe()] + build_argv(unit, limits, resume)
    env = build_env(cfg)
    parser = StreamParser(limits.session, ws.root, on_event)

    def on_line(line, ts):
        parser.feed(line, ts)
        if parser.breach or parser.rate_limit:
            return "kill"

    CALLS += 1
    version = cli_version()
    r = proc.run_streaming(argv, cwd=ws.root, env=env, stdin_text=prompt, wall_clock_s=limits.wall_clock_s,
                           on_line=on_line)
    mode = "max-turns" if unit.get("max_turns_supported", True) else "wall-clock-only"
    cls = classify(parser.result, r["stderr"], r["timed_out"] and not parser.result, rc=r["rc"],
                   extra_text=" ".join(parser.texts[-1:]), turn_cap_mode=mode)
    if parser.rate_limit:
        cls["infra"] = {"kind": "rate_limited", **parser.rate_limit}
    if parser.breach:
        cls["infra"] = {"kind": "isolation_breach", "detail": parser.breach, "reset_at": None}
    res_msg = parser.result or {}
    final_text = res_msg.get("result") if isinstance(res_msg.get("result"), str) else (parser.texts[-1] if parser.texts else None)
    usage = parser.usage()
    num_turns = int(res_msg.get("num_turns") or len(parser._usage_by_msg))
    duration = int(res_msg.get("duration_ms") or r["duration_ms"])
    final = event(limits.session, "final", text=final_text, subtype=cls["subtype"], is_error=cls["is_error"],
                  num_turns=num_turns, duration_ms=duration, usage=usage, cost_usd=res_msg.get("total_cost_usd"))
    parser._emit(final)
    init = parser.init or {}
    isolation = {k: init.get(k) for k in ("tools", "mcp_servers", "plugins", "skills", "permissionMode", "cwd",
                                          "model", "slash_commands", "apiKeySource")} if init else None
    return SessionResult(
        session=limits.session, session_id=parser.session_id, events=parser.events, num_turns=num_turns,
        duration_ms=duration, usage=usage, cost_usd=res_msg.get("total_cost_usd"), subtype=cls["subtype"],
        is_error=cls["is_error"], capped=cls["capped"], turn_cap=cls["turn_cap"], final_text=final_text,
        infra=cls["infra"], model_reported=init.get("model"), cli_version=version, isolation=isolation,
        started_at=started, ended_at=now_iso())
