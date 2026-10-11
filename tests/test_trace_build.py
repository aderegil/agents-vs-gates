import copy
import unittest

from harness import jsonio, paths, trace
from trace.validate import validate_events

T0 = "2026-10-11T09:00"


def transcript():
    def ev(s, sess, kind, **kw):
        return {"ts": f"{T0}:{s:02d}.000Z", "session": sess, "kind": kind, **kw}
    return [ev(2, "gen", "text", text="I'll look at the event definition first."),
            ev(3, "gen", "tool_call", id="t1", name="Read", input={"file_path": r"C:\avg\wm1\r\src\core\events.ts"}),
            ev(4, "gen", "tool_result", id="t1", status="success", output="export interface OrderPlaced {\n  x"),
            ev(5, "gen", "tool_call", id="t2", name="Bash", input={"command": "npm test"}),     # never answered
            ev(6, "gen", "final", text="Renamed the fields.", subtype="success"),
            ev(40, "fix1", "text", text="Keep the old fields."),
            ev(41, "fix1", "tool_call", id="t3", name="Edit", input={"file_path": "src/core/events.ts"}),
            ev(42, "fix1", "tool_result", id="t3", status="denied", output="denied"),
            ev(43, "fix1", "final", text="Kept deprecated aliases.")]


def record():
    rec = copy.deepcopy(jsonio.read_json(paths.CONTRACTS / "examples" / "record.json"))
    rec["sessions"][0].update(ref="gen", started_at=f"{T0}:01.000Z", ended_at=f"{T0}:07.000Z",
                              diffstat={"files_changed": 2, "lines_added": 8, "lines_removed": 8})
    rec["sessions"][1].update(ref="fix1", started_at=f"{T0}:39.000Z", ended_at=f"{T0}:44.000Z",
                              diffstat={"files_changed": 1, "lines_added": 6, "lines_removed": 2})
    rec["ci"][0].update(started_at=f"{T0}:08.000Z", ended_at=f"{T0}:30.000Z")
    rec["ci"][1].update(started_at=f"{T0}:45.000Z", ended_at=f"{T0}:59.000Z")
    rec["detectors"].append({"attempt": 1, "ref": "fix1", "range": "gen..fix1",
                             "flags": [{"detector": "D6", "path": "contracts/consumers/x.json", "summary": "edited"}]})
    rec["timing"] = {"oracle_gen": {"started_at": "2026-10-11T09:01:00Z", "ended_at": "2026-10-11T09:01:05Z"},
                     "oracle_final": {"started_at": "2026-10-11T09:01:05Z", "ended_at": "2026-10-11T09:01:09Z"}}
    rec["ticket_text"] = "Clean up the OrderPlaced event."
    rec["context_file"] = "CLAUDE.md"
    return rec


class TraceBuildTest(unittest.TestCase):
    def test_valid_and_shaped_like_the_contract(self):
        ev = trace.build(record(), transcript())
        self.assertEqual(validate_events(ev), [])
        types = [e["event_type"] for e in ev]
        self.assertEqual(types[:4], ["SESSION_STARTED", "ARTIFACT_CREATED", "TASK_ASSIGNED", "ARTIFACT_READ"])
        md = ev[0]["metadata"]
        self.assertEqual(set(md), {"run_id", "stage", "source", "unit", "model", "adapter", "ticket", "condition",
                                   "cli_session_id", "context_file"})
        self.assertEqual(set(ev[-1]["payload"]["stats"]), {"run_outcome", "ticket_done", "turns", "repair_attempts",
                                                           "detectors", "ci_attempts"})
        self.assertEqual(ev[-1]["payload"]["stats"]["detectors"], ["D6"])
        self.assertTrue(all(e["metadata"]["instrument"] for e in ev if e["event_type"] == "ORACLE_RESULT"))
        self.assertEqual(types.count("ORACLE_RESULT"), 6)
        read = next(e for e in ev if e["event_type"] == "TOOL_CALL_STARTED")
        self.assertEqual(read["payload"]["input_summary"], "src/core/events.ts")
        closed = [e for e in ev if e["event_type"] == "TOOL_CALL_COMPLETED" and e["correlation_id"] == "t2"]
        self.assertEqual(closed[0]["payload"]["status"], "error")
        gate = next(e for e in ev if e["event_type"] == "GATE_TOUCHED")
        self.assertEqual(gate["metadata"]["detected_by"], "harness")
        upd = next(e for e in ev if e["event_type"] == "ARTIFACT_UPDATED")
        self.assertEqual(upd["payload"]["version"], 2)
        self.assertEqual(ev[types.index("PHASE_CHANGED")]["phase"], "review")
        narr = [e["visual"]["narration"] for e in ev if e["event_type"] == "CI_RUN_COMPLETED"]
        self.assertEqual(narr, ["CI failed: ARCH-4 — billing-service needs totalCents.", "CI passed: all checks green."])
        ts = [e["timestamp"] for e in ev]
        self.assertEqual(ts, sorted(ts))
        self.assertEqual([e["seq"] for e in ev], list(range(len(ev))))

    def test_oracle_contradicting_ci_is_narrated(self):
        rec = record()
        rec["ci"] = rec["ci"][1:]
        rec["ci"][0]["attempt"], rec["ci"][0]["ref"] = 0, "gen"
        rec["sessions"] = rec["sessions"][:1]
        rec["detectors"] = rec["detectors"][:1]
        rec["repair_attempts"] = 0
        rec["outcome"] = "passed_first_ci"
        rec["oracle"]["final"] = rec["oracle"]["gen"]
        ev = trace.build(rec, [e for e in transcript() if e["session"] == "gen"])
        self.assertEqual(validate_events(ev), [])
        narrated = [e for e in ev if e["event_type"] == "ORACLE_RESULT" and "visual" in e]
        self.assertEqual({e["payload"]["consumer"] for e in narrated}, {"billing-service", "analytics-ingest"})
        self.assertTrue(narrated[0]["visual"]["narration"].startswith("Staging: billing-service breaks although CI passed"))

    def test_infra_failure_aborts(self):
        rec = record()
        rec["outcome"] = "infra_failure"
        rec["infra_failure"] = {"kind": "rate_limited", "detail": "429", "reset_at": None}
        rec["ci"], rec["detectors"], rec["sessions"] = [], [], [dict(rec["sessions"][0], ref=None)]
        ev = trace.build(rec, [e for e in transcript() if e["session"] == "gen"])
        self.assertEqual(validate_events(ev), [])
        self.assertEqual(ev[-2]["event_type"], "ERROR_RAISED")
        self.assertEqual(ev[-1]["payload"]["outcome"], "aborted")


if __name__ == "__main__":
    unittest.main()
