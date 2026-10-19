"""One label map: console/core/labels.py reads its words from console/web/lib/labels.js. These tests check, with Node,
that both sides hold the same map and that the Python helpers give the same strings as their JavaScript twins."""
import json
import shutil
import subprocess
import unittest

from console.core import labels as L

HAVE_NODE = shutil.which("node") is not None

SAMPLE_CODES = ["X-rename", "X-units", "V1", "S2", "W2", "P1", "P7", "C8", "X2", "selftest", "H2", "HS-V2", "D6",
                "RQ1", "RQ4", "R-S0", "R-C", "ZZ-9", ""]
SAMPLE_CONDS = [["V0", "S0", "W1"], ["V2", "S0", None], ["V0", "S2", "W2"], ["V1", "S0", "W1"], ["V0", None, None]]
SAMPLE_RUNS = ["p1-0002", "p6-0012", "x1c-0001", "c8-0004", "st-0014", "st-demo-2", "pr-001", "ARCH-4"]

NODE_DUMP = r"""
const L = await import(process.argv[1]);
const [codes, conds, runs] = JSON.parse(process.argv[2]);
const out = {};
for (const k of ["GLOSSARY", "STAGES", "HYPOTHESES", "DETECTORS", "QUESTIONS", "REVIEWERS", "OUTCOME_LABEL"]) out[k] = L[k];
out.withCode = codes.map((c) => L.withCode(c));
out.meaningOf = codes.map((c) => L.meaningOf(c));
out.plainCondition = conds.map(([V, S, W]) => L.plainCondition(V, S, W));
out.conditionCode = conds.map(([V, S, W]) => L.conditionCode(V, S, W));
out.runName = runs.map((r) => L.runName(r));
out.legend = L.LEGEND.flatMap((g) => g.codes);
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(HAVE_NODE, "node not on PATH")
class BothSidesAgree(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run(["node", "--input-type=module", "-e", NODE_DUMP, L.LABELS_JS.as_uri(),
                            json.dumps([SAMPLE_CODES, SAMPLE_CONDS, SAMPLE_RUNS])],
                           capture_output=True, text=True, encoding="utf-8", timeout=60)
        assert r.returncode == 0, r.stderr[-1500:]
        cls.js = json.loads(r.stdout)

    def test_same_map(self):
        for fam in ("GLOSSARY", "STAGES", "HYPOTHESES", "DETECTORS", "QUESTIONS", "REVIEWERS", "OUTCOME_LABEL"):
            self.assertEqual(L.MAP[fam], self.js[fam], fam)

    def test_same_helpers(self):
        self.assertEqual([L.with_code(c) for c in SAMPLE_CODES], self.js["withCode"])
        self.assertEqual([L.meaning_of(c) for c in SAMPLE_CODES], self.js["meaningOf"])
        self.assertEqual([L.plain_condition(*c) for c in SAMPLE_CONDS], self.js["plainCondition"])
        self.assertEqual([L.condition_code(*c) for c in SAMPLE_CONDS], self.js["conditionCode"])
        self.assertEqual([L.run_name(r) for r in SAMPLE_RUNS], self.js["runName"])

    def test_every_legend_code_has_words(self):
        for code in self.js["legend"]:
            self.assertTrue(L.short(code) and L.short(code) != code, code)


class PythonSide(unittest.TestCase):
    def test_console_style(self):
        self.assertEqual(L.with_code("X-rename"), "Rename two fields (X-rename)")
        self.assertEqual(L.condition_with_code("V0", "S2"), "Own repo · Rule in the spec (V0·S2)")
        self.assertEqual(L.with_code("R-C"), "Reviewer: rule and contracts (R-C)")
        self.assertEqual(L.with_code("RQ2"), "Rule or repos (RQ2)")
        self.assertEqual(L.run_with_code("p1-0002"), "Main test · run 2 (p1-0002)")
        self.assertEqual(L.with_code("ZZ-9"), "ZZ-9")

    def test_a_line_it_cannot_read_is_an_error(self):
        src = L.LABELS_JS.read_text(encoding="utf-8").replace('V0: { short: "Own repo",', 'V0: { short: x,', 1)
        with self.assertRaises(ValueError):
            L.parse(src)


if __name__ == "__main__":
    unittest.main()
