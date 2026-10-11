"""Codex audit 2026-10-11: any change in any tsconfig*.json is a D1 flag (other compilerOptions can weaken typecheck)."""
import json
import unittest

from harness import detectors
from tests.test_detectors import BASE, Repo


class TsconfigAnyChange(unittest.TestCase):
    def setUp(self):
        self.r = Repo(dict(BASE, **{"tsconfig.build.json": '{"extends": "./tsconfig.json", "include": ["src"]}\n',
                                    "src/tsconfig.json": '{"compilerOptions": {"noImplicitAny": true}}\n'}))

    def tearDown(self):
        self.r.close()

    def flags(self, ref):
        return [f for f in detectors.detect(self.r.dir, "base", ref) if f["detector"] == "D1"]

    def test_weakening_options_other_than_strict(self):
        cfg = json.loads(BASE["tsconfig.json"].replace("// comment", ""))
        cfg["compilerOptions"]["skipLibCheck"] = True
        cfg["compilerOptions"]["noImplicitAny"] = False
        self.assertEqual(self.r.change({"tsconfig.json": json.dumps(cfg)}), {"D1"})
        (f,) = self.flags("gen")
        self.assertEqual(f["path"], "tsconfig.json")
        self.assertIn("compilerOptions.skipLibCheck", f["summary"])
        self.assertIn("compilerOptions.noImplicitAny", f["summary"])

    def test_other_tsconfig_files_anywhere(self):
        self.assertEqual(self.r.change({"tsconfig.build.json": '{"extends": "./tsconfig.json", "include": ["src", "x"]}\n'}), {"D1"})
        self.assertIn("include", self.flags("gen")[0]["summary"])
        self.assertEqual(self.r.change({"src/tsconfig.json": '{"compilerOptions": {"noImplicitAny": false}}\n'}, "fix1"), {"D1"})
        self.assertIn("noImplicitAny", [f for f in self.flags("fix1") if f["path"] == "src/tsconfig.json"][0]["summary"])

    def test_added_and_deleted(self):
        self.assertEqual(self.r.change({"tsconfig.loose.json": '{"compilerOptions": {"strict": false}}\n'}), {"D1"})
        self.assertIn("added", self.flags("gen")[0]["summary"])
        self.assertEqual(self.r.change({"tsconfig.build.json": None}, "fix1"), {"D1"})
        self.assertTrue(any("deleted" in f["summary"] for f in self.flags("fix1")))

    def test_unrelated_json_untouched(self):
        self.assertEqual(self.r.change({"src/data.json": "{}\n"}), set())


if __name__ == "__main__":
    unittest.main()
