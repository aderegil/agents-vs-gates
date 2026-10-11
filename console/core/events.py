"""Event bus, SSE formatting and the watcher that turns runner files into live events (spec §21.5, contract §3).

Topics: runner.progress, runner.run_started, runner.run_finished (outcome only when the stage is visible),
runner.stopped, runner.rate_limited, audit.new (owners only), plus whatever plugins publish with ctx.publish.
"""
from __future__ import annotations

import json
import os
import queue
import threading
import time
from pathlib import Path

from harness import blinding, paths
from harness.jsonio import read_json

from .sanitize import sanitize_text

MAX_QUEUE = 500


def sse_format(topic: str, data: dict, event_id: int | None = None) -> bytes:
    """One SSE frame: `event: <topic>\\ndata: <json>\\n\\n` (JSON on a single line)."""
    payload = sanitize_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    lines = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {topic}")
    lines.append(f"data: {payload}")
    return ("\n".join(lines) + "\n\n").encode("utf-8")


def sse_comment(text: str = "keep-alive") -> bytes:
    return f": {text}\n\n".encode("utf-8")


class Subscriber:
    def __init__(self, role: str | None):
        self.role = role
        self.q: queue.Queue = queue.Queue(maxsize=MAX_QUEUE)
        self.dropped = 0


class EventBus:
    def __init__(self):
        self.subs: set[Subscriber] = set()
        self.lock = threading.Lock()
        self.seq = 0

    def subscribe(self, role: str | None) -> Subscriber:
        s = Subscriber(role)
        with self.lock:
            self.subs.add(s)
        return s

    def unsubscribe(self, s: Subscriber) -> None:
        with self.lock:
            self.subs.discard(s)

    def publish(self, topic: str, data: dict, ns: str | None = None, roles: tuple | None = None) -> int:
        data = dict(data or {})
        if ns is not None:
            data["ns"] = ns
        elif "ns" not in data:
            data["ns"] = None
        with self.lock:
            self.seq += 1
            seq = self.seq
            subs = list(self.subs)
        for s in subs:
            if roles and s.role not in roles:
                continue
            try:
                s.q.put_nowait((seq, topic, data))
            except queue.Full:
                s.dropped += 1
        return seq


# ---------------------------------------------------------------- watcher

def _counts(state: dict) -> dict:
    c = {"pending": 0, "running": 0, "done": 0, "infra_failure": 0, "infra_failure_final": 0}
    for r in (state.get("runs") or {}).values():
        s = (r or {}).get("status")
        if s in c:
            c[s] += 1
    c["total"] = sum(c.values())
    return c


def progress_payload(state: dict, extra: dict | None = None) -> dict:
    """The whole state.runner + state.workers + counts (no outcomes exist in state.json)."""
    out = {
        "runner": state.get("runner") or {},
        "workers": state.get("workers") or {},
        "counts": _counts(state),
        "resume_at": state.get("resume_at"),
        "updated_at": state.get("updated_at"),
    }
    if extra:
        out.update(extra)
    return out


def _stage_of(ns: str, run_id: str, state: dict) -> str | None:
    rec = read_json(paths.run_dir(ns, run_id) / "record.json", default=None)
    if isinstance(rec, dict) and rec.get("stage"):
        return rec["stage"]
    if run_id.startswith("st-"):
        return "selftest"
    if len(run_id) > 2 and run_id[0] == "p" and run_id[1].isdigit():
        return "P" + run_id[1]
    return None


def finished_payload(ns: str, ev: dict, state: dict) -> dict:
    run_id = str(ev.get("run_id", ""))
    out = {k: ev.get(k) for k in ("run_id", "turns", "duration_ms", "tokens")}
    stage = _stage_of(ns, run_id, state) if run_id else None
    out["stage"] = stage
    if stage and blinding.is_visible(state, stage):
        rec = read_json(paths.run_dir(ns, run_id) / "record.json", default=None) or {}
        out["outcome"] = rec.get("outcome")
    return out


