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
EXPORTER_VERSION = 4
GAP_THRESHOLD_MS = 3000
GAP_COMPRESSED_MS = 1500
TEXT_MAX = 600
CAPTION_MAX = 200

LEGEND_MOCK = "SIMULATED (mock agent) — not a real run"
LEGEND_REAL = "Replay of a real run"
# Scripted scenes of the public AI-SDLC models (replay/scenes): never a measured run.
LEGEND_ILLUSTRATION = "Illustration · scripted from public documentation"
# Illustration events carry these metadata keys to the steps: the model's own stage name, the common phase axis
# (intent → spec → plan → tasks → code → review → CI → release → production) and the place a hand-off goes to.
ILLUSTRATION_KEYS = ("stage", "axis", "handoff_to", "rule", "blocks")
ILLUSTRATION_PLACES = {
    "staging-bench": {"label": "The other teams' tests", "note": "illustration: what happens downstream"},
    "pr-tray": {"note": "pull request"},
}

# The AI-SDLC Office as a lifecycle, left to right (Theater v3): DEFINE (product, delivery, analysis, architecture),
# BUILD (code agents, testing), VERIFY & RELEASE (PR tray or review, CI, merge gate / release) and PRODUCTION (the
# running services with their owning teams, the staging oracle that runs those teams' own tests, and the users).
# x/y are normalized positions on the aerial map; `zone` names the column. Which places a run shows depends on the run
# (see build_replay: PR tray without a reviewer, dev desks only for the code agents present).
ZONES: list[dict] = [
    {"id": "define", "label": "Define", "x0": 0.0, "x1": 0.22,
     "roles": "product owner · delivery · analyst · architect", "band": "probabilistic"},
    {"id": "build", "label": "Build", "x0": 0.22, "x1": 0.46, "roles": "code agents · tester", "band": "probabilistic"},
    {"id": "verify", "label": "Verify & release", "x0": 0.46, "x1": 0.68,
     "roles": "CI · review · merge gate · release manager", "band": "deterministic"},
    {"id": "production", "label": "Production", "x0": 0.68, "x1": 1.0,
     "roles": "running services · their teams · users", "band": "deterministic"},
]
# The v2 idea kept as a sub-band under the zone titles: what happens before code exists and while it is generated is
# probabilistic (spec, context, the model); what checks it afterwards is deterministic (CI, gates, the teams' tests).
BANDS = {"probabilistic": "before generation and generation · probabilistic",
         "deterministic": "after generation · deterministic"}

PLACES: list[dict] = [
    # DEFINE
    {"id": "product-desk", "label": "Product", "kind": "desk", "x": 0.07, "y": 0.18, "note": "product owner",
     "zone": "define"},
    {"id": "planning-room", "label": "Delivery · planning", "kind": "room", "x": 0.16, "y": 0.33,
     "note": "scrum master / delivery", "zone": "define"},
    {"id": "analysis-desk", "label": "Analysis", "kind": "desk", "x": 0.06, "y": 0.5, "note": "analyst",
     "zone": "define"},
    {"id": "architecture-library", "label": "Architecture library", "kind": "library", "x": 0.14, "y": 0.7,
     "note": "ARCH-n rules, catalog, ADRs", "zone": "define"},
    # BUILD
    {"id": "dispatch", "label": "Dispatch board", "kind": "system", "x": 0.34, "y": 0.16, "note": "flow engine",
     "zone": "build"},
    {"id": "desk-orders", "label": "Checkout · orders", "kind": "desk", "x": 0.33, "y": 0.42,
     "note": "orders-service", "zone": "build"},
    {"id": "dev-storefront", "label": "Dev · storefront", "kind": "desk", "x": 0.4, "y": 0.33,
     "note": "web-storefront", "zone": "build"},
    {"id": "dev-payments", "label": "Dev · payments", "kind": "desk", "x": 0.28, "y": 0.52,
     "note": "payments-service", "zone": "build"},
    {"id": "dev-billing", "label": "Dev · billing", "kind": "desk", "x": 0.4, "y": 0.52, "note": "billing-service",
     "zone": "build"},
    {"id": "dev-analytics", "label": "Dev · analytics", "kind": "desk", "x": 0.28, "y": 0.71,
     "note": "analytics-ingest", "zone": "build"},
    {"id": "dev-inventory", "label": "Dev · inventory", "kind": "desk", "x": 0.4, "y": 0.71,
     "note": "inventory-service", "zone": "build"},
    {"id": "tester-desk", "label": "Testing", "kind": "desk", "x": 0.34, "y": 0.86, "note": "tester / verifier",
     "zone": "build"},
    # VERIFY & RELEASE
    {"id": "review-desk", "label": "Review desk", "kind": "desk", "x": 0.52, "y": 0.17, "note": "reviewers",
     "zone": "verify"},
    {"id": "review-table", "label": "Review table", "kind": "room", "x": 0.54, "y": 0.45, "note": "pull request",
     "zone": "verify"},
    {"id": "pr-tray", "label": "PR tray", "kind": "system", "x": 0.505, "y": 0.42,
     "note": "CI is the only reviewer", "zone": "verify"},
    {"id": "ci-tower", "label": "CI Tower", "kind": "system", "x": 0.6, "y": 0.36, "note": "one light per check",
     "zone": "verify"},
    {"id": "merge-gate", "label": "Merge gate · release", "kind": "gate", "x": 0.58, "y": 0.72,
     "note": "release manager", "zone": "verify"},
    # PRODUCTION
    {"id": "staging-bench", "label": "Staging oracle", "kind": "stage", "x": 0.93, "y": 0.17,
     "note": "the teams' own tests · hidden from the agent", "zone": "production"},
    {"id": "desk-billing", "label": "billing-service", "kind": "desk", "x": 0.76, "y": 0.3,
     "note": "Billing team", "zone": "production"},
    {"id": "desk-analytics", "label": "analytics-ingest", "kind": "desk", "x": 0.93, "y": 0.47,
     "note": "Analytics team", "zone": "production"},
    {"id": "desk-storefront", "label": "web-storefront", "kind": "desk", "x": 0.78, "y": 0.66,
     "note": "Storefront team", "zone": "production"},
    {"id": "users", "label": "Users", "kind": "stage", "x": 0.88, "y": 0.88, "note": "illustrative",
     "zone": "production"},
]
PLACE_IDS = {p["id"] for p in PLACES}
REVIEWER_ROLES = {"review_agent", "code_owner", "code_simplifier"}
DEFINE_ROLES = {"originator", "product_owner", "requirements_agent", "researcher", "task_planner", "tech_lead",
                "supervisor", "policy_owner", "engineer", "architect"}
