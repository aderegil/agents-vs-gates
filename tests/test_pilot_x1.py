import io
import json
import os
import shutil
import tempfile
import unittest
from collections import Counter
from contextlib import redirect_stderr
from pathlib import Path

from harness import blinding, jsonio, manifest, paths, runner


class PilotManifestTest(unittest.TestCase):
    def test_x1_runs_blocks_of_four_and_ids(self):
        runs = manifest.pilot_runs("real")
        self.assertEqual(len(runs), 80)
        for unit, prefix in (("cc-sonnet", "x1"), ("codex", "x1c")):
            mine = [r for r in runs if r["unit"] == unit]
            self.assertEqual([r["run_id"] for r in mine], [f"{prefix}-{i:04d}" for i in range(1, 41)])
            self.assertEqual(Counter((r["ticket"], r["visibility"]) for r in mine),
                             {(t, V): 10 for t in ("X-rename", "X-remove") for V in ("V0", "V2")})
            for b in range(10):                       # every block of 4 holds the 4 cells once
                block = mine[4 * b:4 * b + 4]
                self.assertEqual({(r["ticket"], r["visibility"]) for r in block},
                                 {(t, V) for t in ("X-rename", "X-remove") for V in ("V0", "V2")})
                self.assertTrue(all(r["replicate"] == b + 1 for r in block))
            self.assertTrue(all(r["stage"] == "X1" and r["spec"] == "S0" and r["wording"] == "W1"
                                and r["paraphrase"] is None for r in mine))
        # the first 3 runs (the suggested trial batch) include a V2 run
        self.assertIn("V2", {r["visibility"] for r in runs[:3]})
        # same order for both units, deterministic
        self.assertEqual([(r["ticket"], r["visibility"]) for r in runs[:40]],
                         [(r["ticket"], r["visibility"]) for r in runs[40:]])
        self.assertEqual(runs, manifest.pilot_runs("real"))

    def test_mock_has_only_x1_with_unit_mock(self):
        runs = manifest.pilot_runs("mock")
        self.assertEqual(len(runs), 40)
        self.assertTrue(all(r["unit"] == "mock" and r["run_id"].startswith("x1-") for r in runs))

    def test_valid_against_schema_and_main_stages_untouched(self):
        m = manifest.generate()
        merged = manifest.with_pilots(m, "real")
        self.assertEqual(manifest.validate(merged), [])
        self.assertEqual(merged["runs"][:len(m["runs"])], m["runs"])
        self.assertEqual(m["stage_counts"], {"P0": 5, "P1": 60, "P2": 10, "P4": 51, "P5": 60})

    def test_x1_is_always_visible(self):
        self.assertTrue(blinding.is_visible({}, "X1"))
        self.assertFalse(blinding.is_visible({}, "P1"))


class PilotRunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-x1-"))
        self.env = os.environ.get("AVG_RESULTS_ROOT")
        os.environ["AVG_RESULTS_ROOT"] = str(self.tmp)
        m = manifest.generate()
        paths.manifest_path("real").parent.mkdir(parents=True, exist_ok=True)
        jsonio.write_json_atomic(paths.manifest_path("real"), m)
        self.sha = manifest.sha256(paths.manifest_path("real"))

    def tearDown(self):
        if self.env is None:
            os.environ.pop("AVG_RESULTS_ROOT", None)
        else:
            os.environ["AVG_RESULTS_ROOT"] = self.env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_real_x1_needs_a_unit_and_never_changes_the_manifest_file(self):
        err = io.StringIO()
        with redirect_stderr(err):
            code = runner.main(["--stage", "X1", "--dry-run"])
        self.assertEqual(code, runner.EXIT_GUARD)
        self.assertIn("--unit", err.getvalue())
        out = io.StringIO()
        from contextlib import redirect_stdout
        with redirect_stdout(out):
            code = runner.main(["--stage", "X1", "--unit", "codex", "--dry-run", "--max-runs", "3"])
        self.assertEqual(code, 0)
        self.assertIn("x1c-0001", out.getvalue())
        self.assertNotIn("x1-0001 ", out.getvalue())
        self.assertEqual(manifest.sha256(paths.manifest_path("real")), self.sha)

    def test_x1_is_exempt_from_the_prereg_lock_but_not_from_the_smoke(self):
        errs = runner.guard_errors("real", "X1", {"cc-sonnet"})
        self.assertFalse(any("pre-registration" in e for e in errs), errs)
        self.assertTrue(any("smoke" in e for e in errs), errs)
        errs = runner.guard_errors("real", "P1", {"cc-sonnet"})
        self.assertTrue(any("pre-registration" in e for e in errs), errs)

    def test_status_lists_x1(self):
        s = runner.status("real")
        self.assertEqual(s["stages"]["X1"]["total"], 80)
        self.assertTrue(s["stages"]["X1"]["visible"])


class PilotSummaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-x1s-"))
        self.env = os.environ.get("AVG_RESULTS_ROOT")
        os.environ["AVG_RESULTS_ROOT"] = str(self.tmp)

    def tearDown(self):
        if self.env is None:
            os.environ.pop("AVG_RESULTS_ROOT", None)
        else:
            os.environ["AVG_RESULTS_ROOT"] = self.env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _rec(self, i, ticket, V, broke, outcome, oos=()):
        rec = {"run_id": f"x1-{i:04d}", "stage": "X1", "unit": "cc-sonnet", "ticket": ticket, "visibility": V,
               "spec": "S0", "outcome": outcome, "ticket_done": "done", "ticket_done_gen": "done",
               "metrics": {"staging_break": broke}, "out_of_scope_edits": list(oos),
               "totals": {"turns": 10 + i, "input_tokens": 100, "output_tokens": 50}, "duration_ms": 60000 * i,
               "contamination": {"flag": False, "hits": []}, "token_exposed": False}
        d = paths.run_dir("real", rec["run_id"])
        d.mkdir(parents=True)
        jsonio.write_json_atomic(d / "record.json", rec)

    def test_summary_numbers_and_markdown(self):
        from analysis import pilot_x1
        self._rec(1, "X-rename", "V0", True, "fixed_code")
        self._rec(2, "X-rename", "V0", True, "fixed_code")
        self._rec(3, "X-rename", "V2", False, "passed_first_ci", ["billing-service/src/x.ts"])
        self._rec(4, "X-rename", "V2", False, "passed_first_ci")
        s = pilot_x1.write("real")
        g = s["units"]["cc-sonnet"]["X-rename"]
        self.assertEqual((g["V0"]["staging_break_gen"]["x"], g["V0"]["n"]), (2, 2))
        self.assertEqual((g["V2"]["staging_break_gen"]["x"], g["V2"]["n"]), (0, 2))
        self.assertEqual(g["V2"]["out_of_scope"], 1)
        self.assertEqual(g["V0"]["median_turns"], 11.5)
        self.assertAlmostEqual(g["fisher_staging_break"], 1 / 3, places=6)
        md = (paths.ns_dir("real") / "x1-summary.md").read_text(encoding="utf-8")
        self.assertIn("Pilot X1 · exploratory", md)
        self.assertIn("not part of the confirmatory analysis", md)
        self.assertIn("2 of 2", md)
        self.assertEqual(json.loads((paths.ns_dir("real") / "x1-summary.json").read_text(encoding="utf-8"))["runs"], 4)


if __name__ == "__main__":
    unittest.main()
