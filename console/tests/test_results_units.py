"""Results payload: HS-V2 on the primary unit, the Codex replication (P6's P1 part) and X-remove V1·S0 on each unit,
side by side. Synthetic results tree (tests/_analysis_fixture.py); nothing calls a model or a runner."""
import unittest

from console.plugins.results import payload
from tests._analysis_fixture import ResultsTree, record
from tests.test_summarize import _p6_tree


def _tree(t, unblind):
    _p6_tree(t)   # standard tree (P1 cc-sonnet, one P2 V1·S0 run) + P6 codex P1 part + one P4 control
    for i in range(3):
        t.add(record(f"p6-v1{i}", "P6", "X-remove", "V1", "S0", unit="codex", broken=("analytics-ingest",),
                     flags=[("D6", "contracts/consumers/analytics-ingest__OrderPlaced.json")],
                     outcome="passed_with_gate_flag"))
        t.manifest_runs[-1]["part"] = "P2"
    t.write(unblinded=unblind)


class TestResultsUnits(unittest.TestCase):
    def test_replication_v2_and_v1_side_by_side(self):
        with ResultsTree() as t:
            _tree(t, ["P1", "P6"])
            p = payload.rq_payload("real")
            rq2 = p["sections"]["rq2"]
            self.assertEqual(rq2["h2"]["unit"], "cc-sonnet")
            v2 = rq2["secondary_v2"]
            self.assertEqual((v2["unit"], v2["stage"]), ("cc-sonnet", "P1"))
            rep = rq2["replication"]
            self.assertEqual((rep["unit"], rep["stage"], rep["part"], rep["blinded"]), ("codex", "P6", "P1", False))
            h2 = {r["ticket"]: r for r in rep["h2"]}
            self.assertEqual((h2["X-rename"]["s0"]["x"], h2["X-rename"]["s0"]["n"]), (3, 3))   # the P4 control left out
            self.assertIn("pre-registered", rq2["note"])
            # P2 is not complete in the standard tree, so only P6's V1 cell is visible: no side-by-side yet
            self.assertIsNone(p["sections"]["rq3"]["v1_units"])

    def test_v1_units_when_both_stages_are_visible(self):
        with ResultsTree() as t:
            _tree(t, ["P1", "P6"])
            t.state_runs = {k: (v if not k.startswith("p2-") else {"status": "done"}) for k, v in t.state_runs.items()}
            t.manifest_runs = [r for r in t.manifest_runs if not (r["stage"] == "P2" and r["run_id"] not in
                                                                  {x["run_id"] for x in t.records})]
            t.write(unblinded=["P1", "P2", "P6"])
            v = payload.rq_payload("real")["sections"]["rq3"]["v1_units"]
            self.assertEqual([(c["stage"], c["unit"]) for c in v["columns"]], [("P2", "cc-sonnet"), ("P6", "codex")])
            rows = {r["measure"]: r for r in v["rows"]}
            gate = rows["Gate touched (detector flag)"]
            self.assertEqual((gate["c1"]["x"], gate["c1"]["n"]), (3, 3))
            self.assertEqual(rows["Outcome: Passed, gate touched"]["c1"], {"x": 3, "n": 3})
            self.assertIn("Descriptive", v["note"])

    def test_blinded_p6_carries_no_replication_numbers(self):
        with ResultsTree() as t:
            _tree(t, ["P1"])
            rep = payload.rq_payload("real")["sections"]["rq2"]["replication"]
            self.assertTrue(rep["blinded"])
            self.assertEqual((rep["h2"], rep["secondary_v2"]), ([], []))

    def test_no_p6_no_replication_panel(self):
        from tests._analysis_fixture import standard_tree
        with ResultsTree() as t:
            standard_tree(t)
            t.write(unblinded=["P1"])
            self.assertIsNone(payload.rq_payload("real")["sections"]["rq2"]["replication"])


if __name__ == "__main__":
    unittest.main()
