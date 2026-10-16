"""The C8 calibration report (harness.calib_agy) from synthetic records. No call, temp results root."""
import os
import shutil
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from harness import calib_agy, jsonio, manifest, paths


def rec(rid, cell, minutes, inp, out, think, cache, outcome="passed_first_ci"):
    return {"run_id": rid, "cell": cell, "outcome": outcome, "duration_ms": int(minutes * 60000),
            "totals": {"turns": 9, "input_tokens": inp, "output_tokens": out, "cache_read_tokens": cache},
            "sessions": [{"duration_ms": int(minutes * 50000),
                          "usage_extra": {"thinking_tokens": think, "total_tokens": inp + out}}]}


class CalibReport(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-calib-"))
        self.p = mock.patch.dict(os.environ, {"AVG_RESULTS_ROOT": str(self.tmp)})
        self.p.start()
        self.addCleanup(self.p.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)
        runs = manifest.calibration_runs("real")
        for i, r in enumerate(runs):
            ok = i < 4
            jsonio.write_json_atomic(paths.run_dir("real", r["run_id"]) / "record.json",
                                     rec(r["run_id"], r["cell"], 4.0, 200_000, 20_000, 8_000, 150_000,
                                         "passed_first_ci" if ok else "infra_failure"))
        quota = {r["run_id"]: {"before": {"data": {"quotas": [{"remainingFraction": 1.0 - 0.02 * i}]}},
                               "after": {"data": {"quotas": [{"remainingFraction": 0.98 - 0.02 * i}]}}}
                 for i, r in enumerate(runs)}
        jsonio.write_json_atomic(paths.ns_dir("real") / "calibration-agy.json", {"quota": quota})

    def test_summary_numbers(self):
        s = calib_agy.summarize("real", today=date(2026, 10, 16))
        self.assertEqual((s["runs"], s["ok"]), (5, 4))
        self.assertTrue(s["cache_in_input"])                       # total = input + output
        self.assertEqual(s["avg"]["input"], 200_000)
        self.assertEqual(s["api_cost_per_run_usd"], round((200_000 * 0.75 + 20_000 * 3.75) / 1e6, 4))
        self.assertEqual(s["quota"]["used_per_run"], 0.02)
        self.assertEqual(s["quota"]["runs_per_window"], 50)
        self.assertEqual(s["quota"]["windows_needed_120"], 3)
        self.assertEqual(s["quota"]["windows_until_deadline"], 7 * 24 // 5)
        self.assertEqual(s["hours_120"][3], round(4.0 * 120 / 3 / 60, 1))

    def test_report_is_spanish_and_short(self):
        out = calib_agy.write_report("real")
        text = out.read_text(encoding="utf-8")
        self.assertIn("**4 de 5** corridas terminaron bien", text)
        self.assertIn("alcanza", text)
        self.assertIn("Decides tú", text)
        self.assertLess(len(text.splitlines()), 30)
        self.assertIn("summary", jsonio.read_json(paths.ns_dir("real") / "calibration-agy.json"))

    def test_empty(self):
        shutil.rmtree(paths.runs_dir("real"))
        self.assertIn("Todavía no hay corridas", calib_agy.render(calib_agy.summarize("real")))


if __name__ == "__main__":
    unittest.main()