DEV_DESKS = {"dev-storefront", "dev-payments", "dev-billing", "dev-analytics", "dev-inventory"}
# M1 (one code agent): the agent's desk sits in the middle of BUILD; with several code agents (M2b) the dev desks fill
# BUILD in a grid and the orders desk moves to its top-left cell.
DESK_ORDERS_GRID = (0.28, 0.33)

ROLE_HOME = {
    "flow_engine": "dispatch", "ci": "ci-tower", "staging": "staging-bench", "architect": "architecture-library",
    "originator": "product-desk", "product_owner": "product-desk",
    "requirements_agent": "analysis-desk", "researcher": "analysis-desk",
    "task_planner": "planning-room", "engineer": "planning-room", "tech_lead": "planning-room",
    "supervisor": "planning-room", "policy_owner": "planning-room",
    "verifier": "tester-desk", "tester": "tester-desk",
    "review_agent": "review-desk", "code_owner": "review-desk", "code_simplifier": "review-desk",
    "devops_agent": "merge-gate", "release_manager": "merge-gate", "monitoring_agent": "staging-bench",
}
REPO_DESKS = (("orders", "desk-orders"), ("billing", "dev-billing"), ("analytics", "dev-analytics"),
              ("storefront", "dev-storefront"), ("web", "dev-storefront"), ("payments", "dev-payments"),
              ("inventory", "dev-inventory"))
LIFECYCLE_SINGLE_TICKET = "Single-ticket harness (Agents vs. Gates)"
TICKET_ORIGIN_LABEL = "ticket written by Product · scenario"

# The other teams (M1 consumers of orders-service). Folder = the repo folder in a V2 workspace.
CONSUMERS = (("billing-service", "desk-billing"), ("analytics-ingest", "desk-analytics"),
             ("web-storefront", "desk-storefront"))
# Fictional code owners for the consumer desks when the run has none of its own (M1 traces carry no consumer
# people). Invented first names and seeds; they are not real people. They only react to the run's oracle results.
CONSUMER_CAST = {
    "billing-service": {"name": "Noor", "title": "Billing team (consumer)", "seed": "cast:noor:billing"},
    "analytics-ingest": {"name": "Kenji", "title": "Analytics team (consumer)", "seed": "cast:kenji:analytics"},
    "web-storefront": {"name": "Lucía", "title": "Storefront team (consumer)", "seed": "cast:lucia:storefront"},
}
READ_TOOLS = {"read", "grep", "glob", "ls", "notebookread", "view", "search", "find"}
EDIT_TOOLS = {"edit", "write", "multiedit", "notebookedit", "apply_patch", "create", "str_replace"}


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


def _norm(path) -> str:
    return str(path or "").replace("\\", "/").strip().lower()


def _in_folder(path, folder: str) -> bool:
    """True when a path (absolute or workspace-relative) lies inside a top-level workspace folder `folder`."""
    p = _norm(path)
    f = folder.lower()
    return p.startswith(f + "/") or f"/{f}/" in p or p == f or p.endswith("/" + f)


def _same_file(a, b) -> bool:
    """Workspace-relative and absolute spellings of one file: equal, or one ends with "/" + the other."""
    x, y = _norm(a), _norm(b)
    if not x or not y:
        return False
    return x == y or x.endswith("/" + y) or y.endswith("/" + x)


