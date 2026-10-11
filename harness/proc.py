"""Child processes for the agent CLIs: argv list (never a shell), prompt on stdin, stdout read line by line with a
receive timestamp, and a wall-clock cap that kills the whole process tree (spec 10.4).

On Windows the child is put in a Job Object (KILL_ON_JOB_CLOSE) right after spawn, so terminating the job also
kills grandchildren such as Git Bash; `taskkill /T /F` is the fallback.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time

from harness.adapters.base import now_iso

_WIN = sys.platform == "win32"


class _Job:
    """Minimal Windows Job Object wrapper (ctypes). All methods are no-ops if anything fails."""

    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    JobObjectExtendedLimitInformation = 9

    def __init__(self):
        self.handle = None
        if not _WIN:
            return
        try:
            import ctypes
            from ctypes import wintypes

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateJobObjectW.restype = wintypes.HANDLE
            k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
            k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
            k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            k32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
            k32.CloseHandle.argtypes = [wintypes.HANDLE]
            k32.OpenProcess.restype = wintypes.HANDLE
            k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]

            class IO_COUNTERS(ctypes.Structure):
                _fields_ = [(n, ctypes.c_ulonglong) for n in (
                    "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                    "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

            class BASIC(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                            ("PerJobUserTimeLimit", ctypes.c_longlong),
                            ("LimitFlags", wintypes.DWORD),
                            ("MinimumWorkingSetSize", ctypes.c_size_t),
                            ("MaximumWorkingSetSize", ctypes.c_size_t),
                            ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.c_size_t),
                            ("PriorityClass", wintypes.DWORD),
                            ("SchedulingClass", wintypes.DWORD)]

            class EXTENDED(ctypes.Structure):
                _fields_ = [("BasicLimitInformation", BASIC),
                            ("IoInfo", IO_COUNTERS),
                            ("ProcessMemoryLimit", ctypes.c_size_t),
                            ("JobMemoryLimit", ctypes.c_size_t),
                            ("PeakProcessMemoryUsed", ctypes.c_size_t),
                            ("PeakJobMemoryUsed", ctypes.c_size_t)]

            h = k32.CreateJobObjectW(None, None)
            if not h:
                return
            info = EXTENDED()
            info.BasicLimitInformation.LimitFlags = self.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not k32.SetInformationJobObject(h, self.JobObjectExtendedLimitInformation,
                                               ctypes.byref(info), ctypes.sizeof(info)):
                k32.CloseHandle(h)
                return
            self.k32, self.handle = k32, h
        except Exception:  # noqa: BLE001 - fall back to taskkill
            self.handle = None

    def assign(self, pid: int) -> bool:
        if not self.handle:
            return False
        PROCESS_SET_QUOTA, PROCESS_TERMINATE = 0x0100, 0x0001
        ph = self.k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
        if not ph:
            return False
        try:
            return bool(self.k32.AssignProcessToJobObject(self.handle, ph))
        finally:
            self.k32.CloseHandle(ph)

    def terminate(self) -> bool:
        return bool(self.handle and self.k32.TerminateJobObject(self.handle, 1))

    def close(self):
        if self.handle:
            self.k32.CloseHandle(self.handle)
            self.handle = None


def kill_tree(pid: int) -> None:
    """Kill a process and its descendants (taskkill on Windows)."""
    if _WIN:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


def run_streaming(argv: list[str], *, cwd, env: dict, stdin_text: str, wall_clock_s: float,
                  on_line) -> dict:
    """Run argv; feed stdin_text; call on_line(line, ts_iso) per stdout line. Returns
    {"rc", "stderr", "timed_out", "duration_ms"}. on_line may return the string "kill" to abort the process."""
    t0 = time.monotonic()
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if _WIN else 0
    p = subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, creationflags=flags)
    job = _Job()
    in_job = job.assign(p.pid)
    state = {"timed_out": False, "killed": False}
    err_chunks: list[bytes] = []

    def kill():
        if p.poll() is not None:
            return
        if not (in_job and job.terminate()):
            kill_tree(p.pid)
        try:
            p.kill()
        except OSError:
            pass

    def feed():
        try:
            p.stdin.write(stdin_text.encode("utf-8"))
            p.stdin.close()
        except OSError:
            pass

    def drain_err():
        for chunk in iter(lambda: p.stderr.read(4096), b""):
            err_chunks.append(chunk)

    def watchdog():
        if not p_done.wait(wall_clock_s):
            state["timed_out"] = True
            kill()

    p_done = threading.Event()
    threads = [threading.Thread(target=f, daemon=True) for f in (feed, drain_err, watchdog)]
    for t in threads:
        t.start()
    try:
        for raw in iter(p.stdout.readline, b""):
            ts = now_iso()
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line and on_line(line, ts) == "kill":
                state["killed"] = True
                kill()
                break
    finally:
        try:
            p.wait(timeout=30)
        except subprocess.TimeoutExpired:
            kill()
            p.wait()
        p_done.set()
        threads[1].join(timeout=5)
        for f in (p.stdout, p.stderr):
            try:
                f.close()
            except OSError:
                pass
        job.close()
    return {"rc": p.returncode, "stderr": b"".join(err_chunks).decode("utf-8", errors="replace"),
            "timed_out": state["timed_out"], "killed": state["killed"],
            "duration_ms": int((time.monotonic() - t0) * 1000)}
