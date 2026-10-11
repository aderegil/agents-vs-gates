import json
import unittest

from analysis import summarize
from tests._analysis_fixture import ResultsTree, standard_tree


class TestSummarize(unittest.TestCase):
    def test_blinded_tree(self):
        with ResultsTree() as t:
            standard_tree(t)
            t.write(unblinded=[])  # P1 complete but not unblinded
            agg = summarize.aggregate("real")
            json.dumps(agg)  # serializable
            self.assertFalse(agg["stages"]["P1"]["visible"])
            self.assertTrue(agg["stages"]["P0"]["visible"])
            self.assertEqual(agg["cells"], [])  # nothing visible in the main analysis
            self.assertTrue(agg["rq2"]["h2"]["blinded"])
            self.assertEqual(agg["calibration"]["runs"], 1)
            md = summarize.render_md(agg)
            self.assertIn("Blinded until stage complete", md)
            self.assertNotIn("3 of 4", md)

    def test_unblinded_p1(self):
        with ResultsTree() as t:
            standard_tree(t)
            t.write(unblinded=["P1"])
            agg = summarize.aggregate("real")
            self.assertEqual({c["stage"] for c in agg["cells"]}, {"P1"})  # P2 incomplete, P4 not unblinded, P0 apart
            h2 = agg["rq2"]["h2"]["tickets"]
            self.assertEqual((h2["X-rename"]["s0"]["x"], h2["X-rename"]["s0"]["n"]), (3, 4))  # contaminated excluded
            self.assertEqual((h2["X-rename"]["s2"]["x"], h2["X-rename"]["s2"]["n"]), (0, 4))  # infra excluded
            self.assertEqual((h2["X-remove"]["s0"]["x"], h2["X-remove"]["s2"]["x"]), (4, 0))
            self.assertIsNotNone(h2["X-rename"]["p_holm"])
            self.assertGreaterEqual(h2["X-rename"]["p_holm"], h2["X-rename"]["p"])
            box = {r["cell"]: r for r in agg["three_box"]}
            self.assertEqual(box["X-remove|V0|S2|W1|cc-sonnet"]["deprecated"], 4)
            self.assertEqual(box["X-rename|V0|S0|W1|cc-sonnet"]["done_breaks"], 3)
            self.assertEqual(agg["concordance"]["X-rename"]["ci_break_oracle_break"], 3)
            self.assertTrue(agg["concordance"]["X-rename"]["by_construction"])
            self.assertEqual([e["run_id"] for e in agg["excluded"]], ["p1-0017"])
            self.assertEqual(agg["infra"]["by_stage"], {"P1": {"api_error": 1}})
            self.assertEqual(agg["infra"]["final"], ["p1-0018"])
            md = summarize.render_md(agg)
            self.assertIn("3 of 4 [", md)
            self.assertNotIn("%)", md)  # N < 20 everywhere: no percentages
            self.assertIn("high by construction", md)

    def test_writes_files(self):
        with ResultsTree() as t:
            standard_tree(t)
            t.write(unblinded=["P1", "P4"])
            md = summarize.summarize("real")
            self.assertTrue(md.exists())
            for name in ("cells", "three_box", "h2", "repair_outcomes", "concordance", "rq4", "excluded", "infra"):
                self.assertTrue((md.parent / "tables" / f"{name}.csv").exists(), name)

    def test_rq4(self):
        with ResultsTree() as t:
            standard_tree(t)
            prs = {"schema": "prset/1", "prs": [
                {"pr_id": "pr-001", "run_id": "p1-0001", "stage": "P1", "category": "breaking", "repeat_subsample": True,
                 "affected_consumers": ["billing-service"]},
                {"pr_id": "pr-002", "run_id": "p1-0002", "stage": "P1", "category": "benign", "repeat_subsample": False,
                 "affected_consumers": []}], "shortfall": {"semantic": 10}}
            rv = []
            for rep, verdict in enumerate(["request_changes", "approve", "approve"], 1):
                rv.append({"review_id": f"r{rep}", "pr_id": "pr-001", "run_id": "p1-0001", "condition": "R-S0",
                           "rep": rep, "verdict": verdict, "reasons": ["x"], "duration_ms": 1000, "cost_usd": 0.01})
            rv.append({"review_id": "r9", "pr_id": "pr-002", "run_id": "p1-0002", "condition": "R-S0", "rep": 1,
                       "verdict": "approve", "reasons": [], "duration_ms": 3000, "cost_usd": 0.03})
            t.write(unblinded=["P1"], reviews=rv, pr_set=prs)
            rq4 = summarize.aggregate("real")["rq4"]
            self.assertTrue(rq4["available"])
            c = rq4["conditions"]["R-S0"]
            self.assertEqual((c["sensitivity"]["x"], c["sensitivity"]["n"]), (1, 1))
            self.assertEqual((c["specificity"]["x"], c["specificity"]["n"]), (1, 1))
            self.assertEqual(rq4["miss_rate"], [{"pr_id": "pr-001", "condition": "R-S0", "misses": 2, "reps": 3}])
            self.assertEqual(rq4["shortfall"], {"semantic": 10})


if __name__ == "__main__":
    unittest.main()
