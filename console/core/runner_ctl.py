"""Launching and steering `python -m harness.runner` from the console (spec §22.2, contract §5).

The runner is always a separate, detached process so that restarting the console never kills a batch; the console
reconnects by reading the PID in results/<ns>/state.json. Helpers used by Run Control (WP4) and by the core scheduler:

    launch_runner(ns, args, user) -> pid          args: the runner's CLI args, e.g. ["--unit", "mock", "--stage", "P1", "--batch", "8"]
    runner_alive(ns) -> bool                      PID from state.json (or from a launch in the last 2 minutes), OpenProcess check
    request_stop(ns, user) -> dict                writes results/<ns>/control.json {"stop_after_current": true, "by", "at"}
    schedule_resume(ns, at_iso, args, user) -> dict   stored in <data_dir>/scheduled.json; the core scheduler launches it
    cancel_resume(ns, user) -> bool
    scheduled(ns=None) -> dict
    spawn_detached(argv, log_name, data_dir=None) -> pid

Files owned here:
    <data_dir>/scheduled.json      {"schema": "scheduled/1", "entries": {"<ns>": {"at", "args", "by", "created_at"}}}
    <data_dir>/runner-launch.json  {"<ns>": {"pid", "at", "args", "by", "log"}}   (last launch per namespace)
    <data_dir>/logs/<name>.log     stdout+stderr of every spawned process (appended)
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from harness import paths
from harness.jsonio import read_json, write_json_atomic

from .plugin_api import ApiError, default_python

_cfg = {"data_dir": paths.REPO / "console" / "data", "audit": None, "python": default_python(paths.REPO)}
_lock = threading.RLock()

DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
LAUNCH_GRACE_S = 120


def configure(data_dir: Path | None = None, audit=None, python: str | None = None) -> None:
    if data_dir is not None:
        _cfg["data_dir"] = Path(data_dir)
    if audit is not None:
        _cfg["audit"] = audit
    if python is not None:
        _cfg["python"] = python


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).isoformat(timespec="seconds")


def parse_iso(s: str) -> datetime:
    """ISO 8601; a trailing Z is accepted; naive times are taken as local time."""
    if not isinstance(s, str) or not s:
        raise ValueError("empty timestamp")
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.astimezone()  # local
    return dt


def _audit(action: str, detail: dict, user: dict | None) -> None:
    a = _cfg.get("audit")
    if a is not None:
        a.append(action, detail, user, plugin="core")


def _check_ns(ns: str) -> str:
    if ns not in paths.NAMESPACES:
        raise ApiError(400, f"Unknown namespace {ns!r}")
    return ns


# ---------------------------------------------------------------- processes

def spawn_detached(argv: list[str], log_name: str, data_dir: Path | None = None, cwd: Path | None = None,
                   env: dict | None = None) -> int:
    if not isinstance(argv, (list, tuple)) or not argv or not all(isinstance(a, str) for a in argv):
        raise ValueError("argv must be a non-empty list of strings")
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in str(log_name)) or "process"
    logs = Path(data_dir or _cfg["data_dir"]) / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / f"{safe}.log"
    e = dict(os.environ if env is None else env)
    e.setdefault("PYTHONIOENCODING", "utf-8")
    with open(log_path, "ab") as logf:
        logf.write(f"\n=== {_iso()} spawn: {' '.join(argv)}\n".encode("utf-8", "replace"))
        logf.flush()
        kw = dict(cwd=str(cwd or paths.REPO), env=e, stdin=subprocess.DEVNULL, stdout=logf,
                  stderr=subprocess.STDOUT, close_fds=True)
        if os.name == "nt":
            base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
            try:  # leave the console's job object too (some terminals kill the whole job on close)
                p = subprocess.Popen(list(argv), creationflags=base | CREATE_BREAKAWAY_FROM_JOB, **kw)
            except OSError:
                p = subprocess.Popen(list(argv), creationflags=base, **kw)
        else:
            p = subprocess.Popen(list(argv), start_new_session=True, **kw)
    return p.pid


def pid_alive(pid) -> bool:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except PermissionError:
            return True
        except OSError:
            return False
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ctypes.get_last_error() == 5  # access denied: the process exists
    try:
        code = wintypes.DWORD()
        if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
            return False
        if code.value != 259:  # STILL_ACTIVE
            return False
        # Guard against PID reuse: the runner is a Python process.
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        q = k32.QueryFullProcessImageNameW
        q.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD))
        if q(h, 0, buf, ctypes.byref(size)):
            return "python" in Path(buf.value).name.lower()
        return True
    finally:
        k32.CloseHandle(h)


# ---------------------------------------------------------------- runner

def _launch_file() -> Path:
    return Path(_cfg["data_dir"]) / "runner-launch.json"


def last_launch(ns: str) -> dict | None:
    return (read_json(_launch_file(), default=None) or {}).get(ns)


def runner_pid(ns: str) -> int | None:
    """PID of a live runner for ns, or None."""
    _check_ns(ns)
    st = read_json(paths.state_path(ns), default=None) or {}
    pid = (st.get("runner") or {}).get("pid")
    if pid and pid_alive(pid):
        return int(pid)
    launch = last_launch(ns)
    if launch and launch.get("pid") and pid_alive(launch["pid"]):
        try:
            age = (_now() - parse_iso(launch["at"])).total_seconds()
        except (KeyError, ValueError):
            age = LAUNCH_GRACE_S + 1
        # Before the runner writes its PID into state.json, trust our own launch record for a while.
        if age < LAUNCH_GRACE_S or not pid:
            return int(launch["pid"])
    return None


def runner_alive(ns: str) -> bool:
    return runner_pid(ns) is not None


def _check_args(args) -> list[str]:
    if not isinstance(args, (list, tuple)) or not all(isinstance(a, str) and 0 < len(a) <= 200 for a in args):
        raise ApiError(400, "Runner args must be a list of non-empty strings")
    if len(args) > 40:
        raise ApiError(400, "Too many runner args")
    return list(args)


def launch_runner(ns: str, args: list[str], user: dict | None) -> int:
    """Start `python -X utf8 -m harness.runner <args>` detached. 409 if a runner for ns is alive."""
    _check_ns(ns)
    args = _check_args(args)
    with _lock:
        if runner_alive(ns):
            raise ApiError(409, f"A runner is already running for the {ns} namespace")
        if not (paths.REPO / "harness" / "runner.py").exists():
            raise ApiError(409, "harness.runner is not available yet")
        argv = [_cfg["python"], "-X", "utf8", "-m", "harness.runner", *args]
        stamp = _now().strftime("%Y%m%d-%H%M%S")
        log_name = f"runner-{ns}-{stamp}"
        pid = spawn_detached(argv, log_name)
        rec = read_json(_launch_file(), default=None) or {}
        rec[ns] = {"pid": pid, "at": _iso(), "args": args, "by": (user or {}).get("username"), "log": f"logs/{log_name}.log"}
        write_json_atomic(_launch_file(), rec)
    _audit("runner.launch", {"ns": ns, "args": args, "pid": pid}, user)
    return pid


def request_stop(ns: str, user: dict | None) -> dict:
    """Graceful stop: the runner polls control.json between runs and exits after the current one."""
    _check_ns(ns)
    ctl = {"stop_after_current": True, "by": (user or {}).get("username") or "system", "at": _iso()}
    write_json_atomic(paths.control_path(ns), ctl)
    _audit("runner.stop_requested", {"ns": ns}, user)
    return ctl


# ---------------------------------------------------------------- scheduled resume

def _sched_file() -> Path:
    return Path(_cfg["data_dir"]) / "scheduled.json"


def scheduled(ns: str | None = None) -> dict:
    entries = (read_json(_sched_file(), default=None) or {}).get("entries", {})
    return entries.get(ns) if ns else entries


def _write_sched(entries: dict) -> None:
    write_json_atomic(_sched_file(), {"schema": "scheduled/1", "entries": entries})


def _set_state_resume_at(ns: str, value: str | None) -> None:
    """Mirror into state.json (schema field resume_at) only while no runner owns the file."""
    sp = paths.state_path(ns)
    st = read_json(sp, default=None)
    if not isinstance(st, dict) or runner_alive(ns):
        return
    if st.get("resume_at") == value:
        return
    st["resume_at"] = value
    write_json_atomic(sp, st)


def schedule_resume(ns: str, at_iso: str, args: list[str], user: dict | None) -> dict:
    _check_ns(ns)
    args = _check_args(args)
    try:
        at = parse_iso(at_iso)
    except ValueError:
        raise ApiError(400, "resume time must be an ISO 8601 timestamp")
    if (at - _now()).total_seconds() > 7 * 86400:
        raise ApiError(400, "resume time must be within 7 days")
    entry = {"at": at.astimezone(timezone.utc).isoformat(timespec="seconds"), "args": args,
             "by": (user or {}).get("username") or "system", "created_at": _iso()}
    with _lock:
        entries = scheduled()
        entries[ns] = entry
        _write_sched(entries)
    _set_state_resume_at(ns, entry["at"])
    _audit("runner.resume_scheduled", {"ns": ns, "at": entry["at"], "args": args}, user)
    return entry


def cancel_resume(ns: str, user: dict | None) -> bool:
    _check_ns(ns)
    with _lock:
        entries = scheduled()
        had = entries.pop(ns, None)
        _write_sched(entries)
    _set_state_resume_at(ns, None)
    if had:
        _audit("runner.resume_cancelled", {"ns": ns, "at": had.get("at")}, user)
    return bool(had)


def scheduler_tick(now: datetime | None = None) -> list[dict]:
    """Launch every due scheduled resume. Called every second by the core watcher. Returns what it did."""
    now = now or _now()
    done = []
    with _lock:
        entries = scheduled()
        changed = False
        for ns, e in list(entries.items()):
            try:
                due = parse_iso(e["at"]) <= now
            except (KeyError, ValueError):
                entries.pop(ns)
                changed = True
                continue
            if not due:
                continue
            entries.pop(ns)
            changed = True
            who = {"username": e.get("by") or "system", "role": None}
            if runner_alive(ns):
                _audit("runner.resume_skipped", {"ns": ns, "reason": "runner already running"}, who)
                done.append({"ns": ns, "skipped": True})
                continue
            try:
                pid = launch_runner(ns, e.get("args") or [], who)
                done.append({"ns": ns, "pid": pid})
            except (ApiError, OSError) as ex:
                _audit("runner.resume_failed", {"ns": ns, "error": str(ex)}, who)
                done.append({"ns": ns, "error": str(ex)})
        if changed:
            _write_sched(entries)
    for d in done:
        _set_state_resume_at(d["ns"], None)
    return done


def status(ns: str) -> dict:
    """Compact runner status for the status bar."""
    _check_ns(ns)
    st = read_json(paths.state_path(ns), default=None) or {}
    r = st.get("runner") or {}
    alive = runner_alive(ns)
    s = r.get("status") or "idle"
    if s in ("running", "stopping") and not alive:
        s = "stopped"  # the process died without updating state.json
    batch = r.get("batch") or {}
    sched = scheduled(ns)
    return {
        "ns": ns, "status": s, "alive": alive, "stage": r.get("stage"), "unit": r.get("unit"),
        "workers": r.get("workers"), "done": batch.get("done"), "planned": batch.get("planned"),
        "rate_limited_until": r.get("rate_limited_until"), "sleep_prevented": r.get("sleep_prevented"),
        "heartbeat_at": r.get("heartbeat_at"), "message": r.get("message"),
        "resume_at": (sched or {}).get("at") or st.get("resume_at"), "updated_at": st.get("updated_at"),
    }


if __name__ == "__main__":  # tiny manual probe: python -m console.core.runner_ctl mock
    print(status(sys.argv[1] if len(sys.argv) > 1 else "mock"))
