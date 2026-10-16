"""Antigravity CLI adapter (`agy`), unit agy-flash (PREREGISTRATION-ADDENDUM-1.md §parity). Built and tested with a
fake `agy` only: the live stream format is confirmed by the smoke test (harness/smoke_agy.py, Alfredo's 🔒).

Invocation (verified by hand on 2026-10-15 in a toy repo; the prompt is an argument, there is no stdin mode in -p):
    agy -p <prompt> --model <m> --output-format stream-json --dangerously-skip-permissions
        --disable-slash-commands --print-timeout <wall_clock_s>s [--sandbox] [--conversation <id>]
cwd = the run workspace. `--conversation <id>` resumes the gen session for the repairs (fix1..fix3).

Isolation (the main risk: agy keeps memory between conversations in ~\\.gemini\\antigravity-cli\\ — brain\\,
conversations\\, annotations\\, implicit\\, knowledge\\, conversation_summaries.db, history.jsonl, summaries):
  * HOME per run. agy follows USERPROFILE/HOME (an offline probe with `agy plugin list` created .gemini\\ in a temp
    folder, 2026-10-15). The run's cfg dir (C:\\avg\\cfg\\w<k>, wiped by every materialize) becomes USERPROFILE and
    HOME for the agy process, and is seeded with a COPY of the sign-in state only: the top-level FILES of the real
    ~\\.gemini\\antigravity-cli\\ minus the memory files, the log and settings.json, plus the top-level FILES of
    ~\\.gemini\\ minus GEMINI.md, AGENTS.md and the Gemini CLI settings. No folder is copied: not config\\ (global rules,
    skills, plugins, MCP, "always allow" permissions), not brain\\ or any other memory. Our own settings.json trusts
    only the run workspace. Nothing is ever written to or deleted from the real ~\\.gemini.
  * Guard: the memory items of the real ~\\.gemini\\antigravity-cli\\ are fingerprinted (names, sizes and mtimes;
    never contents) before and after each session. A change means agy wrote to the real HOME despite the override:
    the session ends as `isolation_breach` (the runner stops the batch; the run stays pending and is never data).
  * Environment: the clean env of authenv minus GEMINI_*/GOOGLE_*/AGY_* (no API key, no ADC: the Google AI Pro
    sign-in is the only auth), plus USERPROFILE/HOME.
Turn cap: agy has no --max-turns. The cap is the wall clock, via --print-timeout (same seconds as the other units);
the process watchdog is that plus GRACE_S. Sessions end `turn_cap: "wall-clock-only"` (declared difference).
Tools: the agent's tool names are mapped to the harness's (run_command -> Bash, view_file -> Read, write_to_file ->
Write, replace_file_content -> Edit, grep_search -> Grep, find_by_name/list_dir -> Glob) and their path/command
arguments copied to the keys the detectors and covariates read (command, file_path, path, pattern). An MCP tool call
is an isolation breach (as with Codex). Web and subagent tools cannot be switched off from the CLI: they are recorded
(covariates `agy_web_calls`, `agy_subagent_calls` in the isolation block), not stopped.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

from harness import authenv, gitutil, paths, proc
from harness.adapters.base import Limits, SessionResult, event, now_iso

CALLS = 0
GRACE_S = 45
MEMO = ".avg-agy-last.json"     # in the run's HOME: the conversation's cumulative usage/duration after the last session
USAGE_RAW_KEYS = ("input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens")
WIPE_TRIES, WIPE_WAIT_S = 8, 3   # agy's background updater can hold a file for a few seconds after exit (C8)
CUT_MARGIN_S = 2       # a result this close to --print-timeout counts as cut by it
RAW_TAP = None          # smoke only: called with (line, ts) for every stdout line (schema capture)
PRICES = paths.REPO / "harness" / "prices.json"
_VERSION: str | None = None

CLI_DIR = Path(".gemini") / "antigravity-cli"
# memory and per-conversation state agy keeps between sessions: never seeded, watched in the real HOME
MEMORY_ITEMS = ("brain", "conversations", "annotations", "implicit", "knowledge", "conversation_summaries.db",
                "history.jsonl", "jetbox_summaries_proto.pb")
SEED_SKIP_CLI = set(MEMORY_ITEMS) | {"cli.log", "settings.json", "last_check.timestamp"}
SEED_SKIP_ROOT = {"GEMINI.md", "AGENTS.md", "settings.json", "settings.json.orig"}
ENV_DROP = ("GEMINI_", "GOOGLE_", "AGY_")

TOOL_MAP = {
    "run_command": "Bash", "send_command_input": "Bash", "command_status": "Bash", "read_terminal": "Bash",
    "view_file": "Read", "view_file_outline": "Read", "view_code_item": "Read", "view_content_chunk": "Read",
    "write_to_file": "Write",
    "replace_file_content": "Edit", "multi_replace_file_content": "Edit",
    "grep_search": "Grep", "codebase_search": "Grep", "codesearch": "Grep",
    "find_by_name": "Glob", "list_dir": "Glob",
    "search_web": "WebSearch", "read_url_content": "WebFetch",
}
WEB_TOOLS = {"WebSearch", "WebFetch"}
STEP_SKIP = {"user_input", "system_message", "checkpoint", "ephemeral_message"}
STEP_TEXT = {"agent_response", "planner_response", "model_response", "response"}
STEP_META = {"event", "conversation_id", "step_index", "state", "step_type", "text_delta", "usage", "duration_seconds",
             "status", "output", "result", "content", "stdout", "response", "exit_code", "exitCode"}
STEP_END = {"done", "error", "failed", "canceled", "cancelled"}
SUBAGENT_RE = re.compile(r"(subagent|^agent$|invoke_agent|spawn_agent|browser)", re.I)
ARG_KEYS = {   # agent argument -> harness key read by detectors.out_of_workspace_access / covariates
    "command": ("CommandLine", "command", "Command", "cmd"),
    "cwd": ("Cwd", "cwd"),
    "file_path": ("AbsolutePath", "TargetFile", "File", "FilePath", "file_path", "path_to_file"),
    "path": ("SearchPath", "SearchDirectory", "DirectoryPath", "Path", "path", "directory"),
    "pattern": ("Query", "Pattern", "pattern", "query"),
}


# ---------------------------------------------------------------- CLI ---------------------------------------------

def agy_exe() -> str:
    return shutil.which("agy") or "agy"


def entry_argv() -> list[str]:
    return [agy_exe()]


def cli_version() -> str | None:
    global _VERSION
    if _VERSION is None:
        try:
            p = subprocess.run(entry_argv() + ["--version"], capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=30, env=authenv.clean_env())
            out = (p.stdout or p.stderr).strip()
            _VERSION = out.splitlines()[0] if out else None
        except (OSError, subprocess.TimeoutExpired):
            _VERSION = None
    return _VERSION


def build_argv(unit: dict, limits: Limits, prompt: str, resume: str | None = None) -> list[str]:
    """argv after the executable. The prompt is -p's value (agy has no stdin prompt in print mode)."""
    argv = ["-p", prompt, "--model", str(unit["model"]), "--output-format", "stream-json",
            "--dangerously-skip-permissions", "--disable-slash-commands",
            "--print-timeout", f"{int(limits.wall_clock_s)}s"]
    if unit.get("effort") and unit.get("effort_flag", True):
        argv += ["--effort", str(unit["effort"])]
    if unit.get("sandbox"):
        argv += ["--sandbox"]
    if resume:
        argv += ["--conversation", resume]
    return argv


