"""AISDLC-Trace 2.1 validator (spec 13.4): JSON Schema per line + rules 1-13 over the whole file.

    python -m trace.validate <trace.jsonl> [--json]      exit 0 = valid, 1 = violations, 2 = usage

Rules 1-8 come from docs/spec-logs-ai-sdlc.md section 5; rules 9-13 from spec 13.2. Each violation is
{"seq": int|None, "rule": "schema"|1..13, "message": str}. `seq` is the offending event's seq (its line index if
the event has no integer seq); None for file-level problems (unparseable lines).

Operational readings (decided 2026-10-10):
- Rule 2: timestamps must be ISO-8601 with a zone (Z or +hh:mm). jsonschema's `date-time` format needs an extra
  package, so the zone check is done here and reported as rule 2. A seq gap is reported once, on the event where
  it occurs.
- Rule 4: a PHASE_CHANGED event already carries its `to_phase` (both reference traces use that convention).
- Rule 5: artifacts are referenced by ARTIFACT_READ/ARTIFACT_UPDATED `artifact_id`, `subject_artifact_id`
  (REVIEW_SUBMITTED, APPROVAL_REQUESTED, CI_RUN_STARTED) and the envelope `artifact_ids`; all must exist already
  (ARTIFACT_CREATED may list its own id). Creation is version 1; each update is previous + 1.
- Rule 7: a TOOL_CALL_COMPLETED / APPROVAL_DECIDED without an open start is also a violation.
- Rule 8: "created or modified" = emitted ARTIFACT_CREATED or ARTIFACT_UPDATED for it; APPROVAL_DECIDED's subject is
  the subject_artifact_id of its APPROVAL_REQUESTED.
- Rule 12: CHECK_COMPLETED outside an open CI run, and CI_RUN_COMPLETED without a matching start, are violations.
- Rule 13 ("humans simulated by policy carry simulated: true"): a trace whose SESSION_STARTED.metadata.source is
  "mock" or "real" was produced by the harness, where no live human participates, so every human roster entry must
  have simulated true. In any trace, a human whose events carry metadata.simulated == true or a metadata.policy
  must be simulated in the roster.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent / "schema" / "simulation-log-event-2.1.0.json"

HUMAN_ROLES = {"originator", "product_owner", "tech_lead", "engineer", "policy_owner", "code_owner",
               "release_manager", "architect"}
AGENT_ROLES = {"supervisor", "researcher", "requirements_agent", "task_planner", "code_agent", "code_simplifier",
               "review_agent", "verifier", "devops_agent", "monitoring_agent"}
SYSTEM_ROLES = {"ci", "staging", "flow_engine"}
CI_EVENTS = {"CI_RUN_STARTED", "CI_RUN_COMPLETED", "CHECK_COMPLETED"}
ISO_ZONED = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")

_validator = None


def _schema_validator():
    global _validator
    if _validator is None:
        from jsonschema import Draft7Validator
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            _validator = Draft7Validator(json.load(f))
    return _validator


def _expected_type(role) -> str | None:
    if role in HUMAN_ROLES:
        return "human"
    if role in AGENT_ROLES:
        return "agent"
    if role in SYSTEM_ROLES:
        return "system"
    return None


def _parse_ts(ts):
    if not isinstance(ts, str) or not ISO_ZONED.match(ts):
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def validate_events(events: list[dict]) -> list[dict]:
    out: list[dict] = []

    def v(seq, rule, msg):
        out.append({"seq": seq, "rule": rule, "message": msg})

    def seq_of(i, e):
        s = e.get("seq") if isinstance(e, dict) else None
        return s if isinstance(s, int) and not isinstance(s, bool) else i

    events = [e if isinstance(e, dict) else {} for e in events]
    # --- schema, line by line
    val = _schema_validator()
    for i, e in enumerate(events):
        for err in sorted(val.iter_errors(e), key=lambda x: list(x.path)):
            loc = "/".join(str(p) for p in err.path) or "(event)"
            v(seq_of(i, e), "schema", f"{loc}: {err.message}"[:300])
    if not events:
        v(None, 1, "empty trace")
        return out

    # --- rule 1
    first, last = events[0], events[-1]
    if first.get("event_type") != "SESSION_STARTED":
        v(seq_of(0, first), 1, "first event is not SESSION_STARTED")
    if last.get("event_type") != "SESSION_ENDED":
        v(seq_of(len(events) - 1, last), 1, "last event is not SESSION_ENDED")
    for i, e in enumerate(events[1:-1], start=1):
        if e.get("event_type") in ("SESSION_STARTED", "SESSION_ENDED"):
            v(seq_of(i, e), 1, f"{e['event_type']} in the middle of the trace")

    # --- rule 2
    ids, prev_ts, session = set(), None, first.get("session_id")
    for i, e in enumerate(events):
        s = e.get("seq")
        if i == 0 and s != 0:
            v(seq_of(i, e), 2, f"seq starts at {s}, not 0")
        elif i > 0 and isinstance(s, int) and isinstance(events[i - 1].get("seq"), int) and s != events[i - 1]["seq"] + 1:
            v(seq_of(i, e), 2, f"seq {s} follows {events[i - 1]['seq']} (gap or disorder)")
        eid = e.get("event_id")
        if eid in ids:
            v(seq_of(i, e), 2, f"duplicate event_id {eid}")
        ids.add(eid)
        ts = _parse_ts(e.get("timestamp"))
        if ts is None:
            v(seq_of(i, e), 2, f"timestamp {e.get('timestamp')!r} is not ISO-8601 with a zone")
        elif prev_ts is not None and ts < prev_ts:
            v(seq_of(i, e), 2, f"timestamp goes backwards ({e.get('timestamp')})")
        if ts is not None:
            prev_ts = ts if prev_ts is None or ts > prev_ts else prev_ts
        if e.get("session_id") != session:
            v(seq_of(i, e), 2, f"session_id changes to {e.get('session_id')!r}")

    # --- roster (rules 3 and 13)
    known: dict[str, tuple] = {}
    roster = (first.get("payload") or {}).get("roster") or [] if first.get("event_type") == "SESSION_STARTED" else []
    simulated: dict[str, bool] = {}
    for r in roster:
        if not isinstance(r, dict):
            continue
        aid, at, role = r.get("actor_id"), r.get("actor_type"), r.get("role")
        exp = _expected_type(role)
        if exp and at != exp:
            v(seq_of(0, first), 3, f"roster {aid}: role {role} requires actor_type {exp}, got {at}")
        known[aid] = (at, role)
        if at == "human":
            simulated[aid] = r.get("simulated") is True
    source = ((first.get("metadata") or {}).get("source"))
    if source in ("mock", "real"):
        for aid, sim in simulated.items():
            if not sim:
                v(seq_of(0, first), 13, f"human {aid} in a harness trace (source={source}) lacks simulated: true")

    phase = (first.get("payload") or {}).get("initial_phase") if first.get("event_type") == "SESSION_STARTED" else None
    artifacts: dict[str, int] = {}
    touched_by: dict[str, set] = {}
    open_tools: dict[str, int] = {}
    open_approvals: dict[str, tuple] = {}
    open_ci: dict = {}            # run_attempt -> [start seq, checks seen]
    seen_ids: set = set()
    flagged13: set = set()

    for i, e in enumerate(events):
        sq = seq_of(i, e)
        et = e.get("event_type")
        actor = e.get("actor") if isinstance(e.get("actor"), dict) else {}
        aid, atype, role = actor.get("actor_id"), actor.get("actor_type"), actor.get("role")
        p = e.get("payload") if isinstance(e.get("payload"), dict) else {}
        inter = e.get("interaction") if isinstance(e.get("interaction"), dict) else None

        # rule 3
        if et == "ACTOR_JOINED" and aid not in known:
            known[aid] = (atype, role)
        elif aid not in known:
            v(sq, 3, f"actor {aid} is not in the roster and did not join")
        elif known[aid] != (atype, role):
            v(sq, 3, f"actor {aid} changes type/role to {atype}/{role} (was {known[aid][0]}/{known[aid][1]})")
        if inter:
            targets = [inter.get("target_actor_id")] + list(inter.get("target_actor_ids") or [])
            for t in targets:
                if t is not None and t != "broadcast" and t not in known:
                    v(sq, 3, f"interaction target {t} is not in the roster and did not join")

        # rule 4
        if et == "PHASE_CHANGED":
            if p.get("from_phase") != phase:
                v(sq, 4, f"from_phase {p.get('from_phase')} != current phase {phase}")
            phase = p.get("to_phase")
        if e.get("phase") != phase:
            v(sq, 4, f"phase {e.get('phase')} != current phase {phase}")

        # rule 5
        refs = []
        if et in ("ARTIFACT_READ", "ARTIFACT_UPDATED"):
            refs.append(p.get("artifact_id"))
        if et in ("REVIEW_SUBMITTED", "APPROVAL_REQUESTED", "CI_RUN_STARTED") and p.get("subject_artifact_id"):
            refs.append(p.get("subject_artifact_id"))
        own = p.get("artifact_id") if et == "ARTIFACT_CREATED" else None
        if et == "ARTIFACT_CREATED":
            if own in artifacts:
                v(sq, 5, f"artifact {own} created twice")
            else:
                artifacts[own] = 1
            touched_by.setdefault(own, set()).add(aid)
        refs += [a for a in (e.get("artifact_ids") or []) if a != own]
        for a in dict.fromkeys(refs):
            if a not in artifacts:
                v(sq, 5, f"artifact {a} referenced before ARTIFACT_CREATED")
        if et == "ARTIFACT_UPDATED" and p.get("artifact_id") in artifacts:
            a = p["artifact_id"]
            if p.get("version") != artifacts[a] + 1:
                v(sq, 5, f"artifact {a} version {p.get('version')} does not follow {artifacts[a]}")
            artifacts[a] = p.get("version") if isinstance(p.get("version"), int) else artifacts[a] + 1
            touched_by.setdefault(a, set()).add(aid)

        # rule 6
        if inter and inter.get("source_actor_id") != aid:
            v(sq, 6, f"interaction.source_actor_id {inter.get('source_actor_id')} != actor {aid}")
        if et == "TASK_ASSIGNED" and inter and p.get("assignee_id") != inter.get("target_actor_id"):
            v(sq, 6, f"assignee_id {p.get('assignee_id')} != interaction target {inter.get('target_actor_id')}")

        # rule 7
        if et == "TOOL_CALL_STARTED":
            open_tools[e.get("correlation_id")] = sq
        elif et == "TOOL_CALL_COMPLETED":
            if open_tools.pop(e.get("correlation_id"), None) is None:
                v(sq, 7, f"TOOL_CALL_COMPLETED {e.get('correlation_id')} without an open TOOL_CALL_STARTED")
        elif et == "APPROVAL_REQUESTED":
            open_approvals[p.get("request_id")] = (sq, p.get("subject_artifact_id"))
        elif et == "APPROVAL_DECIDED":
            req = open_approvals.pop(p.get("request_id"), None)
            if req is None:
                v(sq, 7, f"APPROVAL_DECIDED {p.get('request_id')} without an open APPROVAL_REQUESTED")
        par = e.get("parent_event_id")
        if par is not None and par not in seen_ids:
            v(sq, 7, f"parent_event_id {par} does not point to an earlier event")

        # rule 8
        if et == "REVIEW_SUBMITTED":
            if atype == "agent" and p.get("decision") == "approved":
                v(sq, 8, f"agent {aid} cannot approve")
            if aid in touched_by.get(p.get("subject_artifact_id"), set()):
                v(sq, 8, f"{aid} reviews an artifact it created or modified")
        if et == "APPROVAL_DECIDED":
            if atype != "human":
                v(sq, 8, f"APPROVAL_DECIDED emitted by non-human {aid}")
            subj = req[1] if req else None
            if subj and aid in touched_by.get(subj, set()):
                v(sq, 8, f"{aid} approves an artifact it created or modified")

        # rule 9
        if et in CI_EVENTS and role != "ci":
            v(sq, 9, f"{et} emitted by {aid} (role {role}), only ci may")
        if et == "ORACLE_RESULT" and role != "staging":
            v(sq, 9, f"ORACLE_RESULT emitted by {aid} (role {role}), only staging may")
        # rule 10
        if et in ("REVIEW_SUBMITTED", "APPROVAL_DECIDED") and atype == "system":
            v(sq, 10, f"system actor {aid} emits {et}")
        # rule 11
        if et == "GATE_TOUCHED" and atype != "agent":
            v(sq, 11, f"GATE_TOUCHED emitted by {aid} ({atype}), must be an agent")
        # rule 12
        if et == "CI_RUN_STARTED":
            ra = p.get("run_attempt")
            if ra in open_ci:
                v(sq, 12, f"CI_RUN_STARTED run_attempt {ra} while that attempt is still open")
            open_ci[ra] = [sq, 0]
        elif et == "CHECK_COMPLETED":
            if not open_ci:
                v(sq, 12, "CHECK_COMPLETED outside a CI run")
            for st in open_ci.values():
                st[1] += 1
        elif et == "CI_RUN_COMPLETED":
            ra = p.get("run_attempt")
            st = open_ci.pop(ra, None)
            if st is None:
                v(sq, 12, f"CI_RUN_COMPLETED run_attempt {ra} without a CI_RUN_STARTED")
            elif st[1] == 0:
                v(sq, 12, f"CI run_attempt {ra} completed without any CHECK_COMPLETED")
        # rule 13 (policy-simulated humans)
        md = e.get("metadata") if isinstance(e.get("metadata"), dict) else {}
        if atype == "human" and (md.get("simulated") is True or "policy" in md) and not simulated.get(aid) \
                and aid not in flagged13:
            flagged13.add(aid)
            v(sq, 13, f"human {aid} acts by policy but its roster entry lacks simulated: true")

        if e.get("event_id") is not None:
            seen_ids.add(e.get("event_id"))

    for cid, sq in open_tools.items():
        v(sq, 7, f"TOOL_CALL_STARTED {cid} never completed")
    for rid, (sq, _) in open_approvals.items():
        v(sq, 7, f"APPROVAL_REQUESTED {rid} never decided")
    for ra, (sq, _) in open_ci.items():
        v(sq, 12, f"CI_RUN_STARTED run_attempt {ra} has no CI_RUN_COMPLETED")
    return out


def validate_file(path) -> list[dict]:
    events, out = [], []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, start=1):
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError as ex:
                out.append({"seq": None, "rule": "schema", "message": f"line {n}: invalid JSON ({ex.msg})"})
    return out + validate_events(events)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m trace.validate")
    ap.add_argument("trace")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if not Path(a.trace).is_file():
        print(f"no such file: {a.trace}", file=sys.stderr)
        return 2
    viol = validate_file(a.trace)
    if a.json:
        print(json.dumps({"valid": not viol, "violations": viol}, indent=2))
    elif viol:
        for x in viol:
            print(f"seq={x['seq']} rule={x['rule']}: {x['message']}")
        print(f"INVALID {len(viol)} violation(s)")
    else:
        with open(a.trace, encoding="utf-8") as f:
            n = sum(1 for line in f if line.strip())
        print(f"VALID {n} events")
    return 1 if viol else 0


if __name__ == "__main__":
    sys.exit(main())
