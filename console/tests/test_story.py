"""Home (story plugin): question-first answers and the Talk figures, computed from the records; and the Results
"By agent" table. Synthetic results tree (tests/_analysis_fixture.py); nothing calls a model or a runner."""
import importlib.util
import unittest
from pathlib import Path

from console.plugins.results import payload
from tests._analysis_fixture import ResultsTree
from tests.test_summarize import _p6_tree

_spec = importlib.util.spec_from_file_location(
    "story_figures", Path(__file__).resolve().parents[1] / "plugins" / "story" / "figures.py")
figures = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(figures)


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
