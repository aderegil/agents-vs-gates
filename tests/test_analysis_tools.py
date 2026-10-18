import csv
import io
import json
import unittest
from contextlib import redirect_stdout

from analysis import build_pr_set, coding_export, coding_import, select_poll_pr
from harness.jsonio import read_json
from tests._analysis_fixture import ResultsTree, standard_tree


class TestPrSet(unittest.TestCase):
    def test_categories_and_determinism(self):
        with ResultsTree() as t:
            standard_tree(t)
            t.write()
            a = build_pr_set.build_pr_set("real", seed=1)
            b = build_pr_set.build_pr_set("real", seed=1)
            self.assertEqual([p["run_id"] for p in a["prs"]], [p["run_id"] for p in b["prs"]])
            cats = {p["run_id"]: p["category"] for p in a["prs"]}
            self.assertNotIn("p0-0021", cats)  # calibration never enters
            self.assertNotIn("p1-0017", cats)  # contaminated
            self.assertEqual(cats["p4-0022"], "semantic")  # X-units: CI green, oracle red
            self.assertEqual(cats["p4-0023"], "benign")  # X-add
            self.assertEqual(sum(c == "breaking" for c in cats.values()), 8)  # 3 X-rename S0 + 4 X-remove S0 + 1 P2
            self.assertEqual(sum(p["repeat_subsample"] for p in a["prs"]), 8)
            self.assertEqual(a["shortfall"], {"breaking": 12, "semantic": 9, "benign": 15})


class TestCoding(unittest.TestCase):
    def test_export_is_blind_and_import_roundtrip(self):
        with ResultsTree() as t:
            standard_tree(t)
            t.write(unblinded=["P1", "P2"],                  # the export leaves out blinded stages (2026-10-17)
                    reviews=[{"review_id": "rv1", "pr_id": "pr-001", "run_id": "p1-0001", "condition": "R-C",
                              "rep": 1, "verdict": "request_changes",
                              "reasons": ["billing reads totalCents", "style"]}],
                    pr_set={"prs": [{"pr_id": "pr-001", "run_id": "p1-0001", "ticket": "X-rename",
                                     "affected_consumers": ["billing-service"]}]})
            with redirect_stdout(io.StringIO()):
                coding_export.main(["--ns", "real"])
            cdir = t.ns_dir / "coding"
            text = (cdir / "sheet.csv").read_text(encoding="utf-8")
            for leak in ("p2-0019", "P2", "cc-sonnet", "V1", "R-C"):
                self.assertNotIn(leak, text)
            rows = list(csv.DictReader(io.StringIO(text)))
            self.assertEqual(sorted(r["kind"] for r in rows), ["gate", "reviewer_reason", "reviewer_reason"])
            gate = next(r for r in rows if r["kind"] == "gate")
            self.assertIn("D6 contracts/consumers", gate["detectors"])
            self.assertIn("contracts/consumers", gate["diff_excerpt"])
            for r in rows:
                r["label"] = "T2" if r["kind"] == "gate" else "mentions_affected_consumer_correctly"
            with open(cdir / "sheet.csv", "w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=coding_export.COLUMNS, lineterminator="\n")
                w.writeheader()
                w.writerows(rows)
            with redirect_stdout(io.StringIO()):
                coding_import.main(["--ns", "real"])
            labels = read_json(cdir / "labels.json")
            self.assertEqual(labels["gate"], {"p2-0019": "T2"})
            self.assertEqual(labels["reviewer_reasons"]["rv1"],
                             {"0": "mentions_affected_consumer_correctly", "1": "mentions_affected_consumer_correctly"})

    def test_import_rejects_unknown_label(self):
        with self.assertRaises(ValueError):
            coding_import.merge([{"code": "C1", "label": "T9"}], {"C1": {"run_id": "x"}})


class TestPollPr(unittest.TestCase):
    def test_refuses_while_blinded(self):
        with ResultsTree() as t:
            standard_tree(t)
            t.write()
            with redirect_stdout(io.StringIO()):
                self.assertEqual(select_poll_pr.main(["--ns", "real"]), 2)

    def test_first_breaking_in_manifest_order(self):
        with ResultsTree() as t:
            standard_tree(t)
            t.write(unblinded=["P1"])
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(select_poll_pr.main(["--ns", "real"]), 0)
            self.assertEqual(out.getvalue().splitlines()[0], "p1-0001")
            pdir = t.ns_dir / "poll-pr"
            self.assertTrue((pdir / "gen.diff").exists())
            self.assertEqual(json.loads((pdir / "selection.json").read_text(encoding="utf-8"))["run_id"], "p1-0001")


if __name__ == "__main__":
    unittest.main()