class Watcher(threading.Thread):
    """Every `interval` s: read state.json + tail runner.log.jsonl for both namespaces; run the resume scheduler."""

    def __init__(self, bus: EventBus, interval: float = 1.0, scheduler=None):
        super().__init__(name="avg-watcher", daemon=True)
        self.bus = bus
        self.interval = interval
        self.scheduler = scheduler
        self.stop_event = threading.Event()
        self.last_state_sig: dict[str, tuple] = {}
        self.last_progress_at: dict[str, float] = {}
        self.log_pos: dict[str, int] = {}
        self.log_id: dict[str, tuple] = {}
        self.last_status: dict[str, str | None] = {}
        self.primed = False

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001 — the watcher must never die
                pass
            self.stop_event.wait(self.interval)

    def stop(self) -> None:
        self.stop_event.set()

    def tick(self) -> None:
        for ns in paths.NAMESPACES:
            state = read_json(paths.state_path(ns), default=None)
            state = state if isinstance(state, dict) else {}
            self._progress(ns, state)
            self._tail_log(ns, state)
        self.primed = True
        if self.scheduler:
            try:
                self.scheduler()
            except Exception:  # noqa: BLE001
                pass

    def _progress(self, ns: str, state: dict) -> None:
        if not state:
            return
        sig = (state.get("updated_at"), json.dumps(state.get("runner"), sort_keys=True),
               json.dumps(state.get("workers"), sort_keys=True), state.get("resume_at"))
        if self.last_state_sig.get(ns) == sig:
            return
        now = time.monotonic()
        if now - self.last_progress_at.get(ns, 0) < 1.0:
            return  # at most 1/s; the next tick picks up the newest state
        self.last_state_sig[ns] = sig
        self.last_progress_at[ns] = now
        self.bus.publish("runner.progress", progress_payload(state), ns=ns)

    def _tail_log(self, ns: str, state: dict) -> None:
        p = paths.runner_log_path(ns)
        try:
            st = os.stat(p)
        except OSError:
            self.log_pos[ns] = 0
            return
        ident = (getattr(st, "st_ino", 0), getattr(st, "st_ctime_ns", 0))
        pos = self.log_pos.get(ns)
        if pos is None or not self.primed:
            # Start at the end: history is not replayed as live events.
            self.log_pos[ns] = st.st_size
            self.log_id[ns] = ident
            return
        if st.st_size < pos or self.log_id.get(ns, ident) != ident:
            pos = 0  # rewritten or rotated
        self.log_id[ns] = ident
        if st.st_size == pos:
            return
        with open(p, "rb") as f:
            f.seek(pos)
            chunk = f.read()
        last_nl = chunk.rfind(b"\n")
        if last_nl < 0:
            return  # partial line; wait for the newline
        self.log_pos[ns] = pos + last_nl + 1
        for line in chunk[: last_nl + 1].splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                continue
            self._log_event(ns, ev, state)

    def _log_event(self, ns: str, ev: dict, state: dict) -> None:
        kind = ev.get("event")
        if kind == "run_started":
            self.bus.publish("runner.run_started", {k: ev.get(k) for k in ("run_id", "worker", "ticket", "cell")}, ns=ns)
        elif kind == "run_finished":
            if not state:
                state = read_json(paths.state_path(ns), default=None) or {}
            self.bus.publish("runner.run_finished", finished_payload(ns, ev, state), ns=ns)
        elif kind == "stopped":
            self.bus.publish("runner.stopped", {k: v for k, v in ev.items() if k in ("ts", "reason", "message")}, ns=ns)
        elif kind == "rate_limited":
            until = ev.get("until") or ((state.get("runner") or {}).get("rate_limited_until") if state else None)
            self.bus.publish("runner.rate_limited", {"until": until, "ts": ev.get("ts")}, ns=ns)
