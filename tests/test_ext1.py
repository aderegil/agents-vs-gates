"""Addendum 1 (ext-1016): the P7/P8 sidecar, the C8 calibration, the addendum lock and the runner's guards.
No model call; the results root is a temp folder; the real repo is only read (its original lock must still verify)."""
import io
import json
import os
import shutil
import tempfile
import unittest
from collections import Counter, defaultdict
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from harness import blinding, jsonio, manifest, paths, prereg, runner


class Ext1Generation(unittest.TestCase):
    def test_counts_cells_and_ids(self):
        m = manifest.generate_ext1()
        self.assertEqual(manifest.validate(m), [])
        self.assertEqual(m["seed"], 20261016)
        self.assertEqual(m["stage_counts"], {"P7": 480, "P8": 120})
        self.assertEqual(m["units"], {"P7": {"cc-sonnet": 240, "codex": 240}, "P8": {"agy-flash": 120}})
        for st, n in (("P7", 480), ("P8", 120)):
            ids = [r["run_id"] for r in m["runs"] if r["stage"] == st]
            self.assertEqual(ids, [f"p{st[1]}-{i:04d}" for i in range(1, n + 1)])
        cells = Counter(r["cell"] for r in m["runs"])
        p1 = {r["cell"].rsplit("|", 1)[0] for r in manifest.generate()["runs"] if r["stage"] == "P1"}
        self.assertEqual({c.rsplit("|", 1)[0] for c in cells if c.endswith("|cc-sonnet")}, p1)
        self.assertEqual({c.rsplit("|", 1)[0] for c in cells if c.endswith("|agy-flash")}, p1)
        self.assertEqual({c.rsplit("|", 1)[0] for c in cells if c.endswith("|codex")}, p1)
        self.assertTrue(all(cells[c] == (40 if not c.endswith("agy-flash") else 20) for c in cells))

    def test_rounds_and_paraphrase_slots(self):
        m = manifest.generate_ext1()
        for st, n_cells, reps in (("P7", 12, 40), ("P8", 6, 20)):
            by_round = defaultdict(list)
            for r in m["runs"]:
                if r["stage"] == st:
                    by_round[r["round"]].append(r)
            self.assertEqual(sorted(by_round), list(range(1, reps + 1)))
            for k, rs in by_round.items():
                self.assertEqual(len({r["cell"] for r in rs}), n_cells)
                self.assertTrue(all(r["paraphrase"] == f"p{(k - 1) % 5 + 1}" for r in rs))
            slots = Counter((r["cell"], r["paraphrase"]) for r in m["runs"] if r["stage"] == st)
            self.assertEqual(set(slots.values()), {reps // 5})

    def test_deterministic_and_p8_n(self):
        a, b = manifest.generate_ext1(), manifest.generate_ext1()
        self.assertEqual([r["cell"] for r in a["runs"]], [r["cell"] for r in b["runs"]])
        self.assertNotEqual([r["cell"] for r in manifest.generate_ext1(seed=1)["runs"]],
                            [r["cell"] for r in a["runs"]])
        self.assertEqual(manifest.generate_ext1(p8_n=10)["stage_counts"]["P8"], 60)
        self.assertNotIn("P8", manifest.generate_ext1(with_p8=False)["stage_counts"])
        self.assertNotIn("P8", manifest.generate_ext1(p8_n=0)["stage_counts"])

    def test_mock_units_are_distinct(self):
        m = manifest.generate_ext1(ns="mock")
        self.assertEqual(m["units"], {"P7": {"mock": 240, "mock-cx": 240}, "P8": {"mock-agy": 120}})
        self.assertEqual(len({r["cell"] for r in m["runs"] if r["stage"] == "P7"}), 12)

    def test_calibration_c8(self):
        runs = manifest.calibration_runs("real")
        self.assertEqual([r["run_id"] for r in runs], [f"c8-{i:04d}" for i in range(1, 6)])
        self.assertEqual(Counter(r["cell"] for r in runs), {"X-rename|V0|S0|W1|agy-flash": 3,
                                                            "X-rename|V0|S2|W1|agy-flash": 2})
        self.assertTrue(all(r["paraphrase"] is None and r["calibration"] for r in runs))
        self.assertEqual({r["unit"] for r in manifest.calibration_runs("mock")}, {"mock-agy"})
        self.assertIn("C8", blinding.ALWAYS_VISIBLE)
        self.assertNotIn("P7", blinding.ALWAYS_VISIBLE)

    def test_original_lock_still_verifies_and_sidecar_not_in_it(self):
        ok, problems = prereg.verify(paths.REPO)
        self.assertTrue(ok, problems)
        frozen = prereg.frozen_files(paths.REPO)
        for rel in ("results/real/manifest-ext1.json", "harness/units-ext.json", "harness/adapters/agy.py"):
            self.assertNotIn(rel, frozen)
            self.assertIn(rel, prereg.ADDENDUM_FILES[1])


class TempResults(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-ext1-"))
        self.env = os.environ.get("AVG_RESULTS_ROOT")
        os.environ["AVG_RESULTS_ROOT"] = str(self.tmp)

    def tearDown(self):
        if self.env is None:
            os.environ.pop("AVG_RESULTS_ROOT", None)
        else:
            os.environ["AVG_RESULTS_ROOT"] = self.env
        shutil.rmtree(self.tmp, ignore_errors=True)


class Ext1Sidecar(TempResults):
    def test_write_load_and_refusals(self):
        with self.assertRaisesRegex(RuntimeError, "generate the manifest first"):
            manifest.write_ext1("mock")
        jsonio.write_json_atomic(paths.manifest_path("mock"), manifest.generate(ns="mock"))
        before = manifest.sha256(paths.manifest_path("mock"))
        out, m = manifest.write_ext1("mock")
        self.assertEqual(out.name, "manifest-ext1.json")
        self.assertEqual(manifest.sha256(paths.manifest_path("mock")), before)
        loaded = manifest.load("mock")
        st = Counter(r["stage"] for r in loaded["runs"])
        self.assertEqual((st["P7"], st["P8"], st["C8"]), (480, 120, 5))
        self.assertEqual(loaded["ext1_sidecar"]["runs"], 600)
        with self.assertRaisesRegex(RuntimeError, "pass --force"):
            manifest.write_ext1("mock")
        manifest.write_ext1("mock", p8_n=10, force=True)
        self.assertEqual(Counter(r["stage"] for r in manifest.load("mock")["runs"])["P8"], 60)
        jsonio.write_json_atomic(paths.state_path("mock"), {"runs": {"p7-0001": {"status": "done"}}})
        with self.assertRaisesRegex(RuntimeError, "have started"):
            manifest.write_ext1("mock", force=True)

    def test_cli_print(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(manifest.main(["--ext1-sidecar", "--with-p7", "--print"]), 0)
        self.assertEqual(json.loads(buf.getvalue())["stage_counts"], {"P7": 480})
        with redirect_stderr(io.StringIO()):
            self.assertEqual(manifest.main(["--ext1-sidecar"]), 2)


class RunnerExt1(TempResults):
    def setUp(self):
        super().setUp()
        paths.manifest_path("real").parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(paths.REPO / "results" / "real" / "manifest.json", paths.manifest_path("real"))  # the frozen one
        manifest.write_ext1("real")

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = runner.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_stages_and_dry_runs(self):
        for st in ("P7", "P8", "C8"):
            self.assertIn(st, runner.STAGES)
        code, _, err = self.run_cli("--stage", "P7", "--dry-run")
        self.assertEqual(code, runner.EXIT_GUARD)
        self.assertIn("pass --unit", err)
        code, out, _ = self.run_cli("--stage", "P7", "--unit", "codex", "--dry-run")
        self.assertEqual(code, 0)
        self.assertIn("240 run(s) would run", out)
        code, out, _ = self.run_cli("--stage", "P8", "--dry-run")
        self.assertIn("120 run(s) would run", out)
        code, out, _ = self.run_cli("--stage", "C8", "--dry-run")
        self.assertIn("5 run(s) would run", out)

    def test_guards(self):
        errs = runner.guard_errors("real", "C8", {"agy-flash"})
        self.assertTrue(any("smoke-agy.json" in e for e in errs), errs)
        self.assertFalse(any("lock" in e for e in errs), errs)              # C8 is exploratory
        for name in ("smoke.json", "smoke-codex.json", "smoke-agy.json"):
            jsonio.write_json_atomic(paths.results_root() / name, {"ok": True})
        self.assertEqual(runner.guard_errors("real", "C8", {"agy-flash"}), [])
        errs = runner.guard_errors("real", "P7", {"cc-sonnet"})
        self.assertEqual(len(errs), 1, errs)                                # the original lock verifies
        self.assertIn("addendum-1 lock missing", errs[0])
        self.assertEqual(runner.guard_errors("real", "P1", {"cc-sonnet"}), [])
        code, _, err = self.run_cli("--stage", "P8", "--max-runs", "1")
        self.assertEqual(code, runner.EXIT_GUARD)
        self.assertIn("addendum-1 lock", err)

    def test_model_drift_noted_not_stopped_in_p7(self):
        st = runner.State("real", runner.new_state("real"))
        st.data["models_seen"] = {"cc-sonnet": "claude-sonnet-5-5-20260901"}
        b = runner.Batch("real", "P7", [], st, {"seed": 1}, workers=1, max_runs=None, max_minutes=None, unit_label=None)
        rec = {"unit": "cc-sonnet", "model_reported": "claude-sonnet-5-5-20261101", "stage": "P7", "run_id": "p7-0001",
               "cli_version": "2.2.0"}
        self.assertIsNone(b._model_drift(rec))
        self.assertEqual(st.data["drift_notes"][0]["reported"], "claude-sonnet-5-5-20261101")
        self.assertIn("model drift", b._model_drift(dict(rec, stage="P1")))


class AddendumLock(unittest.TestCase):
    def make_repo(self) -> Path:
        d = Path(tempfile.mkdtemp(prefix="avg-addendum-"))
        files = {"PREREGISTRATION.md": "# prereg\n", "scenario/tasks/X-rename.md": "t\n", "harness/texts/a.md": "a\n",
                 "analysis/RUBRIC.md": "r\n", "harness/units.json": "{}\n", "ci/run.py": "x\n",
                 "results/real/manifest.json": "{}\n",
                 "PREREGISTRATION-ADDENDUM-1.md": "# addendum\n", "harness/units-ext.json": "{}\n",
                 "harness/adapters/agy.py": "# agy\n", "results/real/manifest-ext1.json": "{}\n"}
        for rel, text in files.items():
            (d / rel).parent.mkdir(parents=True, exist_ok=True)
            (d / rel).write_text(text, encoding="utf-8")
        self.addCleanup(shutil.rmtree, d, True)
        return d

    def test_freeze_and_verify_on_temp_copy(self):
        d = self.make_repo()
        with self.assertRaisesRegex(RuntimeError, "original pre-registration lock does not verify"):
            prereg.freeze_addendum(1, d, commit=False)
        prereg.freeze(d, commit=False)
        self.assertFalse(prereg.verify_addendum(1, d)[0])
        data = prereg.freeze_addendum(1, d, commit=False)
        self.assertEqual(sorted(data["files"]), sorted(prereg.ADDENDUM_FILES[1]))
        self.assertEqual(data["extends"]["aggregate_sha256"],
                         json.loads((d / "PREREGISTRATION.lock").read_text(encoding="utf-8"))["aggregate_sha256"])
        self.assertTrue(data["frozen_at"].endswith("+00:00"))
        self.assertEqual(prereg.verify_addendum(1, d), (True, []))
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            prereg.freeze_addendum(1, d, commit=False)
        (d / "harness/units-ext.json").write_text('{"x": 1}\n', encoding="utf-8")
        ok, problems = prereg.verify_addendum(1, d)
        self.assertFalse(ok)
        self.assertEqual(problems, ["addendum 1: changed: harness/units-ext.json"])
        (d / "harness/units-ext.json").write_text("{}\n", encoding="utf-8")
        (d / "harness/units.json").write_text('{"y": 1}\n', encoding="utf-8")
        ok, problems = prereg.verify_addendum(1, d)
        self.assertEqual(problems, ["original: changed: harness/units.json"])

    def test_cli(self):
        d = self.make_repo()
        prereg.freeze(d, commit=False)
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(prereg.main(["--freeze-addendum", "1", "--repo", str(d), "--no-commit"]), 0)
            self.assertEqual(prereg.main(["--verify-addendum", "1", "--repo", str(d)]), 0)
        self.assertIn("FROZEN addendum 1", out.getvalue())


if __name__ == "__main__":
    unittest.main()
