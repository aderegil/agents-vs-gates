"""AISDLC-Trace 2.1 -> replay.json (spec 22.5.1; contract docs/contracts/replay.schema.json).

    python -m replay.export <trace.jsonl> --out <dir>      ->  <dir>/replay.json

`build_replay(events)` is pure and deterministic: it reads nothing but the events it is given, never calls a model
and never invents text. Every `text` in a step is copied from the trace (tool input/output summaries, message
content, thought summaries, CI output excerpts, oracle messages, narration); the only composed strings are joins of
trace fields ("Read · src/core/events.ts") and the marker labels, which are deterministic templates over trace fields.

Time: `t_real_ms` = ms since SESSION_STARTED. `t_ms` = the same timeline with every gap > 3 s between consecutive
events compressed to 1.5 s (spec 22.5). `meta.duration_ms` adds the final `visual.hold_ms`, if any.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

SCHEMA = "replay/1"
EXPORTER_VERSION = 1
GAP_THRESHOLD_MS = 3000
GAP_COMPRESSED_MS = 1500
TEXT_MAX = 600

LEGEND_MOCK = "SIMULATED (mock agent) — not a real run"
LEGEND_REAL = "Replay of a real run"

# The AI-SDLC Office (spec 22.5 item 2). x/y are normalized positions on the aerial map.
PLACES: list[dict] = [
    {"id": "product-desk", "label": "Product desk", "kind": "desk", "x": 0.10, "y": 0.20, "note": "discovery"},
    {"id": "planning-room", "label": "Planning room", "kind": "room", "x": 0.30, "y": 0.20, "note": "planning"},
    {"id": "architecture-library", "label": "Architecture library", "kind": "library", "x": 0.52, "y": 0.18,
     "note": "ARCH-n rules, catalog, ADRs"},
    {"id": "dispatch", "label": "Dispatch board", "kind": "system", "x": 0.80, "y": 0.18, "note": "flow engine"},
    {"id": "desk-orders", "label": "Checkout · orders", "kind": "desk", "x": 0.10, "y": 0.55,
     "note": "orders-service"},
    {"id": "desk-billing", "label": "Finance · billing", "kind": "desk", "x": 0.10, "y": 0.84,
     "note": "billing-service"},
    {"id": "desk-analytics", "label": "Data · analytics", "kind": "desk", "x": 0.30, "y": 0.84,
     "note": "analytics-ingest"},
    {"id": "desk-storefront", "label": "Digital · storefront", "kind": "desk", "x": 0.50, "y": 0.84,
     "note": "web-storefront"},
    {"id": "review-table", "label": "Review table", "kind": "room", "x": 0.36, "y": 0.53, "note": "pull request"},
    {"id": "ci-tower", "label": "CI Tower", "kind": "system", "x": 0.60, "y": 0.50, "note": "one light per check"},
    {"id": "merge-gate", "label": "Merge gate", "kind": "gate", "x": 0.84, "y": 0.50, "note": "merge"},
    {"id": "staging-bench", "label": "Staging bench", "kind": "stage", "x": 0.80, "y": 0.84,
     "note": "hidden from the agent"},
]
PLACE_IDS = {p["id"] for p in PLACES}

ROLE_HOME = {
    "flow_engine": "dispatch", "ci": "ci-tower", "staging": "staging-bench", "architect": "architecture-library",
    "originator": "product-desk", "product_owner": "product-desk", "requirements_agent": "product-desk",
    "task_planner": "planning-room", "engineer": "planning-room", "tech_lead": "planning-room",
    "researcher": "planning-room", "supervisor": "planning-room", "policy_owner": "planning-room",
    "review_agent": "review-table", "code_owner": "review-table", "verifier": "review-table",
    "code_simplifier": "review-table",
    "devops_agent": "merge-gate", "release_manager": "merge-gate", "monitoring_agent": "staging-bench",
}
REPO_DESKS = (("orders", "desk-orders"), ("billing", "desk-billing"), ("analytics", "desk-analytics"),
              ("storefront", "desk-storefront"), ("web", "desk-storefront"))


def model_badge(model: str | None) -> str | None:
    """Short display name for an agent's model: "claude-sonnet-4-5" -> "Sonnet", "mock" -> "Mock"."""
    if not model:
        return None
    m = model.lower()
    for key, label in (("mock", "Mock"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku"),
                       ("fable", "Fable"), ("codex", "Codex"), ("gpt", "GPT"), ("gemini", "Gemini")):
        if key in m:
            return label
    head = model.replace("_", "-").split("-")[0]
    return head[:1].upper() + head[1:12]


def _ms(ts: str) -> int:
    return int(round(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000))


def _clip(s, n: int = TEXT_MAX):
    if s is None:
        return None
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def trace_sha256(events: list[dict]) -> str:
    """sha256 over the canonical JSONL of the events (sorted keys, compact), so it does not depend on file bytes."""
    h = hashlib.sha256()
    for e in events:
        h.update(json.dumps(e, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def compress_times(timestamps_ms: list[int]) -> list[int]:
    """Gaps > 3 s between consecutive events become 1.5 s; returns compressed offsets starting at 0."""
    out: list[int] = []
    t = 0
    for i, ts in enumerate(timestamps_ms):
        if i:
            gap = max(0, ts - timestamps_ms[i - 1])
            t += GAP_COMPRESSED_MS if gap > GAP_THRESHOLD_MS else gap
        out.append(t)
    return out


def _home_for(entry: dict) -> str:
    role = entry.get("role")
    if role == "code_agent":
        key = f"{entry.get('actor_id', '')} {entry.get('display_name', '')}".lower()
        for needle, desk in REPO_DESKS:
            if needle in key:
                return desk
        return "desk-orders"
    return ROLE_HOME.get(role, "planning-room")


def _actor(entry: dict, default_model: str | None) -> dict:
    atype = entry.get("actor_type", "agent")
    badge = None
    if atype == "agent":
        badge = model_badge(entry.get("model") or default_model)
    out = {
        "id": entry["actor_id"],
        "role": entry.get("role", "unknown"),
        "actor_type": atype,
        "display_name": entry.get("display_name") or entry["actor_id"],
        "avatar": {"style": atype, "seed": entry["actor_id"], "badge": badge},
        "home": _home_for(entry),
    }
    if entry.get("simulated"):
        out["simulated"] = True
    return out


def _check_status(ok: bool) -> str:
    return "pass" if ok else "fail"


def build_replay(events: list[dict]) -> dict:
    """Pure: events (one AISDLC-Trace 2.1 file, in order) -> replay dict valid against replay.schema.json."""
    events = sorted(events, key=lambda e: e.get("seq", 0))
    if not events or events[0].get("event_type") != "SESSION_STARTED":
        raise ValueError("trace must start with SESSION_STARTED")
    start = events[0]
    md = start.get("metadata") or {}
    sp = start.get("payload") or {}
    end = next((e for e in reversed(events) if e.get("event_type") == "SESSION_ENDED"), None)
    stats = ((end or {}).get("payload") or {}).get("stats") or {}

    source = "mock" if md.get("source") == "mock" else "real"
    model = md.get("model")

    # Actors: roster first (in order), then anyone else that emits events.
    actors: list[dict] = []
    seen: set[str] = set()
    for entry in sp.get("roster") or []:
        if entry.get("actor_id") and entry["actor_id"] not in seen:
            actors.append(_actor(entry, model))
            seen.add(entry["actor_id"])
    for e in events:
        a = e.get("actor") or {}
        if a.get("actor_id") and a["actor_id"] not in seen:
            actors.append(_actor({**a, "display_name": a.get("display_name") or a["actor_id"]}, model))
            seen.add(a["actor_id"])
    by_id = {a["id"]: a for a in actors}
    location = {a["id"]: a["home"] for a in actors}

    ts = [_ms(e["timestamp"]) for e in events]
    t0 = ts[0]
    comp = compress_times(ts)

    # Oracle groups (for marker labels): state -> (fails, total), computed from the trace.
    oracle_groups: dict[str, list[int]] = {}
    ci_ok_by_attempt: dict[int, bool] = {}
    for e in events:
        p = e.get("payload") or {}
        if e.get("event_type") == "ORACLE_RESULT":
            g = oracle_groups.setdefault(p.get("state", "final"), [0, 0])
            g[1] += 1
            g[0] += 0 if p.get("ok") else 1
        elif e.get("event_type") == "CI_RUN_COMPLETED":
            ci_ok_by_attempt[int(p.get("run_attempt", 0))] = bool(p.get("ok"))
    last_ci_ok = ci_ok_by_attempt[max(ci_ok_by_attempt)] if ci_ok_by_attempt else None

    steps: list[dict] = []
    markers: list[dict] = []
    oracle_marked: set[str] = set()
    repairs = 0

    for i, e in enumerate(events):
        et = e.get("event_type")
        p = e.get("payload") or {}
        actor = (e.get("actor") or {}).get("actor_id", "flow-engine")
        visual = e.get("visual") or {}
        narration = _clip(visual.get("narration"), 280)
        inter = e.get("interaction") or {}
        base = {"t_ms": comp[i], "t_real_ms": max(0, ts[i] - t0), "seq": int(e.get("seq", i)), "actor": actor}

        def step(action: str, *, text=None, target=None, place=None, key=None, check=None, detail=None,
                 narr=narration, actor_id=None):
            s = dict(base)
            if actor_id:
                s["actor"] = actor_id
            s.update({"action": action, "target": target,
                      "place": place if place is not None else location.get(s["actor"]),
                      "text": _clip(text), "key": key, "narration": narr})
            if check is not None:
                s["check"] = check
            d = {"event_type": et, "event_id": e.get("event_id"), "phase": e.get("phase")}
            if detail:
                d.update(detail)
            s["detail"] = d
            steps.append(s)
            return s

        def move(actor_id: str, place: str):
            if place in PLACE_IDS and location.get(actor_id) != place and \
                    by_id.get(actor_id, {}).get("actor_type") != "system":
                location[actor_id] = place
                step("move", place=place, actor_id=actor_id, narr=None, target=None)

        def marker(kind: str, label: str):
            markers.append({"t_ms": comp[i], "label": _clip(label, 120), "kind": kind})

        if et == "SESSION_STARTED":
            cond = md.get("condition") or {}
            cond_s = "·".join(str(cond[k]) for k in ("V", "S", "W") if cond.get(k))
            step("phase", text=p.get("title"), detail={"to_phase": p.get("initial_phase"),
                                                         "scenario": p.get("scenario"), "condition": cond_s})
        elif et == "TASK_ASSIGNED":
            target = p.get("assignee_id") or inter.get("target_actor_id")
            step("assign", text=p.get("title"), target=target, key="task_assigned",
                 detail={"task_id": e.get("task_id")})
            marker("task_assigned", f"Task assigned{': ' + md['ticket'] if md.get('ticket') else ''}")
        elif et == "ARTIFACT_CREATED":
            if p.get("artifact_type") == "pull_request":
                move(actor, "review-table")
                step("handoff", text=" · ".join(x for x in (p.get("path"), p.get("summary")) if x),
                     target="review-table", key="pr_opened",
                     detail={"artifact_id": p.get("artifact_id"), "diff": p.get("diff")})
                marker("pr_opened", f"PR opened{' · ' + p['summary'] if p.get('summary') else ''}")
            else:
                step("work", text=" · ".join(x for x in (p.get("path"), p.get("summary")) if x),
                     detail={"artifact_id": p.get("artifact_id"), "artifact_type": p.get("artifact_type")})
        elif et == "ARTIFACT_UPDATED":
            is_pr = str(p.get("path", "")).startswith("PR ") or p.get("artifact_id") == "art-pr"
            if is_pr:
                repairs += 1
                move(actor, "review-table")
                step("handoff", text=" · ".join(x for x in (p.get("path"), p.get("change_summary")) if x),
                     target="review-table", key="repair",
                     detail={"artifact_id": p.get("artifact_id"), "version": p.get("version"),
                             "diff": p.get("diff")})
                marker("repair", f"Repair {repairs} pushed · {p.get('change_summary', '')}".rstrip(" ·"))
            else:
                step("work", text=" · ".join(x for x in (p.get("path"), p.get("change_summary")) if x),
                     detail={"artifact_id": p.get("artifact_id"), "version": p.get("version")})
        elif et == "ARTIFACT_READ":
            step("work", text=" · ".join(x for x in (p.get("path"), p.get("purpose")) if x),
                 detail={"artifact_id": p.get("artifact_id")})
        elif et == "ACTOR_STATE_CHANGED":
            if p.get("thought_summary"):
                step("speak", text=p["thought_summary"], detail={"to_state": p.get("to_state"), "thought": True})
        elif et == "TOOL_CALL_STARTED":
            step("work", text=" · ".join(x for x in (p.get("tool_name"), p.get("input_summary")) if x),
                 detail={"tool_name": p.get("tool_name"), "input_summary": p.get("input_summary"),
                         "correlation_id": e.get("correlation_id")})
        elif et == "TOOL_CALL_COMPLETED":
            step("work", text=p.get("output_summary") or f"{p.get('tool_name')} · {p.get('status')}",
                 detail={"tool_name": p.get("tool_name"), "status": p.get("status"),
                         "output_summary": p.get("output_summary"), "correlation_id": e.get("correlation_id")})
        elif et == "MESSAGE_EXCHANGED":
            target = inter.get("target_actor_id")
            itype = inter.get("interaction_type")
            step("speak", text=p.get("content"), target=target,
                 detail={"interaction_type": itype, "content": p.get("content")})
            if itype == "feedback_request" and target in by_id:
                move(target, by_id[target]["home"])
        elif et == "PHASE_CHANGED":
            step("phase", text=p.get("reason"), detail={"from_phase": p.get("from_phase"),
                                                        "to_phase": p.get("to_phase")})
        elif et == "CI_RUN_STARTED":
            step("check", text=None, place="ci-tower", detail={"run_attempt": p.get("run_attempt"),
                                                               "subject_artifact_id": p.get("subject_artifact_id")})
        elif et == "CHECK_COMPLETED":
            step("check", text=p.get("output_excerpt"), place="ci-tower",
                 check={"id": p.get("check_id"), "status": p.get("status"), "rule": p.get("rule_id")},
                 detail={"category": p.get("category"), "duration_ms": p.get("duration_ms"),
                         "output": p.get("output_excerpt")})
        elif et == "CI_RUN_COMPLETED":
            ok = bool(p.get("ok"))
            failed = list(p.get("failed_checks") or [])
            label = "CI passed" if ok else f"CI failed: {', '.join(failed)}" if failed else "CI failed"
            step("ci_result", text=narration or label, place="ci-tower", key="ci_pass" if ok else "ci_fail",
                 check={"id": f"attempt-{p.get('run_attempt', 0)}", "status": _check_status(ok), "rule": None},
                 detail={"run_attempt": p.get("run_attempt"), "ok": ok, "failed_checks": failed})
            marker("ci_pass" if ok else "ci_fail", label)
        elif et == "GATE_TOUCHED":
            move(actor, "ci-tower")
            text = " · ".join(x for x in (p.get("detector"), p.get("path"), p.get("change_summary")) if x)
            step("gate_touch", text=text, place="ci-tower", key="gate_touched",
                 detail={"detector": p.get("detector"), "path": p.get("path"),
                         "change_summary": p.get("change_summary"),
                         "detected_by": (e.get("metadata") or {}).get("detected_by")})
            marker("gate_touched", f"Gate touched: {p.get('detector')} {p.get('path')}")
        elif et == "ORACLE_RESULT":
            ok = bool(p.get("ok"))
            state = p.get("state", "final")
            text = f"{p.get('consumer')} ({state}): {p.get('message') or ('ok' if ok else 'fail')}"
            step("oracle", text=text, place="staging-bench", key="oracle" if state not in oracle_marked else None,
                 check={"id": str(p.get("consumer")), "status": _check_status(ok), "rule": None},
                 detail={"consumer": p.get("consumer"), "state": state, "ok": ok, "message": p.get("message"),
                         "hidden_from_agent": True,
                         "contradicts_ci": (last_ci_ok is True and not ok)})
            if state not in oracle_marked:
                oracle_marked.add(state)
                fails, total = oracle_groups.get(state, [0, 0])
                marker("oracle", f"Oracle ({state}): {fails} of {total} consumers fail" if fails
                       else f"Oracle ({state}): all {total} consumers pass")
        elif et == "SESSION_ENDED":
            step("phase", text=p.get("summary"), key="session_end",
                 detail={"outcome": p.get("outcome"), "stats": stats})
            marker("session_end", f"End: {stats.get('run_outcome') or p.get('outcome')}"
                   + (f" · ticket {stats['ticket_done'].replace('_', ' ')}" if stats.get("ticket_done") else ""))
        elif et == "REVIEW_SUBMITTED":
            step("speak", text=p.get("summary"), target=inter.get("target_actor_id"),
                 detail={"decision": p.get("decision"), "subject_artifact_id": p.get("subject_artifact_id")})
        elif et == "APPROVAL_REQUESTED":
            step("handoff", text=p.get("question"), target=inter.get("target_actor_id"),
                 detail={"gate": p.get("gate"), "request_id": p.get("request_id")})
        elif et == "APPROVAL_DECIDED":
            step("speak", text=" · ".join(x for x in (p.get("decision"), p.get("rationale") or p.get("comment"))
                                          if x), detail={"request_id": p.get("request_id"),
                                                         "decision": p.get("decision")})
        elif et == "ERROR_RAISED":
            step("speak", text=p.get("message"), detail={"error_code": p.get("error_code"),
                                                         "recoverable": p.get("recoverable")})
        elif et == "ACTOR_JOINED":
            step("phase", text=p.get("display_name"), detail={})
        # Unknown event types are skipped: the replay shows only what it can render faithfully.

    hold = int(((end or {}).get("visual") or {}).get("hold_ms") or 0)
    duration = (steps[-1]["t_ms"] if steps else 0) + hold
    started = start["timestamp"]
    meta = {
        "run_id": start.get("run_id") or md.get("run_id") or start.get("session_id"),
        "source": source,
        "unit": md.get("unit") or "unknown",
        "model": model,
        "date": started[:10],
        "started_at": started,
        "ticket": md.get("ticket"),
        "condition": {k: v for k, v in (md.get("condition") or {}).items() if k in ("V", "S", "W")},
        "outcome": stats.get("run_outcome"),
        "ticket_done": stats.get("ticket_done"),
        "session_outcome": ((end or {}).get("payload") or {}).get("outcome"),
        "stage": md.get("stage"),
        "title": sp.get("title"),
        "scenario": sp.get("scenario"),
        "trace_sha256": trace_sha256(events),
        "schema": SCHEMA,
        "exporter_version": EXPORTER_VERSION,
        "legend": LEGEND_MOCK if source == "mock" else LEGEND_REAL,
        "duration_ms": duration,
        "duration_real_ms": max(0, ts[-1] - t0),
        "event_count": len(events),
    }
    return {"meta": meta, "places": [dict(p) for p in PLACES], "actors": actors, "steps": steps,
            "markers": markers}


def read_trace(path: Path) -> list[dict]:
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def export(trace_path: Path, out_dir: Path) -> Path:
    replay = build_replay(read_trace(trace_path))
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / "replay.json"
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        json.dump(replay, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return target


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m replay.export", description=__doc__.splitlines()[0])
    ap.add_argument("trace", type=Path, help="AISDLC-Trace 2.1 JSONL file")
    ap.add_argument("--out", type=Path, required=True, help="output directory (replay.json is written there)")
    args = ap.parse_args(argv)
    if not args.trace.is_file():
        print(f"trace not found: {args.trace}", file=sys.stderr)
        return 2
    try:
        target = export(args.trace, args.out)
    except (ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"cannot export {args.trace}: {exc}", file=sys.stderr)
        return 1
    with open(target, encoding="utf-8") as f:
        r = json.load(f)
    m = r["meta"]
    print(f"{target}  run={m['run_id']} source={m['source']} steps={len(r['steps'])} markers={len(r['markers'])} "
          f"duration={m['duration_ms'] / 1000:.1f}s (real {m['duration_real_ms'] / 1000:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