def parse_diff(text: str) -> list[dict]:
    """Unified git diff -> [{path, added, removed, lines: [(op, text)]}] (changed lines only, in order)."""
    files: list[dict] = []
    cur = None
    for raw in (text or "").splitlines():
        if raw.startswith("diff --git "):
            parts = raw.split(" b/", 1)
            cur = {"path": parts[1] if len(parts) == 2 else raw[11:], "added": 0, "removed": 0, "lines": []}
            files.append(cur)
        elif cur is None or raw.startswith(("+++", "---", "@@", "index ", "new file", "deleted file", "similarity",
                                            "rename ", "old mode", "new mode", "\\ No newline")):
            continue
        elif raw.startswith("+"):
            cur["added"] += 1
            cur["lines"].append(("+", raw[1:]))
        elif raw.startswith("-"):
            cur["removed"] += 1
            cur["lines"].append(("-", raw[1:]))
    return files


def _key_file(files: list[dict], consumer_folders: tuple[str, ...]) -> dict | None:
    """The diff's key file: a non-test source file outside the other teams' folders with the most changed lines."""
    def is_test(p: str) -> bool:
        p = _norm(p)
        return "/test/" in f"/{p}" or "/tests/" in f"/{p}" or ".test." in p or ".spec." in p

    pool = [f for f in files if not any(_in_folder(f["path"], c) for c in consumer_folders)] or files
    src = [f for f in pool if not is_test(f["path"])] or pool
    if not src:
        return None
    return max(src, key=lambda f: (f["added"] + f["removed"], -src.index(f)))


def _card_lines(f: dict, limit: int = 6) -> tuple[list[dict], int]:
    """Changed lines of the key file for the diff card: stripped, blank and duplicate lines dropped, at most `limit`."""
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    total = 0
    for op, text in f["lines"]:
        t = text.strip()
        if not t or (op, t) in seen:
            continue
        seen.add((op, t))
        total += 1
        if len(out) < limit:
            out.append({"op": op, "text": _clip(t, 90)})
    return out, total - len(out)


def _tool_path(inp: dict) -> list[str]:
    """Paths named by a tool call's input (Claude Code: file_path / path / notebook_path; others: path-like keys)."""
    out = []
    for k in ("file_path", "path", "notebook_path", "filePath", "dir", "directory"):
        v = inp.get(k)
        if isinstance(v, str) and v:
            out.append(v)
    return out