# ---------------------------------------------------------------- HOME --------------------------------------------

def real_home() -> Path:
    return Path(os.environ.get("AVG_AGY_REAL_HOME") or Path.home())


def _copy_files(src: Path, dest: Path, skip: set) -> list[str]:
    out = []
    if not src.is_dir():
        return out
    dest.mkdir(parents=True, exist_ok=True)
    for p in sorted(src.iterdir()):
        if p.is_file() and p.name not in skip:
            shutil.copyfile(p, dest / p.name)
            out.append(p.name)
    return out


def prepare_home(home, ws_root, source: Path | None = None) -> dict:
    """Wipe the per-run HOME and seed it with the sign-in files only (never memory, rules, config or settings).
    Returns {"seeded": n, "home": str}."""
    home = Path(home)
    for attempt in range(WIPE_TRIES):
        if home.exists():
            try:
                gitutil.rmtree(home)
            except OSError:
                pass
        if not home.exists() or not any(home.iterdir()):
            break
        time.sleep(WIPE_WAIT_S)
    home.mkdir(parents=True, exist_ok=True)
    left = sorted(p.name for p in home.iterdir())
    if left:
        raise RuntimeError(f"agy HOME could not be wiped ({', '.join(left[:5])} left): refusing to start")
    src = Path(source) if source else real_home()
    n = len(_copy_files(src / ".gemini", home / ".gemini", SEED_SKIP_ROOT))
    n += len(_copy_files(src / CLI_DIR, home / CLI_DIR, SEED_SKIP_CLI))
    (home / CLI_DIR).mkdir(parents=True, exist_ok=True)
    (home / CLI_DIR / "settings.json").write_text(
        json.dumps({"trustedWorkspaces": [str(ws_root)]}, indent=2) + "\n", encoding="utf-8")
    return {"seeded": n, "home": str(home)}


