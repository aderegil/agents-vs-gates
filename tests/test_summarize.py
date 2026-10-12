import json
import unittest

from analysis import summarize
from tests._analysis_fixture import ResultsTree, record, standard_tree


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



def _p6_tree(t):
    """standard_tree plus P6 codex runs: the P1 part (X-rename/X-remove V0·S0, V0·S2, V2·S0) and one P4 control on
    the same V0·S0 cell, which must stay out of the replication."""
    standard_tree(t)
    n = 0

    def add(ticket, V, S, part, broken):
        nonlocal n
        n += 1
        t.add(record(f"p6-{n:04d}", "P6", ticket, V, S, unit="codex",
                     broken=("billing-service",) if broken else ()))
        t.manifest_runs[-1]["part"] = part
    for i in range(3):
        add("X-rename", "V0", "S0", "P1", True)
        add("X-rename", "V0", "S2", "P1", i == 0)
        add("X-rename", "V2", "S0", "P1", False)
        add("X-remove", "V0", "S0", "P1", i < 2)
        add("X-remove", "V0", "S2", "P1", False)
    add("X-rename", "V0", "S0", "P4", False)          # concurrent control: same cell, other part


class TestReplication(unittest.TestCase):
    def test_blinded_with_p6(self):
        with ResultsTree() as t:
            _p6_tree(t)
            t.write(unblinded=["P1"])
            agg = summarize.aggregate("real")
            rep = agg["rq2"]["replication"]
            self.assertTrue(rep["blinded"])
            self.assertEqual((rep["h2"], rep["secondary_v2"]), ({}, {}))
            self.assertEqual(agg["stages"]["P6"]["runs_total"], 16)
            md = summarize.render_md(agg)
            self.assertIn("replication (P6, Codex)", md)
            self.assertIn("Stage P6: Blinded until stage complete", md)

    def test_codex_counts_apart_from_the_primary_unit(self):
        with ResultsTree() as t:
            _p6_tree(t)
            t.write(unblinded=["P1", "P6"])
            agg = summarize.aggregate("real")
            rep = agg["rq2"]["replication"]
            self.assertEqual((rep["unit"], rep["stage"], rep["part"], rep["blinded"], rep["available"]),
                             ("codex", "P6", "P1", False, True))
            h2 = rep["h2"]
            self.assertEqual((h2["X-rename"]["s0"]["x"], h2["X-rename"]["s0"]["n"]), (3, 3))   # P4 control left out
            self.assertEqual((h2["X-rename"]["s2"]["x"], h2["X-rename"]["s2"]["n"]), (1, 3))
            self.assertEqual((h2["X-remove"]["s0"]["x"], h2["X-remove"]["s2"]["x"]), (2, 0))
            self.assertGreaterEqual(h2["X-rename"]["p_holm"], h2["X-rename"]["p"])
            v2 = rep["secondary_v2"]
            self.assertEqual((v2["X-rename"]["v2"]["x"], v2["X-rename"]["v2"]["n"]), (0, 3))
            self.assertEqual(v2["X-remove"]["v2"]["n"], 0)
            self.assertIsNone(v2["X-remove"]["p"])
            prim = agg["rq2"]["h2"]["tickets"]                                                   # unchanged by P6
            self.assertEqual((prim["X-rename"]["s0"]["x"], prim["X-rename"]["s0"]["n"]), (3, 4))
            self.assertEqual(agg["rq2"]["h2"]["stage"], "P1")
            md = summarize.render_md(agg)
            self.assertIn("never pooled", md)
            self.assertIn("| X-rename | 3 of 3 [", md)

    def test_replication_tables(self):
        with ResultsTree() as t:
            _p6_tree(t)
            t.write(unblinded=["P1", "P6"])
            md = summarize.summarize("real")
            rows = (md.parent / "tables" / "h2_replication.csv").read_text(encoding="utf-8").splitlines()
            self.assertEqual(rows[0], "unit,stage,part,ticket,s0_x,s0_n,s2_x,s2_n,p,p_holm")
            self.assertTrue(rows[1].startswith("codex,P6,P1,X-rename,3,3,1,3,"))
            self.assertTrue((md.parent / "tables" / "secondary_v2_replication.csv").exists())

    def test_no_p6_in_the_manifest(self):
        with ResultsTree() as t:
            standard_tree(t)
            t.write(unblinded=["P1"])
            rep = summarize.aggregate("real")["rq2"]["replication"]
            self.assertFalse(rep["available"])
            self.assertIn("no P6 runs", rep["note"])


if __name__ == "__main__":
    unittest.main()