def build_replay(events: list[dict], extras: dict | None = None) -> dict:
    """Pure: events (one AISDLC-Trace 2.1 file, in order) -> replay dict valid against replay.schema.json.

    `extras` (optional, exporter 2) = {"record": record.json, "diffs": {"gen": text, "fix1": text, ...},
    "transcript": [transcript.jsonl lines]} from the same run folder. They only add the `scene` block (visibility,
    the other teams' desks, what the agent read or edited there, diff cards); without them the scene is derived
    from the trace alone. Nothing is read from disk here.
    """
    extras = extras or {}
    record = extras.get("record") or {}
    diffs = extras.get("diffs") or {}
    transcript = extras.get("transcript") or []
    events = sorted(events, key=lambda e: e.get("seq", 0))
    if not events or events[0].get("event_type") != "SESSION_STARTED":
        raise ValueError("trace must start with SESSION_STARTED")
    start = events[0]
    md = start.get("metadata") or {}
    sp = start.get("payload") or {}
    end = next((e for e in reversed(events) if e.get("event_type") == "SESSION_ENDED"), None)
    stats = ((end or {}).get("payload") or {}).get("stats") or {}

    source = {"mock": "mock", "illustration": "illustration"}.get(md.get("source"), "real")
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
    # Without a reviewer (every M1 run) CI is the only reviewer: the PR goes to a tray beside the CI tower.
    has_reviewer = any(a["role"] in REVIEWER_ROLES for a in actors)
    pr_place = "review-table" if has_reviewer else "pr-tray"
    agent_ids = [a["id"] for a in actors if a["role"] == "code_agent"]
    cond_md = md.get("condition") or {}
    V = record.get("visibility") or cond_md.get("V")
    S = record.get("spec") or cond_md.get("S")

    def name_of(actor_id: str | None) -> str:
        a = by_id.get(actor_id or "")
        return a["display_name"] if a else (actor_id or "")

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
    ci_checks_total: dict[int, int] = {}  # checks per CI attempt (a CHECK belongs to the latest CI_RUN_STARTED)
    attempt_now = 0
    for e in events:
        p = e.get("payload") or {}
        if e.get("event_type") == "CI_RUN_STARTED":
            attempt_now = int(p.get("run_attempt", 0) or 0)
        elif e.get("event_type") == "CHECK_COMPLETED":
            ci_checks_total[attempt_now] = ci_checks_total.get(attempt_now, 0) + 1

    for i, e in enumerate(events):
        et = e.get("event_type")
        p = e.get("payload") or {}
        actor = (e.get("actor") or {}).get("actor_id", "flow-engine")
        visual = e.get("visual") or {}
        narration = _clip(visual.get("narration"), 280)
        inter = e.get("interaction") or {}
        base = {"t_ms": comp[i], "t_real_ms": max(0, ts[i] - t0), "seq": int(e.get("seq", i)), "actor": actor}

        def step(action: str, *, text=None, target=None, place=None, key=None, check=None, detail=None,
                 narr=narration, actor_id=None, caption=None):
            s = dict(base)
            if actor_id:
                s["actor"] = actor_id
            s.update({"action": action, "target": target,
                      "place": place if place is not None else location.get(s["actor"]),
                      "text": _clip(text), "key": key, "narration": narr})
            if caption:
                # plain-language subtitle for the audience, a template over trace fields (used when narr is None)
                s["caption"] = _clip(caption, CAPTION_MAX)
            if check is not None:
                s["check"] = check
            d = {"event_type": et, "event_id": e.get("event_id"), "phase": e.get("phase")}
            if detail:
                d.update(detail)
            if source == "illustration":
                emd = e.get("metadata") or {}
                d.update({k: emd[k] for k in ILLUSTRATION_KEYS if emd.get(k) is not None})
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
            ticket = md.get("ticket")
            step("assign", text=p.get("title"), target=target, key="task_assigned",
                 detail={"task_id": e.get("task_id")},
                 caption=f"{name_of(target)} gets {'ticket ' + ticket if ticket else 'the task'}: "
                         f"“{p.get('title') or ''}”" if target else None)
            marker("task_assigned", f"Task assigned{': ' + md['ticket'] if md.get('ticket') else ''}")
        elif et == "ARTIFACT_CREATED":
            if p.get("artifact_type") == "pull_request":
                move(actor, pr_place)
                where = "the PR tray: CI is its only reviewer" if pr_place == "pr-tray" else "the review table"
                step("handoff", text=" · ".join(x for x in (p.get("path"), p.get("summary")) if x),
                     target=pr_place, key="pr_opened",
                     detail={"artifact_id": p.get("artifact_id"), "diff": p.get("diff")},
                     caption=f"{name_of(actor)} opens a pull request ({p.get('summary') or p.get('path')}) "
                             f"and leaves it on {where}.")
                marker("pr_opened", f"PR opened{' · ' + p['summary'] if p.get('summary') else ''}")
            else:
                step("work", text=" · ".join(x for x in (p.get("path"), p.get("summary")) if x),
                     detail={"artifact_id": p.get("artifact_id"), "artifact_type": p.get("artifact_type")})
        elif et == "ARTIFACT_UPDATED":
            is_pr = str(p.get("path", "")).startswith("PR ") or p.get("artifact_id") == "art-pr"
            if is_pr:
                repairs += 1
                move(actor, pr_place)
                step("handoff", text=" · ".join(x for x in (p.get("path"), p.get("change_summary")) if x),
                     target=pr_place, key="repair",
                     detail={"artifact_id": p.get("artifact_id"), "version": p.get("version"),
                             "diff": p.get("diff")},
                     caption=f"{name_of(actor)} pushes repair {repairs}"
                             f"{' (' + p['change_summary'] + ')' if p.get('change_summary') else ''}.")
                marker("repair", f"Repair {repairs} pushed · {p.get('change_summary', '')}".rstrip(" ·"))
            else:
                step("work", text=" · ".join(x for x in (p.get("path"), p.get("change_summary")) if x),
                     detail={"artifact_id": p.get("artifact_id"), "version": p.get("version")})
        elif et == "ARTIFACT_READ":
            # the context file being read is a key moment (the deck clips keep its bubble: ?bubbles=...,context_loaded)
            step("work", text=" · ".join(x for x in (p.get("path"), p.get("purpose")) if x),
                 key="context_loaded" if p.get("artifact_id") == "art-context" else None,
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
            src_role = by_id.get(actor, {}).get("role")
            to_agent = target in agent_ids or (not target and src_role == "flow_engine" and agent_ids)
            # CI output sent back to the agent (in the illustrations CI itself sends it)
            feedback = (src_role == "flow_engine" or (source == "illustration" and src_role == "ci")) and to_agent                 and str(p.get("content") or "").startswith("CI ")
            step("speak", text=p.get("content"), target=target or (agent_ids[0] if feedback else None),
                 detail={"interaction_type": itype, "content": p.get("content"),
                         **({"feedback": "ci_output"} if feedback else {})})
            if feedback:
                # one subtitle for "CI failed and the agent gets its output", on the CI verdict
                fail = next((s for s in reversed(steps) if s.get("key") == "ci_fail"), None)
                back = f" Its output goes back to {name_of(target or agent_ids[0])}."
                if fail is not None and fail.get("caption") and not fail["caption"].endswith(back):
                    fail["caption"] = _clip(fail["caption"] + back, CAPTION_MAX)
            if itype == "feedback_request" and target in by_id:
                move(target, by_id[target]["home"])
        elif et == "PHASE_CHANGED":
            step("phase", text=p.get("reason"), detail={"from_phase": p.get("from_phase"),
                                                        "to_phase": p.get("to_phase")})
        elif et == "CI_RUN_STARTED":
            att = int(p.get("run_attempt", 0) or 0)
            n = ci_checks_total.get(att)
            step("check", text=None, place="ci-tower", detail={"run_attempt": p.get("run_attempt"),
                                                               "subject_artifact_id": p.get("subject_artifact_id")},
                 caption=f"CI picks up the pull request and runs {n} deterministic checks"
                         f"{' (attempt ' + str(att + 1) + ')' if att else ''}." if n else None)
        elif et == "CHECK_COMPLETED":
            step("check", text=p.get("output_excerpt"), place="ci-tower",
                 check={"id": p.get("check_id"), "status": p.get("status"), "rule": p.get("rule_id")},
                 detail={"category": p.get("category"), "duration_ms": p.get("duration_ms"),
                         "output": p.get("output_excerpt")})
        elif et == "CI_RUN_COMPLETED":
            ok = bool(p.get("ok"))
            failed = list(p.get("failed_checks") or [])
            label = "CI passed" if ok else f"CI failed: {', '.join(failed)}" if failed else "CI failed"
            n = ci_checks_total.get(int(p.get("run_attempt", 0) or 0))
            if ok:
                cap = f"CI passes: {'all ' + str(n) + ' checks' if n else 'every check'} pass."
            else:
                cap = (f"CI blocks the pull request: {', '.join(failed)} failed"
                       f"{' (' + str(len(failed)) + ' of ' + str(n) + ' checks)' if n and failed else ''}.")
            step("ci_result", text=narration or label, place="ci-tower", key="ci_pass" if ok else "ci_fail",
                 check={"id": f"attempt-{p.get('run_attempt', 0)}", "status": _check_status(ok), "rule": None},
                 detail={"run_attempt": p.get("run_attempt"), "ok": ok, "failed_checks": failed}, caption=cap)
            marker("ci_pass" if ok else "ci_fail", label)
        elif et == "GATE_TOUCHED":
            move(actor, "ci-tower")
            text = " · ".join(x for x in (p.get("detector"), p.get("path"), p.get("change_summary")) if x)
            step("gate_touch", text=text, place="ci-tower", key="gate_touched",
                 detail={"detector": p.get("detector"), "path": p.get("path"),
                         "change_summary": p.get("change_summary"),
                         "detected_by": (e.get("metadata") or {}).get("detected_by")},
                 caption=f"{name_of(actor)} touched a gate: "
                         f"{' '.join(x for x in (p.get('detector'), p.get('path')) if x)}.")
            marker("gate_touched", f"Gate touched: {p.get('detector')} {p.get('path')}")
        elif et == "ORACLE_RESULT":
            ok = bool(p.get("ok"))
            state = p.get("state", "final")
            text = f"{p.get('consumer')} ({state}): {p.get('message') or ('ok' if ok else 'fail')}"
            first = state not in oracle_marked
            fails, total = oracle_groups.get(state, [0, 0])
            version = {"gen": "the first pull request", "final": "the final pull request"}.get(state, state)
            cap = None
            if first:
                cap = (f"Staging oracle, hidden from the agent: the other teams run their own tests on {version}. "
                       + (f"{fails} of {total} break." if fails else f"All {total} pass."))
            step("oracle", text=text, place="staging-bench", key="oracle" if first else None,
                 check={"id": str(p.get("consumer")), "status": _check_status(ok), "rule": None},
                 detail={"consumer": p.get("consumer"), "state": state, "ok": ok, "message": p.get("message"),
                         "hidden_from_agent": True,
                         "contradicts_ci": (last_ci_ok is True and not ok)}, caption=cap)
            if first:
                oracle_marked.add(state)
                marker("oracle", f"Oracle ({state}): {fails} of {total} consumers fail" if fails
                       else f"Oracle ({state}): all {total} consumers pass")
        elif et == "SESSION_ENDED":
            step("phase", text=p.get("summary"), key="session_end",
                 detail={"outcome": p.get("outcome"), "stats": stats},
                 caption=f"End: {str(stats.get('run_outcome')).replace('_', ' ')}"
                         + (f" · ticket {stats['ticket_done'].replace('_', ' ')}" if stats.get("ticket_done") else "")
                         + "." if stats.get("run_outcome") else p.get("summary"))
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

    t_of_seq = {int(e.get("seq", i)): comp[i] for i, e in enumerate(events)}
    scene = _scene(events, steps, actors, t_of_seq, record=record, diffs=diffs, transcript=transcript, V=V, S=S,
                   has_reviewer=has_reviewer, agent_ids=agent_ids, context_file=md.get("context_file"))
    # caption steps for what the scene adds (reads in another team's folder, edits there): attach to existing steps
    by_seq_step = {}
    for s in steps:
        if s["action"] != "move":
            by_seq_step.setdefault(s["seq"], s)
    for c in scene["consumers"]:
        for r in c["reads"][:1]:
            s = by_seq_step.get(r["seq"])
            if s is not None and not s.get("caption"):
                s["caption"] = _clip(f"{name_of(s['actor'])} reads {c['id']}'s code: {r['path']}", CAPTION_MAX)
        for ed in c["edits"]:
            s = by_seq_step.get(ed.get("seq"))
            if s is not None and not s.get("caption"):
                s["caption"] = _clip(f"{name_of(s['actor'])} edits another team's code: {ed['path']}", CAPTION_MAX)
    for card in scene["diff_cards"]:
        s = by_seq_step.get(card["seq"])
        if s is not None and not s.get("caption"):
            s["caption"] = _clip(f"{name_of(s['actor'])} edits {card['file']} ({card['session']}).", CAPTION_MAX)

    # DEFINE: who originated the work. Single-ticket runs have no product person in the trace; the ticket comes from
    # the product role because the scenario fixes it, so the product desk shows that (and only that).
    roles = {a["role"] for a in actors}
    assign = next((s for s in steps if s.get("key") == "task_assigned"), None)
    if not roles & {"originator", "product_owner"} and assign is not None:
        scene["ticket_origin"] = {"place": "product-desk", "label": TICKET_ORIGIN_LABEL, "ticket": md.get("ticket"),
                                  "title": assign.get("text"), "to": by_id.get(assign.get("target") or "", {}).get(
                                      "home", "desk-orders"), "seq": assign["seq"], "t_ms": assign["t_ms"]}
    frameworks = [str(f) for f in (sp.get("frameworks") or []) if f]
    if frameworks:
        scene["lifecycle_model"] = {"label": " · ".join(frameworks),
                                    "detail": f"{len(roles - {'flow_engine', 'ci', 'staging'})} roles on the floor"
                                              f" (AISDLC-Trace 2.1 role set)",
                                    "source": "SESSION_STARTED.payload.frameworks", "kind": "sprint"}
    else:
        scene["lifecycle_model"] = {"label": LIFECYCLE_SINGLE_TICKET, "detail": "one code agent, one ticket",
                                    "source": "harness (M1)", "kind": "single-ticket"}
    scene["zones"] = [dict(z, band_label=BANDS[z["band"]]) for z in ZONES]
    if source == "illustration" and isinstance(md.get("illustration"), dict):
        # which public model the scene stages, its source and date, its own stage names, where the architecture rule
        # lives and what blocks the merge (drawn on the floor and in the compare lanes)
        scene["illustration"] = md["illustration"]
        scene["lifecycle_model"]["kind"] = "illustration"

    used = _used_places(actors, steps, scene, has_reviewer)
    grid = any(d in used for d in DEV_DESKS)
    places = []
    for p in PLACES:
        if p["id"] == "pr-tray" and has_reviewer:
            continue
        if p["id"] in ("review-table", "review-desk") and not has_reviewer:
            continue
        if p["id"] in DEV_DESKS and p["id"] not in used:
            continue  # dev desks exist only for the code agents a run has
        q = dict(p, used=p["id"] in used)
        if source == "illustration":
            # an illustration has no hidden oracle and no CI-only review: name those places for what they show
            q.update(ILLUSTRATION_PLACES.get(p["id"], {}))
        if p["id"] == "desk-orders" and grid:
            q["x"], q["y"] = DESK_ORDERS_GRID
        places.append(q)

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
        "legend": {"mock": LEGEND_MOCK, "illustration": LEGEND_ILLUSTRATION}.get(source, LEGEND_REAL),
        "duration_ms": duration,
        "duration_real_ms": max(0, ts[-1] - t0),
        "event_count": len(events),
        "extras_sha256": extras_sha256(extras),
    }
    if source == "illustration" and scene.get("illustration"):
        meta["illustration_source"] = scene["illustration"].get("source")
    return {"meta": meta, "places": places, "actors": actors, "steps": steps, "markers": markers, "scene": scene}


