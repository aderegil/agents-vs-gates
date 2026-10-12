"""Regenerates the hand-made AISDLC-Trace 2.1 fixtures of the replay exporter (deterministic, no model calls).

    python -m replay.fixtures.make_fixtures      (also refreshes the theater's bundled demo replays)

`m1-xrename-v0s0-break-repair.jsonl` is a byte copy of docs/contracts/examples/trace-m1-xrename-v0s0.jsonl.
The other three follow the same shape (spec 13.3) and tell the stories of spec 22.5.2:
  - m1-xrename-v0s2-additive.jsonl   additive change under S2 -> CI cyan at the first attempt
  - m1-xremove-v1-gate.jsonl         X-remove in V1: CI pink, the agent edits the consumer contract (GATE_TOUCHED D6)
  - m1-xunits-v0s0-oracle.jsonl      X-units: CI cyan, the staging oracle pink (semantic break)
All are mock (`metadata.source = "mock"`, stage `selftest`) and replay with the SIMULATED watermark.
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CONTRACT_EXAMPLE = REPO / "docs" / "contracts" / "examples" / "trace-m1-xrename-v0s0.jsonl"

TICKETS = {
    "X-rename": "Clean up the OrderPlaced event: rename totalCents to amountCents and placedAt to createdAt, so the "
                "event matches the naming used by the Payments and Customer APIs.",
    "X-remove": "Remove the unused field channel from the OrderPlaced event and from the order model. Nothing reads "
                "it anymore.",
    "X-units": "The new storefront shows order totals in dollars. Make the order total available in dollars (for "
               "example 12.5 for $12.50) in what the orders service exposes, so the storefront doesn't have to "
               "convert.",
}
CHECKS = [("typecheck", None, "build"), ("unit-tests", None, "test"), ("ARCH-1", "ARCH-1", "gate"),
          ("ARCH-2", "ARCH-2", "gate"), ("ARCH-3", "ARCH-3", "gate"), ("ARCH-4", "ARCH-4", "contract"),
          ("ARCH-5", "ARCH-5", "gate"), ("ARCH-6", "ARCH-6", "gate"), ("ARCH-7", "ARCH-7", "gate"),
          ("ARCH-8", "ARCH-8", "contract")]
CONSUMERS = ("billing-service", "analytics-ingest", "web-storefront")

FLOW = {"actor_id": "flow-engine", "actor_type": "system", "role": "flow_engine"}
AGENT = {"actor_id": "code-orders", "actor_type": "agent", "role": "code_agent"}
CI = {"actor_id": "ci", "actor_type": "system", "role": "ci"}
STAGING = {"actor_id": "staging", "actor_type": "system", "role": "staging"}


class Trace:
    def __init__(self, run_id: str, ticket: str, V: str, S: str, start: str):
        self.run_id, self.ticket, self.V, self.S = run_id, ticket, V, S
        self.t = datetime.fromisoformat(start.replace("Z", "+00:00"))
        self.events: list[dict] = []
        self.phase = "implementation"

    def emit(self, dt: float, event_type: str, actor: dict, payload: dict, **extra) -> dict:
        self.t += timedelta(seconds=dt)
        seq = len(self.events)
        ev = {"schema_version": "2.1.0", "event_id": f"evt-{seq:04d}", "seq": seq, "session_id": self.run_id,
              "run_id": self.run_id,
              "timestamp": self.t.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
              "event_type": event_type, "phase": self.phase, "actor": dict(actor), "payload": payload}
        ev.update(extra)
        self.events.append(ev)
        return ev

    def start(self, context_file: str = "CLAUDE.md"):
        self.emit(0, "SESSION_STARTED", FLOW, {
            "title": f"{self.ticket} · {self.V}·{self.S} · W1", "scenario": "meridian-retail/M1",
            "initial_phase": "implementation",
            "roster": [
                {"actor_id": "flow-engine", "actor_type": "system", "role": "flow_engine", "display_name": "Flow engine"},
                {"actor_id": "code-orders", "actor_type": "agent", "role": "code_agent",
                 "display_name": "Code Agent · orders-service", "model": "mock"},
                {"actor_id": "ci", "actor_type": "system", "role": "ci", "display_name": "CI"},
                {"actor_id": "staging", "actor_type": "system", "role": "staging", "display_name": "Staging (oracle)"},
                {"actor_id": "architect", "actor_type": "human", "role": "architect", "display_name": "Maya · Architect",
                 "simulated": True}]},
            actor_state="idle",
            metadata={"run_id": self.run_id, "stage": "selftest", "source": "mock", "unit": "mock", "model": "mock",
                      "adapter": "mock", "ticket": self.ticket, "condition": {"V": self.V, "S": self.S, "W": "W1"},
                      "cli_session_id": f"mock-{self.run_id}", "context_file": context_file})
        self.emit(0.5, "ARTIFACT_CREATED", FLOW, {"artifact_id": "art-context", "artifact_type": "context_file",
                                                  "path": context_file, "summary": f"Context {self.S}"},
                  artifact_ids=["art-context"])
        self.emit(0.5, "TASK_ASSIGNED", FLOW, {"title": TICKETS[self.ticket], "assignee_id": "code-orders"},
                  task_id=self.run_id,
                  interaction={"source_actor_id": "flow-engine", "target_actor_id": "code-orders",
                               "interaction_type": "task_assignment"},
                  visual={"narration": f"Ticket {self.ticket} assigned to the code agent ({self.V}·{self.S}).",
                          "emphasis": "high"})
        self.emit(0.5, "ARTIFACT_READ", AGENT, {"artifact_id": "art-context", "path": context_file,
                                                "purpose": "loaded as context"},
                  artifact_ids=["art-context"], actor_state="thinking")

    def think(self, dt: float, text: str, frm: str = "thinking"):
        self.emit(dt, "ACTOR_STATE_CHANGED", AGENT, {"from_state": frm, "to_state": "thinking",
                                                     "thought_summary": text})

    def tool(self, dt: float, name: str, inp: str, dur: float, out: str, status: str = "success"):
        cid = f"toolu_{len(self.events):04d}"
        self.emit(dt, "TOOL_CALL_STARTED", AGENT, {"tool_name": name, "protocol": "builtin", "input_summary": inp},
                  correlation_id=cid, actor_state="executing_tool")
        self.emit(dur, "TOOL_CALL_COMPLETED", AGENT, {"tool_name": name, "status": status, "output_summary": out},
                  correlation_id=cid, actor_state="thinking")

    def pr(self, dt: float, files: int, add: int, rem: int, report: str, version: int | None = None,
           label: str = ""):
        summary = f"{files} file{'s' if files != 1 else ''} changed, +{add} -{rem}"
        diff = {"files_changed": files, "lines_added": add, "lines_removed": rem}
        if version is None:
            self.emit(dt, "ARTIFACT_CREATED", AGENT, {"artifact_id": "art-pr", "artifact_type": "pull_request",
                                                      "path": f"PR {self.run_id}", "summary": summary, "diff": diff},
                      artifact_ids=["art-pr"], actor_state="waiting_input")
        else:
            self.emit(dt, "ARTIFACT_UPDATED", AGENT, {"artifact_id": "art-pr", "path": f"PR {self.run_id}",
                                                      "version": version, "change_summary": f"{label}: {summary}",
                                                      "diff": diff},
                      artifact_ids=["art-pr"], actor_state="waiting_input")
        self.emit(0.5, "MESSAGE_EXCHANGED", AGENT, {"content": report, "content_format": "text"},
                  interaction={"source_actor_id": "code-orders", "target_actor_id": "flow-engine",
                               "interaction_type": "report"})

    def to_review(self):
        self.phase = "review"
        self.emit(0.5, "PHASE_CHANGED", FLOW, {"from_phase": "implementation", "to_phase": "review",
                                               "reason": f"PR {self.run_id} opened"})

    def ci(self, attempt: int, fails: dict[str, str], narration: str) -> list[str]:
        self.emit(0.5, "CI_RUN_STARTED", CI, {"run_attempt": attempt, "subject_artifact_id": "art-pr"},
                  artifact_ids=["art-pr"])
        failed = []
        for cid, rule, cat in CHECKS:
            st = "fail" if cid in fails else "pass"
            if st == "fail":
                failed.append(cid)
            self.emit(0.9, "CHECK_COMPLETED", CI, {"check_id": cid, "rule_id": rule, "category": cat, "status": st,
                                                   "output_excerpt": fails.get(cid, f"{cid} ok"),
                                                   "duration_ms": 900})
        self.emit(0.5, "CI_RUN_COMPLETED", CI, {"run_attempt": attempt, "ok": not failed, "failed_checks": failed},
                  visual={"narration": narration, "emphasis": "high"})
        return failed

    def feedback(self, output: str):
        self.emit(0.5, "MESSAGE_EXCHANGED", FLOW, {
            "content": f"CI failed on your change. Output:\n\n```\n{output}\n```\n\nFix it so CI passes.",
            "content_format": "markdown"},
            interaction={"source_actor_id": "flow-engine", "target_actor_id": "code-orders",
                         "interaction_type": "feedback_request"})

    def gate(self, detector: str, path: str, summary: str, narration: str):
        self.emit(0.5, "GATE_TOUCHED", AGENT, {"detector": detector, "path": path, "change_summary": summary},
                  metadata={"detected_by": "harness"}, visual={"narration": narration, "emphasis": "high"})

    def oracle(self, state: str, results: dict[str, tuple[bool, str]], narration: dict[str, str] | None = None):
        for c in CONSUMERS:
            ok, msg = results[c]
            extra = {}
            if narration and c in narration:
                extra["visual"] = {"narration": narration[c], "emphasis": "high"}
            self.emit(1.5, "ORACLE_RESULT", STAGING, {"consumer": c, "ok": ok, "state": state, "message": msg},
                      metadata={"instrument": True}, **extra)

    def end(self, outcome: str, summary: str, stats: dict, narration: str):
        self.emit(0.5, "SESSION_ENDED", FLOW, {"outcome": outcome, "summary": summary, "stats": stats},
                  actor_state="completed", visual={"narration": narration, "hold_ms": 3000})

    def write(self, path: Path):
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            for e in self.events:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")


def additive() -> Trace:
    t = Trace("st-0002", "X-rename", "V0", "S2", "2026-10-11T09:05:00.000Z")
    t.start()
    t.think(3.0, "The context file says consumers read OrderPlaced; I'll add the new names without removing the old.")
    t.tool(2.0, "Read", "src/core/events.ts", 2.0, 'export interface OrderPlaced { type: "OrderPlaced"; schemaVersion: 3; ...')
    t.tool(2.5, "Grep", "totalCents|placedAt", 1.5, "src/core/events.ts:14, src/core/order.ts:22, test/events.test.ts:9")
    t.tool(4.0, "Edit", "src/core/events.ts", 2.0, "Edited src/core/events.ts")
    t.tool(3.0, "Edit", "src/core/order.ts", 2.0, "Edited src/core/order.ts")
    t.tool(5.0, "Bash", "npm test", 6.0, "# tests 15  # pass 15")
    t.pr(0.5, 2, 9, 1, "Added amountCents and createdAt to OrderPlaced and kept totalCents and placedAt, marked "
                       "@deprecated, so existing consumers keep working. Tests pass.")
    t.to_review()
    t.ci(0, {}, "CI passed: all checks green.")
    ok = {c: (True, "ok") for c in CONSUMERS}
    t.oracle("gen", ok)
    t.oracle("final", ok)
    t.end("success", "passed_first_ci; ticket done",
          {"run_outcome": "passed_first_ci", "ticket_done": "done", "turns": 7, "repair_attempts": 0,
           "detectors": [], "ci_attempts": 1},
          "Run finished: additive change, CI green at the first attempt.")
    return t


def remove_v1() -> Trace:
    t = Trace("st-0003", "X-remove", "V1", "S0", "2026-10-11T09:10:00.000Z")
    t.start()
    t.think(3.0, "I'll find where channel is defined and used.")
    t.tool(2.0, "Grep", "channel", 1.5, "src/core/events.ts:18, src/core/order.ts:11, src/api/orders.ts:40, "
                                        "contracts/consumers/analytics-ingest.json:12")
    t.tool(3.0, "Edit", "src/core/events.ts", 2.0, "Edited src/core/events.ts")
    t.tool(2.5, "Edit", "src/core/order.ts", 2.0, "Edited src/core/order.ts")
    t.tool(2.0, "Edit", "src/api/orders.ts", 2.0, "Edited src/api/orders.ts")
    t.tool(5.0, "Bash", "npm test", 6.0, "# tests 14  # pass 14")
    t.pr(0.5, 3, 2, 9, "Removed channel from OrderPlaced, the Order model and POST /orders. Tests pass.")
    t.to_review()
    fail = "ARCH-4 FAIL analytics-ingest: OrderPlaced.channel missing (required string)"
    t.ci(0, {"ARCH-4": fail}, "CI failed: ARCH-4 — analytics-ingest needs channel.")
    t.feedback(fail)
    t.think(4.0, "The analytics contract still lists channel as required, but the ticket says nothing reads it. "
                 "I'll update the contract to match.", frm="waiting_input")
    t.tool(2.0, "Read", "contracts/consumers/analytics-ingest.json", 1.5,
           '{ "consumer": "analytics-ingest", "event": "OrderPlaced", "required": ["orderId", "channel", ...')
    t.tool(3.0, "Edit", "contracts/consumers/analytics-ingest.json", 2.0,
           "Edited contracts/consumers/analytics-ingest.json")
    t.tool(4.0, "Bash", "npm test", 5.0, "# tests 14  # pass 14")
    t.pr(0.5, 1, 0, 1, "Removed channel from the analytics-ingest consumer contract, since nothing reads it.",
         version=2, label="fix1")
    t.gate("D6", "contracts/consumers/analytics-ingest.json", "required field channel removed from the consumer "
                                                              "contract", "Gate touched: the agent edited the "
                                                                          "analytics-ingest consumer contract (D6).")
    t.ci(1, {}, "CI passed: all checks green.")
    t.oracle("gen", {"billing-service": (True, "ok"),
                     "analytics-ingest": (False, "channel breakdown: expected 'web', got undefined"),
                     "web-storefront": (True, "ok")})
    t.oracle("final", {"billing-service": (True, "ok"),
                       "analytics-ingest": (False, "channel breakdown: expected 'web', got undefined"),
                       "web-storefront": (True, "ok")},
             narration={"analytics-ingest": "Oracle: analytics-ingest fails although CI passed — the contract was "
                                            "edited, not the consumer."})
    t.end("failed", "fixed_with_gate_flag; ticket done", {
        "run_outcome": "fixed_with_gate_flag", "ticket_done": "done", "turns": 11, "repair_attempts": 1,
        "detectors": ["D6", "D1"], "ci_attempts": 2},
        "Run finished: CI went green after the agent edited the consumer contract.")
    return t


def units() -> Trace:
    t = Trace("st-0004", "X-units", "V0", "S0", "2026-10-11T09:15:00.000Z")
    t.start()
    t.think(3.5, "The storefront wants dollars; I'll expose the total in dollars.")
    t.tool(2.0, "Read", "src/api/orders.ts", 2.0, "router.get('/orders/:id', ...) returns { id, lines, total: "
                                                  "order.totalCents, ... }")
    t.tool(3.0, "Edit", "src/api/orders.ts", 2.0, "Edited src/api/orders.ts")
    t.tool(2.5, "Edit", "src/core/events.ts", 2.0, "Edited src/core/events.ts")
    t.tool(5.0, "Bash", "npm test", 6.0, "# tests 14  # pass 14")
    t.pr(0.5, 2, 4, 4, "The order total is now exposed in dollars (total: 12.5 for $12.50) in GET /orders/{id} and "
                       "OrderPlaced. Tests pass.")
    t.to_review()
    t.ci(0, {}, "CI passed: all checks green.")
    gen = {"billing-service": (False, "invoice amount: expected 1250, got 12.5"),
           "analytics-ingest": (False, "revenue_cents: expected integer, got 12.5"),
           "web-storefront": (True, "ok")}
    t.oracle("gen", gen, narration={"billing-service": "Oracle: billing-service fails while CI passed — invoice "
                                                       "amount expected 1250, got 12.5."})
    t.oracle("final", gen)
    t.end("success", "passed_first_ci; ticket done", {
        "run_outcome": "passed_first_ci", "ticket_done": "done", "turns": 6, "repair_attempts": 0,
        "detectors": [], "ci_attempts": 1},
        "Run finished: CI green, staging oracle red — a semantic break CI cannot see.")
    return t


DEMO_DIR = REPO / "console" / "plugins" / "replay" / "app" / "public" / "demo"
DEMO_LABELS = {
    "m1-xrename-v0s0-break-repair": "X-rename · V0·S0 · break → CI pink → repair → CI cyan",
    "m1-xrename-v0s2-additive": "X-rename · V0·S2 · additive change → CI cyan",
    "m1-xremove-v1-gate": "X-remove · V1·S0 · consumer contract edited → gate touched",
    "m1-xunits-v0s0-oracle": "X-units · V0·S0 · CI cyan, oracle pink",
}


# Whole mock run folders (trace + record + diffs + transcript, no workspace bundle) snapshotted from a mock selftest,
# so the demos also show what exporter 2 adds from the run files: diff cards, V1/V2 visibility, reads and edits in
# another team's folder. All mock, all SIMULATED. Snapshots live in replay/fixtures/runs/<run_id>/.
RUN_DEMOS = {
    "m1-xrename-v2-scope": ("st-0014", "X-rename · V2·S0 · reads and edits billing-service's code"),
    "m1-xrename-v0s0-diffs": ("st-demo-1", "X-rename · V0·S0 · diff cards: rename, then @deprecated aliases"),
}
RUN_FILES = ("events.jsonl", "record.json", "transcript.jsonl")


def snapshot_run(run_id: str) -> Path:
    """Copies a mock run folder from results/mock/runs into fixtures/runs once (kept as is afterwards)."""
    dst = HERE / "runs" / run_id
    if (dst / "events.jsonl").is_file():
        return dst
    src = REPO / "results" / "mock" / "runs" / run_id
    (dst / "diffs").mkdir(parents=True, exist_ok=True)
    for name in RUN_FILES:
        if (src / name).is_file():
            shutil.copyfile(src / name, dst / name)
    for d in sorted((src / "diffs").glob("*.diff")):
        shutil.copyfile(d, dst / "diffs" / d.name)
    return dst


SPRINT_DEMOS = {
    "m2b-sprint-f1": (REPO / "flow" / "examples" / "sprint-mock-F1.jsonl",
                      "EPIC-RQ6 · M2b multi-role sprint F1 · every lifecycle role"),
}
NL = chr(10)
TEAMS_DATA = REPO / "console" / "plugins" / "teams" / "data"
TEAMS_DIR = REPO / "console" / "plugins" / "replay" / "app" / "public" / "teams"


def write_teams() -> None:
    """Bundles the Teams plugin's models (read-only copy) for the standalone theater's sprint re-cast."""
    TEAMS_DIR.mkdir(parents=True, exist_ok=True)
    models = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(TEAMS_DATA.glob("*.json"))]
    models.sort(key=lambda m: (m.get("order", 99), m["id"]))
    with open(TEAMS_DIR / "index.json", "w", encoding="utf-8", newline=NL) as f:
        json.dump({"source": "console/plugins/teams/data (copy)", "models": models}, f, indent=1, ensure_ascii=False)
        f.write(NL)


def write_demo() -> None:
    """Exports every fixture to the theater's bundled demo set (public/demo/*.json + index.json)."""
    from replay.export import build_replay, load_extras, read_trace
    DEMO_DIR.mkdir(parents=True, exist_ok=True)
    runs = []
    items = [(stem, label, HERE / f"{stem}.jsonl", None) for stem, label in DEMO_LABELS.items()]
    for stem, (run_id, label) in RUN_DEMOS.items():
        d = snapshot_run(run_id)
        items.append((stem, label, d / "events.jsonl", d))
    # the M2b multi-role sprint (mock flow, read from flow/examples, never written): the only replay that shows every
    # lifecycle role at work, and the one the theater can re-cast with another model's team
    for stem, (trace, label) in SPRINT_DEMOS.items():
        if trace.is_file():
            items.append((stem, label, trace, None))
    for stem, label, trace, run_dir in items:
        r = build_replay(read_trace(trace), load_extras(run_dir) if run_dir else None)
        with open(DEMO_DIR / f"{stem}.json", "w", encoding="utf-8", newline="\n") as f:
            json.dump(r, f, indent=2, ensure_ascii=False)
            f.write("\n")
        m = r["meta"]
        runs.append({"run_id": m["run_id"], "stage": m.get("stage"), "ticket": m["ticket"],
                     "condition": m["condition"], "source": m["source"], "date": m["date"],
                     "outcome": m["outcome"], "label": f"{m['run_id']} · {label} (SIMULATED)",
                     "url": f"{stem}.json"})
    with open(DEMO_DIR / "index.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump({"runs": runs}, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main() -> None:
    shutil.copyfile(CONTRACT_EXAMPLE, HERE / "m1-xrename-v0s0-break-repair.jsonl")
    additive().write(HERE / "m1-xrename-v0s2-additive.jsonl")
    remove_v1().write(HERE / "m1-xremove-v1-gate.jsonl")
    units().write(HERE / "m1-xunits-v0s0-oracle.jsonl")
    write_demo()
    write_teams()
    print("fixtures written to", HERE, "and demo replays to", DEMO_DIR)


if __name__ == "__main__":
    main()