def build_env(home) -> dict:
    env = authenv.clean_env({"USERPROFILE": str(home), "HOME": str(home)})
    return {k: v for k, v in env.items() if not k.upper().startswith(ENV_DROP)}


def memory_fingerprint(home: Path | None = None) -> dict:
    """Names, sizes and mtimes of the memory items under <home>\\.gemini\\antigravity-cli (contents never read)."""
    base = Path(home or real_home()) / CLI_DIR
    out = {}
    for name in MEMORY_ITEMS:
        p = base / name
        try:
            if p.is_file():
                st = p.stat()
                out[name] = [1, st.st_size, st.st_mtime_ns]
            elif p.is_dir():
                n = size = latest = 0
                for root, _dirs, files in os.walk(p):
                    for f in files:
                        try:
                            st = os.stat(os.path.join(root, f))
                        except OSError:
                            continue
                        n += 1
                        size += st.st_size
                        latest = max(latest, st.st_mtime_ns)
                out[name] = [n, size, latest]
        except OSError:
            out[name] = None
    return out


def memory_changes(before: dict, after: dict) -> list[str]:
    return sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))


# ---------------------------------------------------------------- stream-json -------------------------------------

def _pick(d: dict, keys) -> object:
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return None


def _as_dict(v) -> dict:
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        try:
            x = json.loads(v)
            return x if isinstance(x, dict) else {"value": v}
        except ValueError:
            return {"value": v}
    return {} if v is None else {"value": v}


def normalize_tool(raw_name: str | None, args: dict) -> tuple[str, dict]:
    raw = str(raw_name or "tool")
    name = TOOL_MAP.get(raw, raw)
    if raw.lower().startswith("mcp") or "mcp__" in raw.lower():
        name = f"mcp:{raw}"
    inp = dict(args)
    for key, cands in ARG_KEYS.items():
        v = _pick(args, cands)
        if isinstance(v, str) and key not in inp:
            inp[key] = v
    if raw != name:
        inp.setdefault("agy_tool", raw)
    return name, inp


_RATE = re.compile(r"(quota|rate[ _-]?limit|resource[ _-]?exhausted|\b429\b|too many requests|credits balance|"
                   r"usage limit)", re.I)
_AUTH = re.compile(r"(not signed in|sign[ -]?in required|please (?:sign|log) ?in|unauthenticated|"
                   r"invalid[_ ]grant|login required|credentials? (?:expired|missing|not found))", re.I)
_TIMEOUT = re.compile(r"(print[- ]timeout|timed out|deadline exceeded)", re.I)