def oracle_impact(message) -> dict:
    """What a failing oracle result says broke, in the oracle's own words. The message is "<n of m tests failed>:
    <test name>: <failure> | <test name>: <failure> ..."; the impact is the first test's failure head ("billing could
    not invoice order A"), else its test name. Nothing is composed: no message, no impact."""
    msg = str(message or "").strip()
    if not msg:
        return {}
    head, _, rest = msg.partition(": ")
    out = {"tests": head} if "test" in head else {}
    first = (rest if "test" in head else msg).split(" | ")[0].strip()
    parts = [x.strip() for x in first.split(": ") if x.strip()]
    if len(parts) >= 2:
        out["impact"] = _clip(parts[1], 80)
        out["test"] = _clip(parts[0], 120)
    elif parts and parts[0] != head:
        out["impact"] = _clip(parts[0], 80)
    return out


def _used_places(actors: list[dict], steps: list[dict], scene: dict, has_reviewer: bool) -> set[str]:
    """Places somebody uses in this run: actors' homes, every place a step happens at or moves to, the other teams'
    desks when the oracle or the agent visits them, the library when the architect is on the floor."""
    used = {a["home"] for a in actors}
    for s in steps:
        if s.get("place"):
            used.add(s["place"])
        if s.get("target") in PLACE_IDS:
            used.add(s["target"])
    for c in scene["consumers"]:
        if c["oracle"] or c["reads"] or c["edits"] or c.get("owner_actor"):
            used.add(c["desk"])
    if any(c["oracle"] for c in scene["consumers"]):
        used.add("users")
    if scene.get("ticket_origin"):
        used.add("product-desk")
    if has_reviewer:
        used.add("review-table")
    return used


