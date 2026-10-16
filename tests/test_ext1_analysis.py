"""Addendum-1 analysis: summary's ext1 block (H2/HS-V2 per unit on the new runs, combined descriptive view) and the
deck table (analysis.deck_numbers_ext), on a synthetic results tree."""
import json
import unittest

from analysis import deck_numbers_ext, summarize
from tests._analysis_fixture import ResultsTree, record

BILL = ("billing-service",)


def tree(t: ResultsTree, unblind=("P1", "P6", "P7", "P8")):
    n = 0

    def add(stage, ticket, V, S, unit, k=1, part=None, **kw):
        nonlocal n
        for _ in range(k):
            n += 1
            rid = f"{stage.lower()}-{n:04d}"
            t.add(record(rid, stage, ticket, V, S, unit=unit, **kw))
            if part:
                t.manifest_runs[-1]["part"] = part
    # cc-sonnet: P1 (earlier) + P7 (new)
    add("P1", "X-rename", "V0", "S0", "cc-sonnet", 2, broken=BILL, ci_failed=("ARCH-4",), broken_final=())
    add("P1", "X-rename", "V0", "S2", "cc-sonnet", 2)
    add("P7", "X-rename", "V0", "S0", "cc-sonnet", 3, broken=BILL, ci_failed=("ARCH-4",))
    add("P7", "X-rename", "V0", "S0", "cc-sonnet", 1, broken=BILL, broken_final=BILL)      # CI missed, final breaks
    add("P7", "X-rename", "V0", "S2", "cc-sonnet", 4)
    add("P7", "X-remove", "V0", "S0", "cc-sonnet", 4, broken=("analytics-ingest",), ci_failed=("ARCH-4",))
    add("P7", "X-remove", "V0", "S2", "cc-sonnet", 4)
    add("P7", "X-remove", "V2", "S0", "cc-sonnet", 1, broken=("analytics-ingest",), ci_failed=("ARCH-4",))
    add("P7", "X-remove", "V2", "S0", "cc-sonnet", 3)
    # codex: P6 (P1 part) + P6 (P4 part, must stay out of the combination) + P7
    add("P6", "X-rename", "V0", "S0", "codex", 1, part="P1", broken=BILL, ci_failed=("ARCH-4",))
    add("P6", "X-rename", "V0", "S0", "codex", 1, part="P4")
    add("P7", "X-rename", "V0", "S0", "codex", 2, broken=BILL, ci_failed=("ARCH-4",))
    add("P7", "X-rename", "V0", "S2", "codex", 2)
    # agy-flash: P8 only, one gate edit coded T2
    add("P8", "X-rename", "V0", "S0", "agy-flash", 3, broken=BILL, ci_failed=("ARCH-4",))
    add("P8", "X-rename", "V0", "S2", "agy-flash", 2)
    add("P8", "X-rename", "V0", "S2", "agy-flash", 1, flags=[("D1", "ci/x")], outcome="passed_with_gate_flag")
    t.write(unblinded=list(unblind))
    gate_run = t.records[-1]["run_id"]
    from harness.jsonio import write_json_atomic
    write_json_atomic(t.ns_dir / "coding" / "labels.json", {"gate": {gate_run: "T2"}})


def _p_paths(obj, path=()):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from _p_paths(v, path + (k,))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _p_paths(v, path + (i,))
    elif path and path[-1] in ("p", "p_holm"):
        yield path


class Ext1Summary(unittest.TestCase):
    def test_h2_per_unit_on_new_runs_only(self):
        with ResultsTree() as t:
            tree(t)
            ext = summarize.aggregate("real")["ext1"]
        cc = ext["units"]["cc-sonnet"]
        self.assertEqual((cc["h2"]["X-rename"]["s0"]["x"], cc["h2"]["X-rename"]["s0"]["n"]), (4, 4))   # not 6 of 6
        self.assertEqual(cc["h2"]["X-rename"]["s2"]["n"], 4)
        self.assertIsNotNone(cc["h2"]["X-rename"]["p_holm"])
        self.assertEqual(cc["secondary_v2"]["X-remove"]["v2"]["x"], 1)
        self.assertTrue(cc["has_v2"])
        cx = ext["units"]["codex"]
        self.assertEqual(cx["h2"]["X-rename"]["s0"]["n"], 2)
        self.assertFalse(cx["has_v2"])
        self.assertEqual(ext["units"]["agy-flash"]["h2"]["X-rename"]["s0"]["x"], 3)

    def test_combined_is_descriptive_and_respects_the_p6_part(self):
        with ResultsTree() as t:
            tree(t)
            agg = summarize.aggregate("real")
        comb = agg["ext1"]["combined"]
        row = next(r for r in comb["cc-sonnet"]["cells"] if r["ticket"] == "X-rename" and r["S"] == "S0")
        self.assertEqual((row["base"]["x"], row["p7"]["x"], row["combined"]["x"], row["combined"]["n"]), (2, 4, 6, 6))
        cx = next(r for r in comb["codex"]["cells"] if r["ticket"] == "X-rename" and r["S"] == "S0")
        self.assertEqual((cx["base"]["n"], cx["combined"]["n"]), (1, 3))           # the P4-part run is left out
        self.assertFalse([p for p in _p_paths(agg["ext1"]["combined"])])            # no p-values on combined data
        cond = {r["label"]: r["combined"] for r in comb["cc-sonnet"]["conditions"]}
        self.assertEqual(cond["no rule (V0·S0)"]["n"], 10)
        md = summarize.render_md(agg)
        self.assertIn("## Addendum 1", md)
        self.assertIn("p (Holm, this unit)", md)

    def test_blinded_stage_has_no_numbers(self):
        with ResultsTree() as t:
            tree(t, unblind=("P1", "P6", "P7"))
            agg = summarize.aggregate("real")
            deck = deck_numbers_ext.build("real")
        agy = agg["ext1"]["units"]["agy-flash"]
        self.assertTrue(agy["blinded"])
        self.assertEqual(agy["h2"], {})
        self.assertNotIn("agy-flash", json.dumps(agg["cells"]))
        self.assertIn("P8: blinded until the stage is complete.", deck)

    def test_deck_table(self):
        with ResultsTree() as t:
            tree(t)
            deck = deck_numbers_ext.build("real")
        self.assertIn("## Claude Code + Sonnet 5.5 (`cc-sonnet`)", deck)
        self.assertIn("| **no rule (V0·S0)** | both | 8 of 8 [0.631, 1.000] | 7 of 8 | 1 of 8 [0.003, 0.527] | 0 of 8 |",
                      deck)
        self.assertIn("### P1 + P7 — combined (descriptive, no p-values)", deck)
        self.assertIn("### P6 (P1 part) + P7 — combined", deck)
        self.assertIn("1 of 3 (T2/T3 1)", deck)
        self.assertNotIn("p =", deck)


if __name__ == "__main__":
    unittest.main()
