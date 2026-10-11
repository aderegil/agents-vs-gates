"""Codex audit 2026-10-11: three-box on matching states, Holm family fixed at 2, secondary V2.S0 contrast."""
import io
import unittest
from contextlib import redirect_stdout

from analysis import stats, summarize
from tests._analysis_fixture import ResultsTree, record


def _p1(t, rid, ticket, V, S, **kw):
    t.add(record(rid, "P1", ticket, V, S, **kw))


class TestThreeBoxStates(unittest.TestCase):
    def test_gen_and_final_tables_do_not_mix(self):
        with ResultsTree() as t:
            # repair undid the ticket and fixed the break: first attempt done&breaks, final not_done
            _p1(t, "p1-0001", "X-remove", "V0", "S0", broken=("analytics-ingest",), ticket_done="not_done",
                ticket_done_gen="done")
            # repair kept the ticket done but the break survives to the end
            _p1(t, "p1-0002", "X-remove", "V0", "S0", broken=("analytics-ingest",), broken_final=("analytics-ingest",),
                ticket_done="done", ticket_done_gen="done")
            # older record: no ticket_done_gen -> falls back to ticket_done
            _p1(t, "p1-0003", "X-remove", "V0", "S0", ticket_done="deprecated")
            t.write(unblinded=["P1"])
            agg = summarize.aggregate("real")
            first, final = agg["three_box"][0], agg["three_box_final"][0]
            self.assertEqual((first["done_breaks"], first["done_safe"], first["deprecated"], first["not_done"]), (2, 0, 1, 0))
            self.assertEqual((final["done_breaks"], final["done_safe"], final["deprecated"], final["not_done"]), (1, 0, 1, 1))
            md = summarize.render_md(agg)
            self.assertIn("ticket_done_gen", md)
            self.assertIn("staging_break_final", md)
            out = summarize.summarize("real")
            self.assertTrue((out.parent / "tables" / "three_box_final.csv").exists())


class TestHolmFamilyFixed(unittest.TestCase):
    def test_holm_with_explicit_family(self):
        self.assertEqual(stats.holm({"a": 0.02, "b": 1.0})["a"], 0.04)

    def test_missing_ticket_does_not_shrink_correction(self):
        with ResultsTree() as t:
            for i in range(4):
                _p1(t, f"p1-{i:04d}", "X-rename", "V0", "S0", broken=("billing-service",))
                _p1(t, f"p1-{i + 10:04d}", "X-rename", "V0", "S2")
            t.write(unblinded=["P1"])   # X-remove has no runs at all
            tk = summarize.aggregate("real")["rq2"]["h2"]["tickets"]
            self.assertIsNone(tk["X-remove"]["p"])
            self.assertIsNone(tk["X-remove"]["p_holm"])
            p = tk["X-rename"]["p"]
            self.assertAlmostEqual(tk["X-rename"]["p_holm"], min(1.0, 2 * p))
            self.assertGreater(tk["X-rename"]["p_holm"], p)

    def test_both_present_is_monotone(self):
        with ResultsTree() as t:
            for i in range(4):
                _p1(t, f"p1-{i:04d}", "X-rename", "V0", "S0", broken=("billing-service",))
                _p1(t, f"p1-{i + 10:04d}", "X-rename", "V0", "S2")
                _p1(t, f"p1-{i + 20:04d}", "X-remove", "V0", "S0", broken=("analytics-ingest",) if i < 2 else ())
                _p1(t, f"p1-{i + 30:04d}", "X-remove", "V0", "S2")
            t.write(unblinded=["P1"])
            tk = summarize.aggregate("real")["rq2"]["h2"]["tickets"]
            lo, hi = sorted((tk["X-rename"], tk["X-remove"]), key=lambda v: v["p"])
            self.assertAlmostEqual(lo["p_holm"], min(1.0, 2 * lo["p"]))
            self.assertGreaterEqual(hi["p_holm"], lo["p_holm"])


class TestSecondaryV2(unittest.TestCase):
    def test_no_v2_cells(self):
        with ResultsTree() as t:
            for i in range(4):
                _p1(t, f"p1-{i:04d}", "X-rename", "V0", "S0")
            t.write(unblinded=["P1"])
            agg = summarize.aggregate("real")
            sec = agg["rq2"]["secondary_v2"]
            self.assertFalse(sec["available"])
            self.assertEqual(sec["label"], "secondary (pre-registered)")
            self.assertIn("no V2·S0 runs in P1", sec["note"])
            self.assertIn("no V2·S0 runs in P1", summarize.render_md(agg))
            md = summarize.summarize("real")
            self.assertTrue((md.parent / "tables" / "secondary_v2.csv").exists())

    def test_with_v2_cells_outside_holm(self):
        with ResultsTree() as t:
            for i in range(5):
                _p1(t, f"p1-{i:04d}", "X-rename", "V0", "S0", broken=("billing-service",))
                _p1(t, f"p1-{i + 10:04d}", "X-rename", "V2", "S0")
                _p1(t, f"p1-{i + 20:04d}", "X-rename", "V0", "S2")
            t.write(unblinded=["P1"])
            agg = summarize.aggregate("real")
            sec = agg["rq2"]["secondary_v2"]
            self.assertTrue(sec["available"])
            v = sec["tickets"]["X-rename"]
            self.assertEqual((v["v0"]["x"], v["v0"]["n"], v["v2"]["x"], v["v2"]["n"]), (5, 5, 0, 5))
            self.assertAlmostEqual(v["p"], stats.fisher_exact(5, 0, 0, 5))
            self.assertIsNone(sec["tickets"]["X-remove"]["p"])
            self.assertEqual(len(v["v2"]["ci"]), 2)
            h2 = agg["rq2"]["h2"]["tickets"]["X-rename"]      # H2 untouched by the V2 runs
            self.assertEqual(h2["s0"]["n"], 5)
            self.assertNotIn("p_holm", v)
            md = summarize.render_md(agg)
            self.assertIn("secondary (pre-registered)", md)

    def test_blinded_like_h2(self):
        with ResultsTree() as t:
            for i in range(4):
                _p1(t, f"p1-{i:04d}", "X-rename", "V2", "S0", broken=("billing-service",))
            t.write(unblinded=[])
            agg = summarize.aggregate("real")
            sec = agg["rq2"]["secondary_v2"]
            self.assertTrue(sec["blinded"])
            self.assertEqual(sec["tickets"], {})
            self.assertNotIn("4 of 4 [", summarize.render_md(agg))


if __name__ == "__main__":
    unittest.main()