def _scene(events: list[dict], steps: list[dict], actors: list[dict], t_of_seq: dict[int, int], *, record: dict,
           diffs: dict, transcript: list[dict], V, S, has_reviewer: bool, agent_ids: list[str],
           context_file) -> dict:
    """The run facts the theater stages around the trace (exporter 2): visibility and spec, the other teams' desks
    (owner, oracle per state, the contract they consume as CI names it, what the agent read or edited in their
    folder), the context sheet and fitness functions Maya hands out, and diff cards of the key file."""
    folders = tuple(c for c, _ in CONSUMERS)
    agent = agent_ids[0] if agent_ids else None
    t_end = steps[-1]["t_ms"] if steps else 0

    # context sheet (ARTIFACT_CREATED context_file) and fitness functions (the rules CI checks)
    ctx_ev = next((e for e in events if e.get("event_type") == "ARTIFACT_CREATED"
                   and (e.get("payload") or {}).get("artifact_type") == "context_file"), None)
    rules: list[str] = []
    for e in events:
        p = e.get("payload") or {}
        if e.get("event_type") == "CHECK_COMPLETED" and p.get("rule_id") and p["rule_id"] not in rules:
            rules.append(p["rule_id"])
    context = None
    if ctx_ev is not None:
        cp = ctx_ev.get("payload") or {}
        context = {"file": cp.get("path") or context_file, "summary": cp.get("summary"),
                   "seq": int(ctx_ev.get("seq", 0)), "t_ms": t_of_seq.get(int(ctx_ev.get("seq", 0)), 0)}

    # which contract each consumer holds, as the CI contract checks name it ("ARCH-4 FAIL billing-service: OrderPlaced.x")
    named: dict[str, list[str]] = {}
    for e in events:
        p = e.get("payload") or {}
        if e.get("event_type") != "CHECK_COMPLETED":
            continue
        for line in str(p.get("output_excerpt") or "").splitlines():
            for folder in folders:
                tag = f" {folder}: "
                if tag in line:
                    words = line.split(tag, 1)[1].strip().split(" ")
                    if words and words[0].isupper() and len(words) > 1 and words[1].startswith("/"):
                        name = f"{words[0]} {words[1]}"
                    else:
                        name = words[0].split(".")[0].rstrip(":") if words and words[0] else ""
                    if name and name not in named.setdefault(folder, []):
                        named[folder].append(name)
    # a consumer may hold several contracts (analytics: OrderPlaced and OrderCancelled): label its packet with the
    # one most consumers share, then the first named
    share = {n: sum(n in v for v in named.values()) for v in named.values() for n in v}
    contract = {f: sorted(v, key=lambda n: (-share[n], v.index(n)))[0] for f, v in named.items() if v}

    # oracle per consumer and state
    oracle: dict[str, dict] = {}
    for e in events:
        p = e.get("payload") or {}
        if e.get("event_type") == "ORACLE_RESULT" and p.get("consumer"):
            o = {"status": "pass" if p.get("ok") else "fail", "seq": int(e.get("seq", 0)),
                 "t_ms": t_of_seq.get(int(e.get("seq", 0)), 0)}
            o.update(oracle_impact(p.get("message")) if not p.get("ok") else {})
            oracle.setdefault(p["consumer"], {})[p.get("state", "final")] = o

    # tool calls: correlation id -> event seq; reads and edits by path
    corr_seq: dict[str, int] = {}
    tool_ev: list[tuple[int, str, str]] = []  # (seq, tool, input_summary) for TOOL_CALL_STARTED of the agent
    for e in events:
        if e.get("event_type") == "TOOL_CALL_STARTED":
            p = e.get("payload") or {}
            if e.get("correlation_id"):
                corr_seq.setdefault(str(e["correlation_id"]), int(e.get("seq", 0)))
            if not agent or (e.get("actor") or {}).get("actor_id") == agent:
                tool_ev.append((int(e.get("seq", 0)), str(p.get("tool_name") or ""), str(p.get("input_summary") or "")))

    reads: dict[str, list[dict]] = {f: [] for f in folders}
    calls = [ln for ln in transcript if ln.get("kind") == "tool_call"]
    if calls:  # the transcript is the source of truth for what was read (spec: tool inputs)
        for ln in calls:
            tool = str(ln.get("name") or "").lower()
            if tool not in READ_TOOLS:
                continue
            seq = corr_seq.get(str(ln.get("id")))
            for path in _tool_path(ln.get("input") or {}):
                for f in folders:
                    if _in_folder(path, f) and seq is not None and not any(r["seq"] == seq for r in reads[f]):
                        raw = str(path).replace("\\", "/")
                        at = raw.lower().find(f.lower() + "/")
                        rel = raw[at:] if at >= 0 else raw
                        reads[f].append({"seq": seq, "t_ms": t_of_seq.get(seq, 0), "tool": ln.get("name"),
                                         "path": rel})
    else:  # no transcript: the trace's tool input summaries
        for seq, tool, inp in tool_ev:
            if tool.lower() in READ_TOOLS:
                for f in folders:
                    if _in_folder(inp, f):
                        reads[f].append({"seq": seq, "t_ms": t_of_seq.get(seq, 0), "tool": tool,
                                         "path": inp.replace("\\", "/")})

    # edits in another team's folder: record.out_of_scope_edits (V2), timed by the agent's edit tool call
    oos = [str(x) for x in (record.get("out_of_scope_edits") or [])]
    edits: dict[str, list[dict]] = {f: [] for f in folders}
    for path in oos:
        for f in folders:
            if _in_folder(path, f):
                seq = next((s for s, tool, inp in tool_ev if tool.lower() in EDIT_TOOLS and _same_file(inp, path)),
                           None)
                if seq is None:  # fall back to the moment the PR was opened
                    seq = next((s["seq"] for s in steps if s.get("key") == "pr_opened"), None)
                edits[f].append({"path": path, "seq": seq, "t_ms": t_of_seq.get(seq, t_end) if seq is not None
                                 else t_end})

    owners = {}
    for a in actors:
        if a["role"] == "code_owner":
            for f in folders:
                if f in a["display_name"] or f.split("-")[0] in a["id"]:
                    owners.setdefault(f, a["id"])
    desk_agents = {a["home"] for a in actors if a["actor_type"] != "system"}

    consumers = []
    for f, desk in CONSUMERS:
        c = {"id": f, "desk": desk, "contract": contract.get(f), "oracle": oracle.get(f, {}), "reads": reads[f],
             "edits": edits[f]}
        if owners.get(f):
            c["owner_actor"] = owners[f]
        elif desk not in desk_agents:
            cast = CONSUMER_CAST[f]
            c["owner"] = {"name": cast["name"], "title": cast["title"], "seed": cast["seed"], "fictional": True}
        consumers.append(c)

    # diff cards: per session (gen, fix1, ...) the key file's changed lines, shown when the agent last edits it
    cards = []
    pr_steps = [s for s in steps if s.get("key") in ("pr_opened", "repair")]
    for k, name in enumerate(sorted(diffs, key=lambda n: (n != "gen", int(n[3:]) if n[3:].isdigit() else 0))):
        files = parse_diff(diffs[name])
        kf = _key_file(files, folders)
        if not kf:
            continue
        lines, more = _card_lines(kf)
        if not lines:
            continue
        pr = pr_steps[k] if k < len(pr_steps) else None
        lo = pr_steps[k - 1]["seq"] if 0 < k <= len(pr_steps) else -1
        hi = pr["seq"] if pr else 10 ** 9
        seq = None
        for s, tool, inp in tool_ev:
            if lo < s < hi and tool.lower() in EDIT_TOOLS and _same_file(inp, kf["path"]):
                seq = s
        if seq is None:
            seq = pr["seq"] if pr else None
        if seq is None:
            continue
        cards.append({"session": name, "file": kf["path"], "added": kf["added"], "removed": kf["removed"],
                      "lines": lines, "more": more, "seq": seq, "t_ms": t_of_seq.get(seq, 0),
                      "source": f"diffs/{name}.diff"})

    sources = ["events.jsonl"] + (["record.json"] if record else []) + \
        [f"diffs/{n}.diff" for n in sorted(diffs)] + (["transcript.jsonl"] if transcript else [])
    return {
        "layout": "review" if has_reviewer else "pr-tray",
        "visibility": V, "spec": S, "agent": agent,
        "context": context, "fitness_functions": rules,
        "consumers": consumers, "diff_cards": cards, "sources": sources,
    }