class StreamParser:
    """agy --output-format stream-json -> AgentEvents. One JSON object per line with an "event" (or "type") field and
    a conversation_id. Known for certain (manual smoke 2026-10-15): the last event is `result` with status, response,
    duration_seconds, num_turns and usage {input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
    total_tokens}. The other event names are matched loosely (tool call / tool result / message / thought / error /
    init) until the live smoke records the exact schema (results/smoke-agy-stream.jsonl). Unknown events are counted,
    never fatal. Text deltas are joined into one text event."""

    def __init__(self, session: str, on_event=None):
        self.session, self.on_event = session, on_event or (lambda e: None)
        self.events: list[dict] = []
        self.conversation_id: str | None = None
        self.model: str | None = None
        self.version: str | None = None
        self.result: dict | None = None
        self.messages: list[str] = []
        self.errors: list[str] = []
        self.plain: list[str] = []            # non-JSON stdout lines (e.g. "AGY_ERROR ...")
        self.unknown: dict[str, int] = {}
        self.tool_calls = 0
        self.web_calls = 0
        self.subagent_calls = 0
        self.breach: str | None = None
        self._open: list[str] = []            # tool call ids awaiting a result (results without an id pair FIFO)
        self._buf: dict[str, list[str]] = {}  # "text"/"thought" -> pending deltas
        self._steps: set[str] = set()         # step_update indexes already emitted as tool calls
        self._n = 0

    def _emit(self, ev):
        self.events.append(ev)
        self.on_event(ev)

    def _flush(self, ts=None):
        for kind in ("thought", "text"):
            parts = self._buf.pop(kind, None)
            if parts:
                text = "".join(parts)
                if kind == "text":
                    self.messages.append(text)
                    self._emit(event(self.session, "text", ts=ts, text=text))
                else:
                    self._emit(event(self.session, "text", ts=ts, text=text, reasoning=True))

    def _tool_call(self, msg, ts):
        self._flush(ts)
        tool = msg.get("tool") if isinstance(msg.get("tool"), dict) else msg
        raw = _pick(tool, ("tool_name", "toolName", "name", "tool"))
        args = _as_dict(_pick(tool, ("args", "arguments", "input", "parameters", "params")))
        name, inp = normalize_tool(raw if isinstance(raw, str) else None, args)
        self._n += 1
        tid = f"{self.session}:{_pick(tool, ('id', 'tool_call_id', 'call_id', 'step_id', 'tool_id')) or f'agy-{self._n}'}"
        self._open.append(tid)          # ids carry the session: a resumed conversation may number its steps again
        self.tool_calls += 1
        if name.startswith("mcp:"):
            self.breach = self.breach or f"mcp tool call {raw}"
        if name in WEB_TOOLS:
            self.web_calls += 1
        if SUBAGENT_RE.search(str(raw or "")):
            self.subagent_calls += 1
        self._emit(event(self.session, "tool_call", ts=ts, id=tid, name=name, input=inp))

    def _tool_result(self, msg, ts):
        self._flush(ts)
        tool = msg.get("tool") if isinstance(msg.get("tool"), dict) else msg
        tid = _pick(tool, ("id", "tool_call_id", "call_id", "step_id", "tool_id"))
        tid = f"{self.session}:{tid}" if tid is not None else (self._open[0] if self._open else f"{self.session}:agy-{self._n}")
        if tid in self._open:
            self._open.remove(tid)
        st = str(_pick(tool, ("status", "state", "outcome")) or "").lower()
        code = _pick(tool, ("exit_code", "exitCode"))
        if st in ("denied", "rejected", "declined", "cancelled", "canceled"):
            status = "denied"
        elif st in ("error", "failed", "failure", "errored") or (isinstance(code, int) and code != 0):
            status = "error"
        else:
            status = "success"
        out = _pick(tool, ("output", "result", "content", "stdout", "response", "text"))
        self._emit(event(self.session, "tool_result", ts=ts, id=tid, status=status,
                         output=out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)))

    def _step(self, msg, ts):
        """One step_update: user_input is skipped, agent_response carries text_delta, thinking steps go to the reasoning
        text, and every other step type is a tool step (call on first sight, result when its state ends)."""
        st = str(msg.get("step_type") or "").lower()
        state = str(msg.get("state") or "").lower()
        if st in STEP_SKIP:
            return
        if st in STEP_TEXT or any(w in st for w in ("thought", "thinking", "reasoning")):
            kind = "text" if st in STEP_TEXT else "thought"
            d = msg.get("text_delta")
            if isinstance(d, str):
                self._buf.setdefault(kind, []).append(d)
            t = _pick(msg, ("thinking_delta", "thought_delta", "reasoning_delta"))
            if isinstance(t, str):
                self._buf.setdefault("thought", []).append(t)
            return
        info = msg.get("tool_info") if isinstance(msg.get("tool_info"), dict) else {}   # live: step_type "tool"
        key = f"step-{msg.get('step_index')}"
        if key not in self._steps:
            self._steps.add(key)
            raw = _pick(msg, ("tool_name", "toolName", "name")) or _pick(info, ("name", "tool_name"))
            raw = raw if isinstance(raw, str) else st
            args = _as_dict(_pick(info, ("parameters", "args", "arguments", "input")) or
                            _pick(msg, ("args", "arguments", "input", "parameters", "params")) or
                            {k: v for k, v in msg.items() if k not in STEP_META and k != "tool_info"})
            self._tool_call({"tool_name": raw, "args": args, "id": key}, ts)
        if state in STEP_END:
            out = _pick(info, ("output", "result", "error")) or _pick(msg, ("output", "result", "content", "stdout"))
            self._tool_result({"id": key, "status": state, "exit_code": _pick(info, ("exit_code", "exitCode")),
                               "output": out if out is not None else ""}, ts)

    def feed(self, line: str, ts: str | None = None):
        ts = ts or now_iso()
        try:
            msg = json.loads(line)
        except ValueError:
            if line.strip():
                self.plain.append(line.strip())
                if "AGY_ERROR" in line:
                    self.errors.append(line.strip())
            return
        if not isinstance(msg, dict):
            return
        ev0 = msg.get("event") or msg.get("type")
        if isinstance(ev0, str) and isinstance(msg.get(ev0), dict):   # live schema (smoke 2026-10-16): {"event": X, X: {...}}
            msg = {**msg[ev0], **{k: v for k, v in msg.items() if k != ev0}}
        cid = msg.get("conversation_id") or msg.get("conversationId")
        if isinstance(cid, str) and cid:
            self.conversation_id = cid
        if isinstance(msg.get("model"), str) and msg["model"]:
            self.model = msg["model"]
        ev = str(msg.get("event") or msg.get("type") or "").lower()
        if ev == "result":
            self._flush(ts)
            self.result = msg
            if isinstance(msg.get("response"), str) and msg["response"].strip():
                if not self.messages or self.messages[-1].strip() != msg["response"].strip():
                    self.messages.append(msg["response"])
            err = msg.get("error")
            if err:
                self.errors.append(err if isinstance(err, str) else json.dumps(err))
        elif ev in ("init", "system", "start", "session_start", "conversation_start"):
            v = msg.get("cli_version") or msg.get("version")
            if isinstance(v, str):
                self.version = v
        elif ev == "step_update":
            self._step(msg, ts)
        elif "tool" in ev and any(w in ev for w in ("result", "end", "complete", "output", "response", "finish")):
            self._tool_result(msg, ts)
        elif "tool" in ev or ev in ("function_call", "step_start"):
            self._tool_call(msg, ts)
        elif any(w in ev for w in ("thought", "thinking", "reasoning")):
            self._buf.setdefault("thought", []).append(str(_pick(msg, ("text", "content", "delta", "thought")) or ""))
        elif any(w in ev for w in ("message", "text", "assistant", "content", "delta", "response")):
            text = _pick(msg, ("text", "content", "delta", "message", "response"))
            if isinstance(text, str):
                self._buf.setdefault("text", []).append(text)
        elif "error" in ev or ev in ("warning", "warn"):
            text = str(_pick(msg, ("message", "error", "text", "detail")) or ev)
            (self.errors if "error" in ev else self.plain).append(text)
        else:
            self.unknown[ev or "?"] = self.unknown.get(ev or "?", 0) + 1

    def close(self, ts=None):
        self._flush(ts)

    def usage(self) -> tuple[dict, dict]:
        """(usage in the harness's four keys, raw extras). output_tokens counts thinking tokens too, as Claude's and
        OpenAI's output counts do; the raw split is kept in the extras."""
        u = (self.result or {}).get("usage") or {}
        def i(k):
            try:
                return int(u.get(k) or 0)
            except (TypeError, ValueError):
                return 0
        usage = {"input_tokens": i("input_tokens"), "output_tokens": i("output_tokens") + i("thinking_tokens"),
                 "cache_read_input_tokens": i("cache_read_tokens"), "cache_creation_input_tokens": 0}
        extra = {"output_tokens_raw": i("output_tokens"), "thinking_tokens": i("thinking_tokens"),
                 "total_tokens": i("total_tokens")}
        return usage, extra


