"""Shared adapter types (contract §5): every adapter exposes

    run_session(ws, prompt, *, resume=None, unit, limits, on_event) -> SessionResult

`ws` is a `harness.workspace.Workspace` (uses .root, .cfg, .ticket, .V, .S, .service_prefix, .worker_dir).
`unit` is the units.json entry plus its name under key "name". `on_event(ev)` is called for every normalized
AgentEvent as it is produced: {"ts", "session", "kind": text|tool_call|tool_result|final, ...}.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

GEN_LIMITS = {"max_turns": 30, "wall_clock_s": 600}
FIX_LIMITS = {"max_turns": 15, "wall_clock_s": 360}

INFRA_KINDS = ("rate_limited", "api_error", "cli_crash", "isolation_breach", "timeout", "sandbox_unavailable")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class Limits:
    session: str                 # "gen" | "fix1" | "fix2" | "fix3"
    max_turns: int
    wall_clock_s: int

    @classmethod
    def for_session(cls, session: str) -> "Limits":
        lim = GEN_LIMITS if session == "gen" else FIX_LIMITS
        return cls(session, lim["max_turns"], lim["wall_clock_s"])


@dataclass
class SessionResult:
    session: str
    session_id: str | None = None
    events: list = field(default_factory=list)          # AgentEvents of this session
    num_turns: int = 0
    duration_ms: int = 0
    usage: dict = field(default_factory=dict)           # input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens
    cost_usd: float | None = None
    subtype: str | None = None
    is_error: bool | None = None
    capped: bool = False
    turn_cap: str | None = None                          # "max-turns" | "wall-clock-only" | None
    final_text: str | None = None
    infra: dict | None = None                            # {"kind": INFRA_KINDS, "detail": str, "reset_at": iso|None}
    model_reported: str | None = None
    cli_version: str | None = None
    isolation: dict | None = None                        # from system/init
    started_at: str | None = None
    ended_at: str | None = None
    usage_extra: dict | None = None                      # adapter-specific raw counters (agy: thinking/total tokens)

    def record_entry(self) -> dict:
        """The `sessions[]` item of record.json."""
        u = self.usage or {}
        return {
            "kind": self.session, "session_id": self.session_id, "num_turns": int(self.num_turns or 0),
            "duration_ms": int(self.duration_ms or 0),
            "usage": {k: int(u.get(k) or 0) for k in ("input_tokens", "output_tokens",
                                                       "cache_read_input_tokens", "cache_creation_input_tokens")},
            "cost_usd_nominal": self.cost_usd, "subtype": self.subtype, "is_error": self.is_error,
            "capped": bool(self.capped), "turn_cap": self.turn_cap,
            "started_at": self.started_at, "ended_at": self.ended_at,
            **({"usage_extra": dict(self.usage_extra)} if self.usage_extra else {}),
        }


def event(session: str, kind: str, **fields) -> dict:
    ev = {"ts": fields.pop("ts", None) or now_iso(), "session": session, "kind": kind}
    ev.update(fields)
    return ev


def load_adapter(adapter_name: str):
    import importlib
    return importlib.import_module(f"harness.adapters.{adapter_name}")
