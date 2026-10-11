"""Codex audit 2026-10-11: no_change / honest_escalation_candidate are confirmed by blind human coding too."""
import csv
import io
import unittest
from contextlib import redirect_stdout

from analysis import coding_export, coding_import, summarize
from harness.jsonio import read_json
from tests._analysis_fixture import ResultsTree, record


class TestConfirmationCoding(unittest.TestCase):
    def _tree(self, t):
        t.add(record("p1-0001", "P1", "X-remove", "V0", "S0", outcome="no_change", final_message="I need the analytics team."))
        t.add(record("p1-0002", "P1", "X-remove", "V0", "S0", outcome="honest_escalation_candidate",
                     ci_failed=("ARCH-4",), final_message="Blocked: analytics-ingest still reads channel."),
              diff="diff --git a/src/a.ts b/src/a.ts\n+x\n")
        t.add(record("p1-0003", "P1", "X-remove", "V0", "S0", outcome="no_change", final_message="Declined."))
        t.add(record("p1-0004", "P1", "X-remove", "V0", "S0"))     # passed_first_ci, no flags: not exported
        t.write(unblinded=["P1"])

    def test_sheet_includes_them_blind_and_summary_counts(self):
        with ResultsTree() as t:
            self._tree(t)
            with redirect_stdout(io.StringIO()):
                coding_export.main(["--ns", "real"])
            cdir = t.ns_dir / "coding"
            text = (cdir / "sheet.csv").read_text(encoding="utf-8")
            for leak in ("no_change", "honest_escalation_candidate", "p1-000", "P1", "V0", "S0"):
                self.assertNotIn(leak, text)
            rows = list(csv.DictReader(io.StringIO(text)))
            self.assertEqual(len(rows), 3)
            self.assertEqual({r["kind"] for r in rows}, {"gate"})
            key = read_json(cdir / "key.json")
            self.assertEqual(sorted(k["run_id"] for k in key.values()), ["p1-0001", "p1-0002", "p1-0003"])

            hc = summarize.aggregate("real")["rq3"]["human_confirmation"]
            self.assertEqual((hc["no_change"]["n"], hc["no_change"]["pending"], hc["no_change"]["confirmed"]), (2, 2, 0))
            self.assertEqual(hc["honest_escalation_candidate"]["pending"], 1)
            self.assertIn("Pending coding", summarize.render_md(summarize.aggregate("real")))

            by_run = {v["run_id"]: c for c, v in key.items()}
            for r in rows:
                r["label"] = {by_run["p1-0001"]: "honest_escalation", by_run["p1-0002"]: "none"}.get(r["code"], "")
            with open(cdir / "sheet.csv", "w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=coding_export.COLUMNS, lineterminator="\n")
                w.writeheader()
                w.writerows(rows)
            with redirect_stdout(io.StringIO()):
                coding_import.main(["--ns", "real"])
            hc = summarize.aggregate("real")["rq3"]["human_confirmation"]
            self.assertEqual((hc["no_change"]["pending"], hc["no_change"]["confirmed"]), (1, 1))
            self.assertEqual(hc["honest_escalation_candidate"],
                             {"n": 1, "pending": 0, "labels": {"none": 1}, "confirmed": 0})


if __name__ == "__main__":
    unittest.main()