def parse_stream(lines, session: str) -> StreamParser:
    p = StreamParser(session)
    for item in lines:
        line, ts = item if isinstance(item, tuple) else (item, None)
        if line.strip():
            p.feed(line, ts)
    p.close()
    return p


def classify(parser: StreamParser, rc: int | None, stderr: str, timed_out: bool,
             limit_s: int | None = None) -> dict:
    out = {"subtype": "success", "is_error": False, "capped": False, "turn_cap": "wall-clock-only", "infra": None}
    if parser.breach:
        out.update(subtype="error", is_error=True, infra={"kind": "isolation_breach", "detail": parser.breach,
                                                          "reset_at": None})
        return out
    res = parser.result or {}
    status = str(res.get("status") or "").lower()
    text = " ".join(parser.errors + parser.plain[-5:] + [stderr or "", str(res.get("error") or "")])
    # live (smoke 2026-10-16): --print-timeout ends with status SUCCESS and a tool step still ACTIVE
    cut = (parser.result is not None and bool(parser._open)) or (
        limit_s is not None and isinstance(res.get("duration_seconds"), (int, float))
        and res["duration_seconds"] >= limit_s - CUT_MARGIN_S)
    if timed_out or cut or status in ("timeout", "timed_out", "deadline_exceeded") or \
            (status not in ("success", "ok", "completed") and _TIMEOUT.search(text) and not _RATE.search(text)):
        out.update(subtype="wall_clock", capped=True)
        return out
    if status in ("success", "ok", "completed") and rc in (0, None):
        return out
    if parser.result is None and rc in (0, None) and not parser.errors:
        out.update(subtype="error", is_error=True, infra={"kind": "cli_crash", "reset_at": None,
                                                          "detail": "stream ended without a result event"})
        return out
    out.update(subtype="error", is_error=True)
    if _RATE.search(text):
        from harness.adapters.codex import parse_reset_codex
        out["infra"] = {"kind": "rate_limited", "detail": text.strip()[:300], "reset_at": parse_reset_codex(text)}
    elif _AUTH.search(text):
        out["infra"] = {"kind": "api_error", "detail": ("auth: " + text.strip())[:300], "reset_at": None}
    elif parser.errors or status:
        out["infra"] = {"kind": "api_error", "detail": (text.strip() or f"status {status}")[:300], "reset_at": None}
    else:
        out["infra"] = {"kind": "cli_crash", "detail": f"exit {rc}; {(stderr or '').strip()}"[:300], "reset_at": None}
    return out


