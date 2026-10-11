"""Replay Theater API (docs/contracts/console-api.md §2; spec 22.5).

GET /api/replay/list           runs of the namespace with an events.jsonl: run_id, stage, ticket, condition, source,
                               date, and outcome only when harness.blinding says the stage is visible
GET /api/replay/run/{run_id}   the run's replay.json (built with replay.export.build_replay, cached in the run folder
                               keyed by the trace sha); 404 without a trace, 403 while the stage is blinded

The theater itself is static (web/dist); this API only reads files. No model calls, no keys.
"""
from __future__ import annotations

try:  # the shell (WP3) provides these; the fallback keeps the handlers importable and testable on their own
    from console.core.plugin_api import ApiError
except ImportError:  # pragma: no cover - exercised only before the shell exists
    class ApiError(Exception):  # type: ignore[no-redef]
        def __init__(self, status: int, message: str):
            super().__init__(message)
            self.status = status
            self.message = message

from replay.service import ReplayBlinded, ReplayNotFound, check_ns, list_replayable, load_run_replay


def register(router, ctx) -> None:
    router.get("/list", list_runs)
    router.get("/run/{run_id}", get_run)


def _ns(req) -> str:
    try:
        return check_ns(getattr(req, "ns", None) or (getattr(req, "query", None) or {}).get("ns"))
    except ValueError as exc:
        raise ApiError(400, str(exc)) from exc


def list_runs(req):
    ns = _ns(req)
    return {"ns": ns, "runs": list_replayable(ns)}


def get_run(req):
    ns = _ns(req)
    run_id = (getattr(req, "params", None) or {}).get("run_id", "")
    try:
        return load_run_replay(ns, run_id)
    except ReplayNotFound as exc:
        raise ApiError(404, str(exc)) from exc
    except ReplayBlinded as exc:
        raise ApiError(403, str(exc)) from exc
    except ValueError as exc:
        raise ApiError(422, f"cannot build the replay of {run_id}: {exc}") from exc
