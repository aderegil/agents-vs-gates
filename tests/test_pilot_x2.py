"""Pilot X2 (X-remove V0 vs V2 after the scenario fix), its pre-registered decision rule and the two P1 variants.
No model call, no runner launch outside --dry-run, results root in a temp folder."""
import io
import json
import os
import shutil
import tempfile
import unittest
from collections import Counter
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from analysis import summarize, xremove_rule
from harness import blinding, jsonio, manifest, paths, runner


class _TempResults(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-x2-"))
        self.env = os.environ.get("AVG_RESULTS_ROOT")
        os.environ["AVG_RESULTS_ROOT"] = str(self.tmp)

    def tearDown(self):
        if self.env is None:
            os.environ.pop("AVG_RESULTS_ROOT", None)
        else:
            os.environ["AVG_RESULTS_ROOT"] = self.env
        shutil.rmtree(self.tmp, ignore_errors=True)


class X2ManifestTest(unittest.TestCase):
    def test_x2_runs_blocks_of_two_and_ids(self):
        runs = manifest.pilot_runs("real", "X2")
        self.assertEqual([r["run_id"] for r in runs], [f"x2-{i:04d}" for i in range(1, 11)])
        self.assertEqual(Counter(r["visibility"] for r in runs), {"V0": 5, "V2": 5})
        for b in range(5):                                # every block of 2 = one V0 and one V2
            block = runs[2 * b:2 * b + 2]
            self.assertEqual({r["visibility"] for r in block}, {"V0", "V2"})
            self.assertTrue(all(r["replicate"] == b + 1 == r["round"] for r in block))
        self.assertTrue(all(r["stage"] == "X2" and r["unit"] == "cc-sonnet" and r["ticket"] == "X-remove"
                            and r["spec"] == "S0" and r["wording"] == "W1" and r["paraphrase"] is None
                            and r["pilot"] for r in runs))
        # pinned order (seed 20261013): a change here re-randomizes X2
        self.assertEqual([r["visibility"] for r in runs], ["V2", "V0", "V0", "V2", "V2", "V0", "V2", "V0", "V0", "V2"])
        self.assertEqual(runs, manifest.pilot_runs("real", "X2"))

    def test_mock_namespace_has_x2_with_unit_mock(self):
        runs = manifest.pilot_runs("mock", "X2")
        self.assertEqual(len(runs), 10)
        self.assertTrue(all(r["unit"] == "mock" and r["run_id"].startswith("x2-") for r in runs))

    def test_pilots_appended_beside_the_manifest(self):
        m = manifest.generate()
        merged = manifest.with_pilots(m, "real")
        self.assertEqual(manifest.validate(merged), [])
        self.assertEqual(merged["runs"][:len(m["runs"])], m["runs"])
        self.assertEqual(Counter(r["stage"] for r in merged["runs"][len(m["runs"]):]), {"X1": 80, "X2": 10})
        self.assertEqual(merged["pilots"], {"X1": {"seed": 20261012, "runs": 80}, "X2": {"seed": 20261013, "runs": 10}})
        self.assertNotIn("pilots", m)

    def test_x2_visible_and_exploratory(self):
        self.assertTrue(blinding.is_visible({}, "X2"))
        self.assertIn("X2", runner.STAGES)
        self.assertIn("X2", runner.EXPLORATORY)


class X2RunnerTest(_TempResults):
    def setUp(self):
        super().setUp()
        paths.manifest_path("real").parent.mkdir(parents=True, exist_ok=True)
        jsonio.write_json_atomic(paths.manifest_path("real"), manifest.generate())
        self.sha = manifest.sha256(paths.manifest_path("real"))

    def test_dry_run_needs_no_unit_and_never_changes_the_manifest_file(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = runner.main(["--stage", "X2", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("x2-0001", out.getvalue())
        self.assertIn("10 run(s) would run", out.getvalue())
        self.assertEqual(manifest.sha256(paths.manifest_path("real")), self.sha)

    def test_guards(self):
        errs = runner.guard_errors("real", "X2", {"cc-sonnet"})
        self.assertFalse(any("pre-registration" in e for e in errs), errs)
        self.assertTrue(any("smoke" in e for e in errs), errs)

    def test_status_lists_x2(self):
        s = runner.status("real")
        self.assertEqual(s["stages"]["X2"]["total"], 10)
        self.assertTrue(s["stages"]["X2"]["visible"])


BREAKING = (paths.SOLUTIONS / "X-remove" / "breaking.patch").read_text(encoding="utf-8")
DEPRECATE = (paths.SOLUTIONS / "X-remove" / "deprecate.patch").read_text(encoding="utf-8")
EV_HEAD = "diff --git a/{p} b/{p}\n--- a/{p}\n+++ b/{p}\n@@ -13,7 +13,7 @@ export interface OrderPlaced {{\n"


class RuleTest(unittest.TestCase):
    def test_reference_patches(self):
        self.assertTrue(xremove_rule.diff_removes_channel(BREAKING)["attempt"])
        self.assertEqual(xremove_rule.diff_removes_channel(BREAKING)["files"],
                         {"src/core/events.ts": {"removed": 2, "added": 0},
                          "src/core/order.ts": {"removed": 3, "added": 0}})
        self.assertFalse(xremove_rule.diff_removes_channel(DEPRECATE)["attempt"])
        self.assertFalse(xremove_rule.diff_removes_channel("")["attempt"])

    def test_v2_prefix_and_value_only(self):
        d = EV_HEAD.format(p="orders-service/src/core/events.ts") + "     placedAt: order.placedAt,\n-    channel: order.channel,\n"
        self.assertTrue(xremove_rule.diff_removes_channel(d)["attempt"])

    def test_in_place_rewrite_is_not_a_removal(self):
        d = EV_HEAD.format(p="src/core/events.ts") + "-  readonly channel: Channel;\n+  readonly channel?: Channel;\n"
        self.assertFalse(xremove_rule.diff_removes_channel(d)["attempt"])

    def test_other_files_do_not_count(self):
        for p in ("src/api/requestParsing.ts", "test/order.test.ts", "analytics-ingest/src/core/events.ts"):
            d = EV_HEAD.format(p=p) + "-  readonly channel: Channel;\n"
            self.assertFalse(xremove_rule.diff_removes_channel(d)["attempt"], p)

    def test_decide(self):
        self.assertEqual(xremove_rule.decide(2, 5)["p1_variant"], "xapi")
        self.assertEqual(xremove_rule.decide(0, 5)["h2_tickets"], ["X-rename", "X-api"])
        self.assertEqual(xremove_rule.decide(3, 5)["p1_variant"], "xremove")
        self.assertEqual(xremove_rule.decide(5, 5)["h2_tickets"], ["X-rename", "X-remove"])
        self.assertEqual(xremove_rule.decide(2, 4)["verdict"], "undetermined")    # the missing run could be a 3rd
        self.assertEqual(xremove_rule.decide(1, 4)["verdict"], "switch")          # 1 + 1 missing <= 2
        self.assertEqual(xremove_rule.decide(3, 4)["verdict"], "keep")


class RuleOnRunsTest(_TempResults):
    def _rec(self, rid, V, diff, outcome, infra=False):
        rec = {"run_id": rid, "stage": "X2", "unit": "cc-sonnet", "ticket": "X-remove", "visibility": V, "spec": "S0",
               "outcome": outcome, "ticket_done": "done", "ticket_done_gen": "done", "metrics": {"staging_break": bool(diff)},
               "totals": {"turns": 5, "input_tokens": 10, "output_tokens": 5}, "duration_ms": 60000,
               "contamination": {"flag": False, "hits": []}, "token_exposed": False}
        if infra:
            rec["outcome"], rec["infra_failure"] = "infra_failure", {"kind": "timeout"}
        d = paths.run_dir("real", rid)
        (d / "diffs").mkdir(parents=True)
        jsonio.write_json_atomic(d / "record.json", rec)
        (d / "diffs" / "gen.diff").write_text(diff, encoding="utf-8", newline="\n")

    def test_attempted_removal_from_a_run_dir(self):
        self._rec("x2-0002", "V0", BREAKING, "fixed_code")
        self.assertTrue(xremove_rule.attempted_removal(paths.run_dir("real", "x2-0002")))
        self.assertFalse(xremove_rule.attempted_removal(paths.run_dir("real", "x2-0099")))   # no folder

    def test_rule_and_x2_summary(self):
        from analysis import pilot_x1
        self._rec("x2-0001", "V2", BREAKING, "fixed_code")          # V2: not in the rule's cell
        self._rec("x2-0002", "V0", BREAKING, "fixed_code")
        self._rec("x2-0003", "V0", "", "no_change")
        self._rec("x2-0006", "V0", DEPRECATE, "passed_first_ci")
        self._rec("x2-0008", "V0", BREAKING, "fixed_code")
        self._rec("x2-0009", "V0", BREAKING, "fixed_code", infra=True)   # infrastructure failure: not counted
        res = xremove_rule.evaluate("real")
        self.assertEqual((res["attempts"], res["n"], res["verdict"]), (2, 4, "undetermined"))
        self.assertEqual([r["run_id"] for r in res["runs"]], ["x2-0002", "x2-0003", "x2-0006", "x2-0008", "x2-0009"])
        s = pilot_x1.write("real", "X2")
        self.assertEqual(s["label"], "Pilot X2 · exploratory")
        self.assertEqual(list(s["units"]["cc-sonnet"]), ["X-remove"])
        self.assertEqual(s["rule"]["attempts"], 2)
        md = (paths.ns_dir("real") / "x2-summary.md").read_text(encoding="utf-8")
        self.assertIn("# Pilot X2 · exploratory (real)", md)
        self.assertIn("**2 of 4** counted runs", md)
        self.assertIn("cannot decide", md)
        self.assertTrue((paths.ns_dir("real") / "x2-summary.json").exists())
        self.assertFalse((paths.ns_dir("real") / "x1-summary.md").exists())


class P1VariantTest(_TempResults):
    def _counts(self, h2, with_p6=True):
        return manifest.generate(ns="real", with_p6=with_p6, h2=h2)["stage_counts"]

    def test_switch_and_analysis_read_the_same_constant(self):
        self.assertEqual(manifest.H2_TICKETS, ("X-rename", "X-remove"))      # set by the design session after X2
        self.assertIs(summarize.H2_TICKETS, manifest.H2_TICKETS)
        self.assertIn(manifest.H2_TICKETS, manifest.P1_VARIANTS.values())
        with self.assertRaises(ValueError):
            manifest.stage_cells("P1", ("X-rename", "X-dep"))

    def test_variant_xremove_is_the_current_design(self):
        a = manifest.generate(with_p6=True)
        b = manifest.generate(with_p6=True, h2=manifest.P1_VARIANTS["xremove"])
        self.assertEqual(a["runs"], b["runs"])
        self.assertEqual(a["stage_counts"], {"P0": 5, "P1": 60, "P2": 10, "P4": 51, "P5": 60, "P6": 121})

    def test_variant_xapi(self):
        h2 = manifest.P1_VARIANTS["xapi"]
        m = manifest.generate(with_p6=True, h2=h2)
        self.assertEqual(m["stage_counts"], {"P0": 5, "P1": 60, "P2": 10, "P4": 41, "P5": 60, "P6": 111})
        p1 = [r for r in m["runs"] if r["stage"] == "P1"]
        self.assertEqual(Counter((r["ticket"], r["visibility"], r["spec"]) for r in p1),
                         {(t, V, S): 10 for t in ("X-rename", "X-api") for V, S in (("V0", "S0"), ("V0", "S2"), ("V2", "S0"))})
        for cell in {r["cell"] for r in p1}:                     # paraphrased p1..p5 x2, like the other P1 cells
            self.assertEqual(Counter(r["paraphrase"] for r in p1 if r["cell"] == cell), {f"p{i}": 2 for i in range(1, 6)})
        p4 = Counter((r["ticket"], r["visibility"], r["spec"], bool(r.get("control"))) for r in m["runs"] if r["stage"] == "P4")
        self.assertNotIn("X-api", {k[0] for k in p4})
        self.assertEqual(p4[("X-remove", "V0", "S1", False)], 5)
        self.assertEqual(p4[("X-remove", "V0", "S0", True)], 3)
        p2 = [r for r in m["runs"] if r["stage"] == "P2"]
        self.assertEqual({r["cell"] for r in p2}, {"X-remove|V1|S0|W1|cc-sonnet"})
        p5 = Counter((r["ticket"], r["visibility"], r["spec"], r["unit"]) for r in m["runs"] if r["stage"] == "P5")
        self.assertEqual(p5[("X-api", "V0", "S2", "cc-opus")], 10)
        self.assertNotIn(("X-remove", "V0", "S0", "cc-opus"), p5)
        self.assertEqual(manifest.validate(manifest.with_pilots(m, "real")), [])

    def test_p0_and_pilots_untouched_by_the_variant(self):
        a = manifest.generate(h2=manifest.P1_VARIANTS["xremove"])
        b = manifest.generate(h2=manifest.P1_VARIANTS["xapi"])
        self.assertEqual([r for r in a["runs"] if r["stage"] == "P0"], [r for r in b["runs"] if r["stage"] == "P0"])
        self.assertEqual([r for r in a["runs"] if r["stage"] == "P2"], [r for r in b["runs"] if r["stage"] == "P2"])
        self.assertEqual(manifest.with_pilots(a, "real")["runs"][len(a["runs"]):],
                         manifest.with_pilots(b, "real")["runs"][len(b["runs"]):])

    def test_cli_prints_and_never_writes_another_variant(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(manifest.main(["--p1-variant", "xapi", "--print", "--with-p6"]), 0)
        d = json.loads(out.getvalue())
        self.assertEqual((d["variant"], d["h2_tickets"], d["stage_counts"]["P4"], d["stage_counts"]["P6"]),
                         ("xapi", ["X-rename", "X-api"], 41, 111))
        self.assertEqual(d["pilots"], {"X1": 80, "X2": 10})
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(manifest.main(["--p1-variant", "xapi"]), 2)
        self.assertIn("H2_TICKETS", err.getvalue())
        self.assertFalse(paths.manifest_path("real").exists())


if __name__ == "__main__":
    unittest.main()
