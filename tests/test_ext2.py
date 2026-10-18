"""Addendum 2 (P9): the sidecar (184 runs from the P8 shortfall), the addendum-2 lock, the runner's stage list and the
analysis (P9 new runs tested, P8 + P9 combined). No model call; temp folders only."""
import json
import shutil
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from analysis import deck_numbers_ext, summarize
from harness import manifest, prereg, runner
from tests._analysis_fixture import ResultsTree, record

SHORT = {"X-rename|V2|S0|W1|agy-flash": 1, "X-remove|V2|S0|W1|agy-flash": 3}
BILL = ("billing-service",)


class Ext2Generation(unittest.TestCase):
    def test_counts_cells_ids_and_paraphrases(self):
        m = manifest.generate_ext2(shortfall=SHORT)
        self.assertEqual(manifest.validate(m), [])
        self.assertEqual((m["seed"], m["addendum"], m["stage_counts"]), (20261018, 2, {"P9": 184}))
        self.assertEqual([r["run_id"] for r in m["runs"]], [f"p9-{i:04d}" for i in range(1, 185)])
        cells = Counter(r["cell"] for r in m["runs"])
        self.assertEqual(cells["X-rename|V2|S0|W1|agy-flash"], 31)
        self.assertEqual(cells["X-remove|V2|S0|W1|agy-flash"], 33)
        self.assertEqual(sorted(v for k, v in cells.items() if "V2" not in k), [30, 30, 30, 30])
        self.assertEqual(m["p9_n"], dict(cells))
        p1 = {r["cell"].rsplit("|", 1)[0] for r in manifest.generate()["runs"] if r["stage"] == "P1"}
        self.assertEqual({c.rsplit("|", 1)[0] for c in cells}, p1)
        self.assertTrue(all(r["unit"] == "agy-flash" and r["stage"] == "P9" for r in m["runs"]))
        # every round rotates the paraphrase slot, also in the cells whose N is not a multiple of 5
        for r in m["runs"]:
            if r["paraphrase"] is not None:
                self.assertEqual(r["paraphrase"], f"p{(r['round'] - 1) % 5 + 1}")
        self.assertEqual(m, dict(manifest.generate_ext2(shortfall=SHORT), generated_at=m["generated_at"]))

    def test_no_shortfall_gives_180(self):
        self.assertEqual(manifest.generate_ext2(shortfall={})["stage_counts"], {"P9": 180})

    def test_runner_knows_p9(self):
        self.assertIn("P9", runner.STAGES)
        self.assertIn("P9", runner.DRIFT_NOTED)
        self.assertNotIn("P9", runner.EXPLORATORY)


class Addendum2Lock(unittest.TestCase):
    def test_freeze_and_verify_on_temp_copy(self):
        d = Path(tempfile.mkdtemp(prefix="avg-addendum2-"))
        self.addCleanup(shutil.rmtree, d, True)
        files = {"PREREGISTRATION.md": "# prereg\n", "scenario/tasks/X-rename.md": "t\n", "harness/texts/a.md": "a\n",
                 "analysis/RUBRIC.md": "r\n", "harness/units.json": "{}\n", "ci/run.py": "x\n",
                 "results/real/manifest.json": "{}\n", "PREREGISTRATION-ADDENDUM-2.md": "# addendum 2\n",
                 "results/real/manifest-ext2.json": "{}\n"}
        for rel, text in files.items():
            (d / rel).parent.mkdir(parents=True, exist_ok=True)
            (d / rel).write_text(text, encoding="utf-8")
        prereg.freeze(d, commit=False)
        self.assertFalse(prereg.verify_addendum(2, d)[0])
        data = prereg.freeze_addendum(2, d, commit=False)
        self.assertEqual(sorted(data["files"]), sorted(prereg.ADDENDUM_FILES[2]))
        self.assertEqual(prereg.verify_addendum(2, d), (True, []))
        (d / "results/real/manifest-ext2.json").write_text('{"x": 1}\n', encoding="utf-8")
        self.assertEqual(prereg.verify_addendum(2, d)[1], ["addendum 2: changed: results/real/manifest-ext2.json"])


def _tree(t: ResultsTree, unblind=("P8", "P9")):
    n = 0

    def add(stage, ticket, V, S, k=1, **kw):
        nonlocal n
        for _ in range(k):
            n += 1
            t.add(record(f"{stage.lower()}-{n:04d}", stage, ticket, V, S, unit="agy-flash", **kw))
    add("P8", "X-rename", "V0", "S0", 2, broken=BILL, ci_failed=("ARCH-4",))
    add("P8", "X-rename", "V0", "S2", 2)
    add("P9", "X-rename", "V0", "S0", 3, broken=BILL, ci_failed=("ARCH-4",))
    add("P9", "X-rename", "V0", "S2", 3)
    t.write(unblinded=list(unblind))


class Ext2Analysis(unittest.TestCase):
    def test_p9_tested_alone_and_combined_without_p(self):
        with ResultsTree() as t:
            _tree(t)
            agg = summarize.aggregate("real")
            u = agg["ext2"]["units"]["agy-flash"]
            self.assertEqual((u["stage"], u["h2"]["X-rename"]["s0"]["x"], u["h2"]["X-rename"]["s0"]["n"]), ("P9", 3, 3))
            self.assertEqual(agg["ext1"]["units"]["agy-flash"]["h2"]["X-rename"]["s0"]["n"], 2)   # P8 alone
            c = agg["ext2"]["combined"]["agy-flash"]
            row = next(r for r in c["cells"] if r["ticket"] == "X-rename" and r["S"] == "S0")
            self.assertEqual((row["base"]["n"], row["p9"]["n"], row["combined"]["x"], row["combined"]["n"]),
                             (2, 3, 5, 5))
            for r in c["cells"] + c["conditions"]:                      # no p-values on combined data
                self.assertFalse({"p", "p_holm"} & set(r) | {"p", "p_holm"} & set(r.get("combined", {})))
            md = summarize.render_md(agg)
            self.assertIn("Addendum 2 — P9", md)
            self.assertIn("P8 + P9 combined", md)
            deck = deck_numbers_ext.build("real")
            self.assertIn("### P9 — new runs only", deck)
            self.assertIn("### P8 + P9 — combined (descriptive, no p-values)", deck)
            self.assertEqual(deck.count("## Antigravity"), 1)

    def test_p9_blinded(self):
        with ResultsTree() as t:
            _tree(t, unblind=("P8",))
            agg = summarize.aggregate("real")
            self.assertTrue(agg["ext2"]["units"]["agy-flash"]["blinded"])
            self.assertTrue(agg["ext2"]["combined"]["agy-flash"]["blinded"])
            self.assertIn("P9: blinded until the stage is complete.", deck_numbers_ext.build("real"))


if __name__ == "__main__":
    unittest.main()