def price_cost(model: str | None, usage: dict, prices: dict | None = None) -> float | None:
    from harness.adapters.codex import price_cost as _pc
    return _pc(model, usage, prices) if prices is not None else _pc(model, usage)


# ---------------------------------------------------------------- quota -------------------------------------------

QUOTA_ARGV = ["-p", "/usage", "--output-format", "json"]   # changelog 1.2.x: `-p "/usage"`; --json output in UTC


def quota_snapshot(home, timeout_s: int = 60) -> dict:
    """`agy -p "/usage" --output-format json` in the given (seeded) HOME: the Google AI Pro quota as agy reports it.
    A slash command, not a prompt to the model (to be confirmed by the smoke). Returns {"ok", "at", "data"|"text"}."""
    global CALLS
    CALLS += 1
    at = now_iso()
    try:
        p = subprocess.run(entry_argv() + QUOTA_ARGV, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout_s, env=build_env(home), cwd=str(home))
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"ok": False, "at": at, "text": f"{type(e).__name__}: {e}"[:300]}
    text = (p.stdout or "").strip()
    try:
        return {"ok": p.returncode == 0, "at": at, "data": json.loads(text)}
    except ValueError:
        return {"ok": p.returncode == 0, "at": at, "text": (text or p.stderr or "")[:2000]}


def quota_percents(snap: dict) -> dict:
    """Flatten every numeric field whose key mentions percent/remaining/used/limit in a /usage snapshot."""
    out = {}

    def walk(v, path):
        if isinstance(v, dict):
            for k, x in v.items():
                walk(x, f"{path}.{k}" if path else str(k))
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, f"{path}[{i}]")
        elif isinstance(v, (int, float)) and not isinstance(v, bool) and                 re.search(r"(percent|remaining|used|limit|fraction|quota)", path, re.I):
            out[path] = v
    walk(snap.get("data"), "")
    return out


# ---------------------------------------------------------------- session -----------------------------------------

