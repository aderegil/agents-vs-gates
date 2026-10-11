"""AISDLC-Trace 2.1 writer for the flow, on a simulated clock (deterministic timestamps).

Every event gets its `event_id`/`seq` when it is added, so later events can point to it with `parent_event_id`.
The current phase is tracked here: `phase_change()` emits PHASE_CHANGED already carrying the new phase (the validator's
reading of rule 4).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

SCHEMA_VERSION = "2.1.0"
EPOCH = datetime(2026, 10, 12, 15, 0, 0, tzinfo=timezone.utc)   # fixed: sprint traces are reproducible


def _fmt(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def trunc(s, n: int) -> str:
    s = "" if s is None else str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


class Trace:
    def __init__(self, session_id: str, roster: list[dict], initial_phase: str = "discovery",
                 start: datetime = EPOCH):
        self.session_id = session_id
        self.actors = {r["actor_id"]: {k: r[k] for k in ("actor_id", "actor_type", "role")} for r in roster}
        self.phase = initial_phase
        self.clock = start
        self.events: list[dict] = []

    def actor(self, actor_id: str) -> dict:
        return dict(self.actors[actor_id])

    def emit(self, event_type: str, actor_id: str, payload: dict, *, dt: float = 2.0, **extra) -> str:
        if self.events:
            self.clock += timedelta(seconds=dt)
        seq = len(self.events)
        ev = {"schema_version": SCHEMA_VERSION, "event_id": f"evt-{seq:04d}", "seq": seq,
              "session_id": self.session_id, "run_id": self.session_id, "timestamp": _fmt(self.clock),
              "event_type": event_type, "phase": self.phase, "actor": self.actor(actor_id), "payload": payload}
        ev.update({k: v for k, v in extra.items() if v is not None})
        self.events.append(ev)
        return ev["event_id"]

    def phase_change(self, actor_id: str, to_phase: str, reason: str, **extra) -> str:
        frm = self.phase
        self.phase = to_phase
        return self.emit("PHASE_CHANGED", actor_id, {"from_phase": frm, "to_phase": to_phase, "reason": reason},
                         dt=1, **extra)

    def message(self, src: str, dst: str, content: str, itype: str, *, dt: float = 2.0, **extra) -> str:
        return self.emit("MESSAGE_EXCHANGED", src, {"content": trunc(content, 2000), "content_format": "markdown"},
                         interaction={"source_actor_id": src, "target_actor_id": dst, "interaction_type": itype},
                         dt=dt, **extra)

    def tool(self, actor_id: str, name: str, input_summary: str, status: str, output_summary: str,
             corr: str, *, dt: float = 3.0, **extra) -> None:
        self.emit("TOOL_CALL_STARTED", actor_id, {"tool_name": name, "protocol": "builtin",
                                                  "input_summary": trunc(input_summary, 160)},
                  correlation_id=corr, actor_state="executing_tool", dt=dt, **extra)
        self.emit("TOOL_CALL_COMPLETED", actor_id, {"tool_name": name, "status": status,
                                                    "output_summary": trunc(output_summary, 160)},
                  correlation_id=corr, actor_state="thinking" if status == "success" else "waiting_input",
                  dt=dt, **extra)
