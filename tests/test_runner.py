import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout

from harness import jsonio, manifest, paths, runner
from tests._fake_scenario import FakeScenario

BREAK_FIX = {"gen": "X-rename/breaking", "repairs": ["X-rename/correct"]}


def run(argv, fs, scripts=None):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = runner.main(argv, pipeline=fs.pipeline, mock_scripts=scripts)
    return code, out.getvalue(), err.getvalue()


SLOW = unittest.skipUnless(os.environ.get("AVG_SLOW") == "1", "slow; set AVG_SLOW=1")

class RunnerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fs = FakeScenario().__enter__()
        cls.m = manifest.ensure("mock")
        cls.ids = {s: [r["run_id"] for r in cls.m["runs"] if r["stage"] == s] for s in ("P0", "P1", "P2")}

    @classmethod
    def tearDownClass(cls):
        cls.fs.__exit__(None, None, None)

    def scripts(self, **override):
        s = {rid: BREAK_FIX for ids in self.ids.values() for rid in ids}
        s.update(override)
        return s

    def test_1_batch_state_log_and_blind_status(self):
        code, out, _ = run(["--stage", "P1", "--unit", "mock", "--batch", "2"], self.fs, self.scripts())
        self.assertEqual(code, 0)
        lines = [l for l in out.splitlines() if l.startswith("p1-")]
        self.assertEqual(len([l for l in lines if " turns=" in l]), 2)
        self.assertEqual(len([l for l in lines if " started" in l]), 2)
        self.assertFalse([l for l in out.splitlines() if l.startswith("  p1-")])   # no agent activity: P1 is blinded
        for l in lines:   # per run: id + worker, then id, turns, duration, tokens — never outcome or cell
            self.assertNotIn("fixed_code", l)
            self.assertNotIn("X-re", l)
        st = jsonio.read_json(paths.state_path("mock"))
        self.assertEqual(sum(1 for r in self.ids["P1"] if st["runs"][r]["status"] == "done"), 2)
        self.assertIsNone(st["runner"]["pid"])
        self.assertEqual(st["usage"]["P1"]["runs"], 2)
        import jsonschema
        jsonschema.validate(st, json.loads((paths.CONTRACTS / "state.schema.json").read_text(encoding="utf-8")))
        log = jsonio.read_jsonl(paths.runner_log_path("mock"))
        events = [e["event"] for e in log]
        self.assertIn("batch_started", events)
        self.assertEqual(events.count("run_finished"), 2)
        self.assertTrue(all("outcome" not in e for e in log if e["event"] == "run_finished"))
        self.assertFalse(paths.control_path("mock").exists())
        code, out, _ = run(["--status", "--ns", "mock", "--json"], self.fs)
        s = json.loads(out)
        self.assertEqual(s["stages"]["P1"]["outcomes"], "Blinded until stage complete")
        self.assertNotIn("fixed_code", out)
        code, _, err = run(["--unblind", "P1", "--ns", "mock"], self.fs)
        self.assertEqual(code, 2)
        code, out, _ = run(["--unblind", "P1", "--ns", "mock", "--force-unblind", "--json"], self.fs)
        self.assertEqual(code, 0)
        self.assertIn("fixed_code", out)
        self.assertTrue(jsonio.read_json(paths.state_path("mock"))["unblinded"]["P1"]["forced"])

    def test_2_rate_limit_and_breach_stop_the_batch(self):
        first = self.ids["P2"][0]
        code, out, _ = run(["--stage", "P2", "--unit", "mock", "--batch", "3"], self.fs,
                           self.scripts(**{first: {"gen": "X-rename/breaking", "infra": "rate_limited"}}))
        self.assertEqual(code, 3)
        st = jsonio.read_json(paths.state_path("mock"))
        self.assertEqual(st["runs"][first]["status"], "pending")
        self.assertEqual(st["runner"]["status"], "rate_limited")
        self.assertTrue(st["runner"]["rate_limited_until"])
        self.assertTrue(all(st["runs"][r]["status"] == "pending" for r in self.ids["P2"][1:]))
        code, _, _ = run(["--stage", "P2", "--unit", "mock", "--batch", "3"], self.fs,
                         self.scripts(**{first: {"gen": "X-rename/breaking", "infra": "isolation_breach"}}))
        self.assertEqual(code, 4)

    @SLOW
    def test_3_infra_requeue_then_final(self):
        bad = self.ids["P0"][0]
        scripts = self.scripts(**{bad: {"gen": "X-rename/breaking", "infra": "crash"}})
        code, _, _ = run(["--stage", "P0", "--unit", "mock", "--batch", "2"], self.fs, scripts)
        self.assertEqual(code, 0)
        st = jsonio.read_json(paths.state_path("mock"))
        self.assertEqual((st["runs"][bad]["status"], st["runs"][bad]["infra_failures"]), ("infra_failure", 1))
        code, _, _ = run(["--stage", "P0", "--unit", "mock"], self.fs, scripts)
        st = jsonio.read_json(paths.state_path("mock"))
        self.assertEqual((st["runs"][bad]["status"], st["runs"][bad]["infra_failures"]), ("infra_failure_final", 3))
        self.assertTrue(all(st["runs"][r]["status"] == "done" for r in self.ids["P0"][1:]))
        self.assertTrue(jsonio.read_json(paths.run_dir("mock", bad) / "record.json")["infra_failure"]["final"])
        code, out, _ = run(["--status", "--ns", "mock", "--json"], self.fs)
        self.assertIsInstance(json.loads(out)["stages"]["P0"]["outcomes"], dict)    # P0 is always visible
        proj = runner.projection("mock")
        self.assertEqual(proj["runs"], 4)
        self.assertEqual(proj["projection"]["P1"]["runs"], 40)
        self.assertEqual(proj["projection"]["P4"]["runs"], 61)

    def test_4_control_stop_and_dry_run(self):
        jsonio.write_json_atomic(paths.control_path("mock"), {"stop_after_current": True, "by": "test", "at": "now"})
        code, out, _ = run(["--stage", "P4", "--unit", "mock", "--batch", "5"], self.fs, self.scripts())
        self.assertEqual(code, 0)
        self.assertFalse(paths.control_path("mock").exists())
        st = jsonio.read_json(paths.state_path("mock"))
        self.assertFalse(any(st["runs"][r["run_id"]]["status"] == "done" for r in self.m["runs"] if r["stage"] == "P4"))
        code, out, _ = run(["--stage", "P4", "--unit", "mock", "--dry-run", "--batch", "3"], self.fs)
        self.assertEqual(code, 0)
        self.assertIn("3 run(s) would run (61 pending in P4", out)

    @SLOW
    def test_6_parallel_workers(self):
        code, out, _ = run(["--stage", "P2", "--unit", "mock", "--batch", "2", "--workers", "2"], self.fs,
                           self.scripts(**{r: BREAK_FIX for r in self.ids["P2"]}))
        self.assertEqual(code, 0)
        st = jsonio.read_json(paths.state_path("mock"))
        done = [st["runs"][r] for r in self.ids["P2"] if st["runs"][r]["status"] == "done"]
        self.assertEqual(sorted(r["worker"] for r in done[-2:]), [1, 2])

    def test_7_model_drift(self):
        st = runner.State("real", runner.new_state("real"))
        b = runner.Batch("real", "P1", [], st, {"seed": 1}, workers=1, max_runs=None, max_minutes=None,
                         unit_label=None, quiet=True)
        self.assertIsNone(b._model_drift({"unit": "cc-sonnet", "model_reported": "claude-sonnet-x-1"}))
        self.assertIsNone(b._model_drift({"unit": "cc-sonnet", "model_reported": "claude-sonnet-x-1"}))
        self.assertIn("model drift", b._model_drift({"unit": "cc-sonnet", "model_reported": "claude-sonnet-y-2"}))

    def test_5_real_namespace_guards(self):
        code, _, err = run(["--stage", "P1"], self.fs)
        self.assertEqual(code, 2)
        self.assertIn("no manifest", err)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(manifest.main(["--ns", "real"]), 0)
        code, _, err = run(["--stage", "P1"], self.fs)
        self.assertEqual(code, 2)
        self.assertIn("smoke", err)
        self.assertIn("lock", err)
        code, _, err = run(["--stage", "P0"], self.fs)
        self.assertEqual(code, 2)
        self.assertNotIn("lock", err)
        code, out, _ = run(["--stage", "P0", "--dry-run"], self.fs)
        self.assertEqual(code, 0)
        self.assertIn("5 run(s) would run", out)
        code, _, _ = run(["--stage", "P0", "--workers", "4"], self.fs)
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
