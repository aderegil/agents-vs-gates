import json
import unittest
from collections import Counter

from harness import manifest, paths, sanitize


class SanitizeTest(unittest.TestCase):
    def test_token_and_paths(self):
        tok = "sk-ant-oat01-SECRETSECRETSECRET"
        text, exposed = sanitize.clean(f"env {tok} in C:\\Users\\alice.b\\proj and /c/Users/alice/x", tok)
        self.assertTrue(exposed)
        self.assertNotIn("SECRET", text)
        self.assertNotIn("alice", text)
        self.assertIn("~\\proj", text)
        _, exposed = sanitize.clean("nothing here", tok)
        self.assertFalse(exposed)

    def test_exact_token_value_not_token_shaped(self):
        text, exposed = sanitize.clean("value=abcdEFGH1234zzzz end", "abcdEFGH1234zzzz")
        self.assertEqual((text, exposed), ("value=[REDACTED] end", True))

    def test_clean_obj_recurses(self):
        obj, exposed = sanitize.clean_obj({"a": ["x sk-ant-api03-aaaaaaaaaaaa", {"b": "C:\\Users\\bob\\y"}]}, None)
        self.assertTrue(exposed)
        self.assertEqual(obj["a"][1]["b"], "~\\y")

    def test_canaries(self):
        reg = json.loads(paths.CANARIES.read_text(encoding="utf-8"))["canaries"]
        hits = sanitize.canary_hits(f"x {reg['oracle-billing']} y {reg['broker']}", "transcript")
        self.assertEqual({h["origin"] for h in hits}, {"oracle-billing", "broker"})
        self.assertEqual(sanitize.canary_hits("CANARY-0000000000000000", "d")[0]["origin"], "unknown")
        self.assertEqual(sanitize.canary_hits("clean", "d"), [])


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.m = manifest.generate(20261011, "real")

    def test_stage_counts(self):
        self.assertEqual(self.m["stage_counts"], {"P0": 5, "P1": 60, "P2": 10, "P4": 51, "P5": 60})
        p6 = manifest.generate(20261011, "real", with_p6=True)
        self.assertEqual(p6["stage_counts"]["P6"], 40 + 10 + 61)    # P6 keeps the cells from before the V2·S0 move
        self.assertEqual(manifest.validate(self.m), [])

    def test_ids_rounds_and_balance(self):
        p1 = [r for r in self.m["runs"] if r["stage"] == "P1"]
        self.assertEqual([r["run_id"] for r in p1[:2]], ["p1-0001", "p1-0002"])
        self.assertEqual(len({r["run_id"] for r in self.m["runs"]}), len(self.m["runs"]))
        for k in range(1, 11):          # cut after k rounds: every cell has k replicates
            c = Counter(r["cell"] for r in p1[: 6 * k])
            self.assertEqual(set(c.values()), {k})
        p4 = [r for r in self.m["runs"] if r["stage"] == "P4"]
        self.assertEqual(sum(1 for r in p4 if r.get("control")), 6)
        self.assertTrue(all(r["round"] <= 3 for r in p4 if r.get("control")))

    def test_deterministic_and_seeded(self):
        a = [r["cell"] for r in manifest.generate(20261011)["runs"]]
        b = [r["cell"] for r in manifest.generate(20261011)["runs"]]
        c = [r["cell"] for r in manifest.generate(1)["runs"]]
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_units_and_mock_namespace(self):
        p5 = [r for r in self.m["runs"] if r["stage"] == "P5"]
        self.assertEqual(Counter(r["unit"] for r in p5), {"cc-opus": 50, "cc-sonnet": 10})
        self.assertTrue(all(r["wording"] == "W2" for r in p5 if r["unit"] == "cc-sonnet"))
        mock = manifest.generate(20261011, "mock")
        self.assertEqual({r["unit"] for r in mock["runs"]}, {"mock"})


if __name__ == "__main__":
    unittest.main()
