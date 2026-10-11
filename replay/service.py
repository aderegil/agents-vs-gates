"""Replay lookup for the console (Replay Theater plugin; the Run Explorer's /api/runs/{id}/replay delegates here).

    from replay.service import list_replayable, load_run_replay

Reads only `results/<ns>/runs/<run_id>/{events.jsonl,record.json}` (via harness.paths) and `state.json` for
blinding. A run whose stage is still blinded is listed without its outcome and is not replayed: a replay shows CI
verdicts and oracle results, which are outcomes (spec 11.4, 21.5, 22.3).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from harness import blinding, paths
from harness.jsonio import read_json, read_jsonl, write_json_atomic
from replay.export import EXPORTER_VERSION, build_replay, trace_sha256

RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class ReplayNotFound(LookupError):
    pass


class ReplayBlinded(PermissionError):
    pass


def check_ns(ns: str | None) -> str:
    ns = ns or "mock"
    if ns not in paths.NAMESPACES:
        raise ValueError(f"unknown namespace {ns!r}")
    return ns


def _first_event(trace: Path) -> dict:
    try:
        with open(trace, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    return json.loads(line)
    except (OSError, ValueError):
        pass
    return {}


def _run_meta(run_dir: Path) -> dict:
    """run_id, stage, ticket, condition, source, unit, date, outcome — from record.json, else from the trace."""
    rec = read_json(run_dir / "record.json") or {}
    first = {} if rec else _first_event(run_dir / "events.jsonl")
    md = first.get("metadata") or {}
    if rec:
        cond = {k: rec.get(f) for k, f in (("V", "visibility"), ("S", "spec"), ("W", "wording")) if rec.get(f)}
        source = "mock" if rec.get("namespace") == "mock" or rec.get("adapter") == "mock" else "real"
        date = (rec.get("started_at") or "")[:10]
    else:
        cond = {k: v for k, v in (md.get("condition") or {}).items() if k in ("V", "S", "W")}
        source = "mock" if md.get("source") == "mock" else "real"
        date = (first.get("timestamp") or "")[:10]
    return {
        "run_id": run_dir.name,
        "stage": rec.get("stage") or md.get("stage"),
        "ticket": rec.get("ticket") or md.get("ticket"),
        "condition": cond,
        "source": source,
        "unit": rec.get("unit") or md.get("unit"),
        "date": date or None,
        "outcome": rec.get("outcome") if rec else None,
    }


def list_replayable(ns: str) -> list[dict]:
    """Runs of the namespace that have an events.jsonl; outcome only when the stage is visible."""
    ns = check_ns(ns)
    root = paths.runs_dir(ns)
    if not root.is_dir():
        return []
    state = read_json(paths.state_path(ns)) or {}
    out = []
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        if not (d / "events.jsonl").is_file() or not RUN_ID.match(d.name):
            continue
        m = _run_meta(d)
        visible = blinding.is_visible(state, m["stage"])
        if not visible:
            m["outcome"] = None
        m["blinded"] = not visible
        m["cached"] = (d / "replay.json").is_file()
        out.append(m)
    return out


def load_run_replay(ns: str, run_id: str, *, cache: bool = True) -> dict:
    """The run's replay.json, built from its trace with build_replay and cached in the run folder.

    The cache is valid while its meta.trace_sha256 and meta.exporter_version match the current trace and exporter.
    Raises ReplayNotFound (no such run / no trace), ReplayBlinded (stage still blinded), ValueError (bad trace).
    """
    ns = check_ns(ns)
    if not RUN_ID.match(run_id or ""):
        raise ReplayNotFound(f"invalid run id {run_id!r}")
    run_dir = paths.run_dir(ns, run_id)
    trace = run_dir / "events.jsonl"
    if not trace.is_file():
        raise ReplayNotFound(f"run {run_id} has no trace (events.jsonl) in {ns}")
    events = read_jsonl(trace)
    if not events:
        raise ReplayNotFound(f"run {run_id}: events.jsonl is empty")
    stage = _run_meta(run_dir)["stage"] or (events[0].get("metadata") or {}).get("stage")
    state = read_json(paths.state_path(ns)) or {}
    if not blinding.is_visible(state, stage):
        raise ReplayBlinded(f"stage {stage} is blinded; its replays open after it is unblinded")
    sha = trace_sha256(events)
    target = run_dir / "replay.json"
    cached = read_json(target) if cache else None
    meta = (cached or {}).get("meta") or {}
    if cached and meta.get("trace_sha256") == sha and meta.get("exporter_version") == EXPORTER_VERSION:
        return cached
    replay = build_replay(events)
    if cache:
        try:
            write_json_atomic(target, replay)
        except OSError:
            pass  # read-only results folder: serve without caching
    return replay