def read_trace(path: Path) -> list[dict]:
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def extras_sha256(extras: dict | None) -> str:
    """sha256 over the canonical JSON of the extras (record, diffs, transcript), so a cache notices their changes."""
    extras = extras or {}
    blob = json.dumps({k: extras.get(k) for k in ("record", "diffs", "transcript")}, ensure_ascii=False,
                      sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def load_extras(run_dir: Path) -> dict:
    """record.json, diffs/*.diff and transcript.jsonl of a run folder (whatever exists). Read-only."""
    out: dict = {"record": None, "diffs": {}, "transcript": []}
    rec = run_dir / "record.json"
    if rec.is_file():
        try:
            out["record"] = json.loads(rec.read_text(encoding="utf-8"))
        except ValueError:
            out["record"] = None
    ddir = run_dir / "diffs"
    if ddir.is_dir():
        for p in sorted(ddir.glob("*.diff")):
            out["diffs"][p.stem] = p.read_text(encoding="utf-8", errors="replace")
    tr = run_dir / "transcript.jsonl"
    if tr.is_file():
        with open(tr, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out["transcript"].append(json.loads(line))
                    except ValueError:
                        continue
    return out


def export(trace_path: Path, out_dir: Path, *, run_files: bool = True) -> Path:
    """Exports the trace; with run_files, the record/diffs/transcript next to the trace feed the scene block."""
    extras = load_extras(trace_path.parent) if run_files else None
    replay = build_replay(read_trace(trace_path), extras)
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
    ap.add_argument("--trace-only", action="store_true",
                    help="ignore record.json, diffs/ and transcript.jsonl next to the trace")
    args = ap.parse_args(argv)
    if not args.trace.is_file():
        print(f"trace not found: {args.trace}", file=sys.stderr)
        return 2
    try:
        target = export(args.trace, args.out, run_files=not args.trace_only)
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
