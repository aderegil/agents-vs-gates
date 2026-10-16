"""harness.smoke --unit agy-flash: dry run, refusal without authorization, and the live path against the fake CLI
(temp AVG_ROOT, temp results root, a fake real HOME). Never runs the real agy."""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from harness import smoke, smoke_agy
from harness.adapters import agy
from tests.test_adapters_agy import FAKE, fake_real_home


class SmokeAgy(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-smoke-agy-"))
        self.env = mock.patch.dict(os.environ, {"AVG_ROOT": str(self.tmp / "avg"),
                                                "AVG_RESULTS_ROOT": str(self.tmp / "results"),
                                                "AVG_AGY_REAL_HOME": str(fake_real_home(self.tmp)),
                                                "FAKE_AGY_MODE": "smoke"})
        self.env.start()
        (self.tmp / "results").mkdir()
        self.addCleanup(self.env.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_dry_run_makes_no_call(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(smoke.main(["--unit", "agy-flash", "--dry-run"]), 0)
        text = out.getvalue()
        self.assertIn("DRY RUN: 0 calls made", text)
        self.assertIn('"--print-timeout", "20s"', text)
        self.assertIn('"--conversation", "<conversation_id of call 3>"', text)
        self.assertIn('"/usage"', text)

    def test_refuses_without_authorization(self):
        with redirect_stderr(io.StringIO()) as err:
            self.assertEqual(smoke.main(["--unit", "agy-flash"]), 2)
        self.assertIn("authorization", err.getvalue())

    def test_live_path_with_the_fake_cli(self):
        with mock.patch.object(agy, "entry_argv", return_value=[sys.executable, str(FAKE)]), \
                redirect_stdout(io.StringIO()) as out:
            code = smoke.main(["--unit", "agy-flash", "--i-am-authorized"])
        report = json.loads((self.tmp / "results" / "smoke-agy.json").read_text(encoding="utf-8"))
        failed = [c for c in report["checks"] if not c["ok"]]
        self.assertEqual(failed, [])
        self.assertEqual(code, 0, out.getvalue())
        self.assertTrue(report["ok"])
        names = {c["name"]: c for c in report["checks"]}
        self.assertEqual(names["AGENTS.md in the workspace is read (MANGO)"]["detail"], "read")
        from harness import calib_agy
        self.assertEqual(calib_agy.gemini_buckets(report["quota"]), {"weekly": 0.93, "5h": 0.93})
        stream = (self.tmp / "results" / "smoke-agy-stream.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertIn('{"_smoke_call": 1}', stream)
        self.assertTrue((self.tmp / "results" / "smoke-agy-environment.md").exists())

    def test_no_sign_in_stops_after_call_1(self):
        log = self.tmp / "calls.log"
        with mock.patch.dict(os.environ, {"FAKE_AGY_MODE": "auth", "FAKE_AGY_LOG": str(log)}), \
                mock.patch.object(agy, "entry_argv", return_value=[sys.executable, str(FAKE)]), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(smoke.main(["--unit", "agy-flash", "--i-am-authorized"]), 1)
        self.assertEqual(len(log.read_text(encoding="utf-8").splitlines()), 2)    # call 1 + the quota readout
        report = json.loads((self.tmp / "results" / "smoke-agy.json").read_text(encoding="utf-8"))
        self.assertTrue(any(c["name"].startswith("stopped after call 1") for c in report["checks"]))

    def test_leak_fails_the_smoke(self):
        with mock.patch.dict(os.environ, {"FAKE_AGY_MODE": "leak",
                                          "FAKE_AGY_REAL_HOME": os.environ["AVG_AGY_REAL_HOME"]}), \
                mock.patch.object(agy, "entry_argv", return_value=[sys.executable, str(FAKE)]), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(smoke.main(["--unit", "agy-flash", "--i-am-authorized"]), 1)
        report = json.loads((self.tmp / "results" / "smoke-agy.json").read_text(encoding="utf-8"))
        bad = {c["name"] for c in report["checks"] if not c["ok"]}
        self.assertIn("real ~\\.gemini\\antigravity-cli memory unchanged", bad)


if __name__ == "__main__":
    unittest.main()