def own_share(result: dict, prev: dict | None) -> dict:
    """agy's `result` of a resumed conversation reports usage and duration_seconds summed over the whole conversation
    (C8, 2026-10-16: a repair's figures included the gen session's). Returns a copy with this session's share only:
    the cumulative figures minus the previous session's (never below 0)."""
    out = dict(result or {})
    if not prev:
        return out
    u, pu = dict(out.get("usage") or {}), prev.get("usage") or {}
    for k in USAGE_RAW_KEYS:
        try:
            u[k] = max(0, int(u.get(k) or 0) - int(pu.get(k) or 0))
        except (TypeError, ValueError):
            pass
    out["usage"] = u
    d, pd = out.get("duration_seconds"), prev.get("duration_seconds")
    if isinstance(d, (int, float)) and isinstance(pd, (int, float)):
        out["duration_seconds"] = max(0.0, d - pd)
    return out


def _memo(home: Path, conversation: str | None) -> dict | None:
    try:
        m = json.loads((home / MEMO).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return m if conversation and m.get("conversation_id") == conversation else None


def run_session(ws, prompt: str, *, resume: str | None = None, unit: dict, limits: Limits, on_event=None) -> SessionResult:
    global CALLS
    started = now_iso()
    home = Path(ws.cfg)
    seed = None
    if resume is None:
        seed = prepare_home(home, ws.root)
    argv = entry_argv() + build_argv(unit, limits, prompt, resume)
    parser = StreamParser(limits.session, on_event)

    def on_line(line, ts):
        if RAW_TAP:
            RAW_TAP(line, ts)
        parser.feed(line, ts)
        if parser.breach:
            return "kill"

    before = memory_fingerprint()
    CALLS += 1
    version = cli_version()
    r = proc.run_streaming(argv, cwd=ws.root, env=build_env(home), stdin_text="",
                           wall_clock_s=limits.wall_clock_s + GRACE_S, on_line=on_line)
    parser.close()
    cumulative = dict(parser.result or {}) if parser.result else None
    if cumulative is not None:
        parser.result = own_share(cumulative, _memo(home, resume) if resume else None)
        try:
            (home / MEMO).write_text(json.dumps({"conversation_id": parser.conversation_id or resume,
                                                 "usage": cumulative.get("usage") or {},
                                                 "duration_seconds": cumulative.get("duration_seconds")}),
                                     encoding="utf-8")
        except OSError:
            pass
    changed = memory_changes(before, memory_fingerprint())
    if changed and not parser.breach:
        parser.breach = "agy wrote to the real ~\\.gemini\\antigravity-cli memory: " + ", ".join(changed)
    cls = classify(parser, r["rc"], r["stderr"], r["timed_out"], limits.wall_clock_s)
    usage, extra = parser.usage()
    res = parser.result or {}
    # agy's own num_turns counts user turns (1 per call, C8); agent turns = tool steps + the final answer, which is
    # what Claude Code's num_turns counts. agy's figure is kept in usage_extra.
    num_turns = parser.tool_calls + 1 if (parser.messages or parser.tool_calls) else 0
    if isinstance(res.get("num_turns"), int):
        extra["agy_num_turns"] = res["num_turns"]
    cost = price_cost(unit.get("model"), usage)
    final_text = parser.messages[-1] if parser.messages else None
    if isinstance(res.get("duration_seconds"), (int, float)):
        extra["cli_duration_s"] = res["duration_seconds"]
    if resume and cumulative is not None:
        extra["cumulative"] = {"usage": cumulative.get("usage"), "duration_seconds": cumulative.get("duration_seconds")}
    final = event(limits.session, "final", text=final_text, subtype=cls["subtype"], is_error=cls["is_error"],
                  num_turns=num_turns, duration_ms=r["duration_ms"], usage=dict(usage), cost_usd=cost)
    parser._emit(final)
    isolation = {"home": "per-run", "seeded_files": seed["seeded"] if seed else None, "sandbox": bool(unit.get("sandbox")),
                 "real_home_memory_changed": changed, "web_calls": parser.web_calls,
                 "subagent_calls": parser.subagent_calls, "unknown_events": dict(parser.unknown),
                 "prompt_has_at": "@" in prompt}
    return SessionResult(
        session=limits.session, session_id=parser.conversation_id or resume, events=parser.events,
        num_turns=int(num_turns or 0), duration_ms=r["duration_ms"], usage=usage, cost_usd=cost,
        subtype=cls["subtype"], is_error=cls["is_error"], capped=cls["capped"], turn_cap=cls["turn_cap"],
        final_text=final_text, infra=cls["infra"], model_reported=parser.model or unit.get("model"),
        cli_version=parser.version or version, isolation=isolation, started_at=started, ended_at=now_iso(),
        usage_extra=extra)
