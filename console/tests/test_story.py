"""Home (story plugin): question-first answers and the Talk figures, computed from the records; and the Results
"By agent" table. Synthetic results tree (tests/_analysis_fixture.py); nothing calls a model or a runner."""
import importlib.util
import re
import unittest
from pathlib import Path

from console.plugins.results import payload
from tests._analysis_fixture import ResultsTree
from tests.test_summarize import _p6_tree

_spec = importlib.util.spec_from_file_location(
    "story_figures", Path(__file__).resolve().parents[1] / "plugins" / "story" / "figures.py")
figures = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(figures)

# A code that would be on screen without its words: tickets, V/S/W, stages, H2/HS-V2, reviewer conditions, RQs, run ids.
CODE = re.compile(r"\bX-(?:rename|remove|add|api|dep|units)\b|(?<![\w-])(?:[VSW][0-2]|P[0-9]|C8|X[12]|H2|D[1-8])(?![\w-])"
                  r"|\bHS-V2\b|\bR-(?:S0|S2|C)\b|\bRQ[1-7]\b|\b[pPxXcC]\d-\d{4}\b")


class TestStory(unittest.TestCase):
    def test_figures_and_questions_from_records(self):
        with ResultsTree() as t:
            _p6_tree(t)
            t.write(unblinded=["P1", "P6"])
            s = figures.story("real")
            ids = {f["id"] for f in s["figures"]}
            for fid in ("s10-v2-rename", "s16-claude-V0S0", "s16-codex-V0S2", "s16-ci", "s20-codex-edit"):
                self.assertIn(fid, ids)
            for f in s["figures"]:
                self.assertTrue(f["query"], f["id"])
                self.assertIn(f["matches"], (True, False, None), f["id"])
                self.assertRegex(f["value"], r"\d|no runs|—|not coded", f["id"])
            self.assertEqual(s["checked"], sum(1 for f in s["figures"] if f["matches"] is not None))
            self.assertEqual([q["id"] for q in s["questions"]], ["rq1", "rq2", "rq2b", "rq3", "rq4", "rq5"])
            for q in s["questions"]:
                self.assertTrue(q["links"])
            # plain words first, the code only after them in parentheses (docs/DECISIONS.md, «Plain words»)
            texts = [x for f in s["figures"] for x in (f["query"], f["claim"], f["note"] or "")]
            texts += [lk["label"] for q in s["questions"] for lk in q["links"]]
            for text in texts:
                self.assertIsNone(CODE.search(re.sub(r"\([^()]*\)", "", text)), text)
            self.assertIn("Main test (P1) · Claude Code (Sonnet) · Rename two fields (X-rename) · Every repo visible · "
                          "No rule (V2·S0) · broke another team on the first try",
                          [f["query"] for f in s["figures"]])

    def test_blinded_stages_count_for_nothing(self):
        with ResultsTree() as t:
            _p6_tree(t)
            t.write(unblinded=[])
            s = figures.story("real")
            f = {x["id"]: x for x in s["figures"]}
            self.assertEqual(f["s16-claude-V0S0"]["value"], "no runs")
            self.assertEqual(f["s16-codex-V0S0"]["value"], "no runs")


class TestByAgent(unittest.TestCase):
    def test_cells_side_by_side_without_p_values(self):
        with ResultsTree() as t:
            _p6_tree(t)
            t.write(unblinded=["P1", "P6"])
            ba = payload.rq_payload("real")["by_agent"]
            self.assertTrue(ba["rows"])
            for r in ba["rows"]:
                self.assertIn("cc-sonnet", r["units"])
                self.assertIn("codex", r["units"])
                for u in r["units"].values():
                    self.assertNotIn("p", u)
            self.assertIn("Descriptive", ba["note"])
            self.assertIn("no test", ba["note"])


if __name__ == "__main__":
    unittest.main()
