"""Simulated agent (spec 10.5): applies reference patches, emits plausible AgentEvents, never calls a model.

Script (harness/mock_scripts.json, keyed "<ticket>|<V>|<S>", plus "default"; or ws.mock_script):
  {"gen": "<solution key>"|null, "repairs": ["<solution key>"|null, ...], "final_message": str|null,
   "messages": {"gen": str, "fix1": str, ...},          # optional per-session final messages
   "infra": null | "rate_limited" | "crash" | "api_error" | "isolation_breach" | "timeout"
            | {"kind": ..., "session": "gen"|"fix1"...},  # "timeout" = wall-clock cap (an agent outcome, spec 10.4)
   "caps": {"fix1": "max-turns"|"wall-clock-only", ...}}
A repair session resets the working tree to `base` and applies its patch (the patches are written against the
canonical service), so `fix<n>` holds the repaired code. A session with no patch makes no change.
Env AVG_MOCK_PACE_MS (default 0) sleeps between events so demo traces have visible pacing.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from harness import gitutil, paths, scenario_io
from harness.adapters.base import SessionResult, event, now_iso

SCRIPTS = paths.REPO / "harness" / "mock_scripts.json"
CALLS = 0          # model calls made by this adapter: always 0
TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"]


def load_scripts() -> dict:
    return json.loads(SCRIPTS.read_text(encoding="utf-8"))


def script_for(ws) -> dict:
    if getattr(ws, "mock_script", None):
        return ws.mock_script
    scripts = load_scripts()
    return scripts.get(f"{ws.ticket}|{ws.V}|{ws.S}") or scripts["default"]


def _patch_key_for(script: dict, session: str) -> str | None:
    if session == "gen":
        return script.get("gen")
    n = int(session[3:])
    reps = script.get("repairs") or []
    return reps[n - 1] if n - 1 < len(reps) else None


def _infra_for(script: dict, session: str) -> str | None:
    inf = script.get("infra")
    if not inf:
        return None
    if isinstance(inf, str):
        return inf if session == "gen" else None
    return inf.get("kind") if inf.get("session", "gen") == session else None


def patch_files(patch_text: str) -> list[str]:
    return list(dict.fromkeys(m.group(1) for m in re.finditer(r"^diff --git a/(\S+) b/", patch_text, re.M)))


def apply_patch(ws, key: str) -> list[str]:
    sol = scenario_io.solution(key)
    p = Path(sol["path"])
    text = p.read_text(encoding="utf-8")
    argv = ["apply", "--whitespace=nowarn"]
    prefix = ""
    if ws.V == "V2" and sol.get("root", "service") == "service":
        argv.append("--directory=orders-service")
        prefix = "orders-service/"
    gitutil.git(ws.root, *argv, str(p))
    return [prefix + f for f in patch_files(text)]


def reset_to_base(ws) -> None:
    gitutil.git(ws.root, "read-tree", "-u", "--reset", "base")
    gitutil.git(ws.root, "clean", "-fdq")


def _pace() -> None:
    ms = int(os.environ.get("AVG_MOCK_PACE_MS", "0") or 0)
    if ms > 0:
        time.sleep(ms / 1000)


def _usage(seed: str, session: str) -> dict:
    h = int(hashlib.sha256(f"{seed}|{session}".encode()).hexdigest()[:8], 16)
    first = session == "gen"
    return {"input_tokens": (9000 if first else 3000) + h % 4000, "output_tokens": (700 if first else 300) + h % 500,
            "cache_read_input_tokens": (20000 if first else 40000) + h % 9000,
            "cache_creation_input_tokens": (6000 if first else 900) + h % 1500}


def _head(path: Path, n: int = 160) -> str:
    try:
        return path.read_text(encoding="utf-8")[:n]
    except OSError:
        return ""


def run_session(ws, prompt: str, *, resume=None, unit=None, limits=None, on_event=None) -> SessionResult:
    session = limits.session if limits else "gen"
    script = script_for(ws)
    t0 = time.monotonic()
    res = SessionResult(session=session, started_at=now_iso(), model_reported="mock", cli_version="mock/1",
                        session_id=resume or f"mock-{uuid.uuid4().hex[:12]}",
                        isolation={"tools": TOOLS, "mcp_servers": [], "plugins": [], "permissionMode": "acceptEdits",
                                   "cwd": str(ws.root), "model": "mock"})
    counter = [0]

    def emit(kind, **f):
        ev = event(session, kind, **f)
        res.events.append(ev)
        if on_event:
            on_event(ev)
        _pace()
        return ev

    def tool(name, inp, output, status="success"):
        counter[0] += 1
        tid = f"toolu_mock_{session}_{counter[0]:02d}"
        emit("tool_call", id=tid, name=name, input=inp)
        emit("tool_result", id=tid, status=status, output=output)

    infra = _infra_for(script, session)
    if infra in ("rate_limited", "crash", "api_error", "isolation_breach"):
        kind = {"crash": "cli_crash"}.get(infra, infra)
        reset = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(timespec="seconds") \
            if kind == "rate_limited" else None
        if kind != "isolation_breach":
            emit("text", text="Let me look at the code first.")
        res.infra = {"kind": kind, "detail": f"simulated {kind} (mock)", "reset_at": reset}
        if kind == "isolation_breach":
            res.isolation = dict(res.isolation, mcp_servers=[{"name": "simulated-connector", "status": "connected"}])
        res.subtype, res.is_error = "error_during_execution", True
        res.duration_ms = int((time.monotonic() - t0) * 1000)
        res.ended_at = now_iso()
        return res

    key = _patch_key_for(script, session)
    sol = scenario_io.solution(key) if key else None
    root = Path(ws.root)
    svc = "orders-service/" if ws.V == "V2" else ""
    if session == "gen":
        emit("text", text="I'll start by reading the relevant code.")
    else:
        emit("text", text="CI is failing; let me look at the output and fix it.")
    if sol:
        files = patch_files(Path(sol["path"]).read_text(encoding="utf-8"))
        shown = [f"{svc}{f}" if sol.get("root", "service") == "service" else f for f in files]
        for f in shown[:2]:
            tool("Read", {"file_path": str(root / f)}, _head(root / f) or "(new file)")
        word = re.sub(r"\W+", "", (shown[0].rsplit("/", 1)[-1].split(".")[0] if shown else "Order")) or "Order"
        tool("Grep", {"pattern": word, "path": svc + "src" if svc else "src"},
             "\n".join(shown[:3]) or "No matches found")
        emit("text", text="Now I'll make the change.")
        if session != "gen":
            reset_to_base(ws)
        touched = apply_patch(ws, key)
        for f in touched:
            tool("Edit", {"file_path": str(root / f), "old_string": "…", "new_string": "…"},
                 f"The file {root / f} has been updated successfully.")
        tool("Bash", {"command": "npm test", "description": "Run the unit tests"},
             "# tests 14\n# suites 4\n# pass 14\n# fail 0")
    else:
        tool("Read", {"file_path": str(root / svc / "src" / "core" / "events.ts")},
             _head(root / svc / "src" / "core" / "events.ts"))
    msg = (script.get("messages") or {}).get(session) or (sol or {}).get("final_message") \
        or script.get("final_message") or ("I made the change." if sol else "I did not change anything.")
    cap = (script.get("caps") or {}).get(session) or ("wall-clock-only" if infra == "timeout" else None)
    res.capped = bool(cap)
    res.turn_cap = cap or "max-turns"
    res.subtype = "error_max_turns" if cap == "max-turns" else ("wall_clock" if cap else "success")
    res.is_error = bool(cap)
    res.num_turns = counter[0] + 1
    res.usage = _usage(f"{ws.root}|{ws.ticket}|{ws.V}|{ws.S}|{res.session_id}", session)
    res.cost_usd = 0.0
    res.final_text = msg
    emit("final", text=msg, subtype=res.subtype, is_error=res.is_error, num_turns=res.num_turns,
         duration_ms=int((time.monotonic() - t0) * 1000), usage=res.usage, cost_usd=0.0)
    res.duration_ms = int((time.monotonic() - t0) * 1000)
    res.ended_at = now_iso()
    return res
