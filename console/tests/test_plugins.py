"""Plugin discovery, manifest validation, router matching, and the real manifests of this package."""
import json
import tempfile
import unittest
from pathlib import Path

from console.core.plugin_api import Router, compile_pattern
from console.core.plugins import discover, validate_manifest
from console.core.server import PLUGINS_DIR
from console.tests.helpers import write_plugin


class DiscoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_valid_sorted_and_invalid_skipped(self):
        write_plugin(self.root, "zeta", order=2)
        write_plugin(self.root, "alpha", order=5)
        write_plugin(self.root, "broken", {"roles": ["admin"]})          # role not in the enum
        write_plugin(self.root, "mismatch", {"id": "other"})              # id != folder
        bad = self.root / "badjson"
        bad.mkdir()
        (bad / "plugin.json").write_text("{not json", encoding="utf-8")
        missing = self.root / "missingfields"
        missing.mkdir()
        (missing / "plugin.json").write_text(json.dumps({"id": "missingfields"}), encoding="utf-8")
        (self.root / "nomanifest").mkdir()
        good, invalid = discover(self.root)
        self.assertEqual([p.id for p in good], ["zeta", "alpha"])
        self.assertEqual(sorted(b["folder"] for b in invalid), ["badjson", "broken", "mismatch", "missingfields"])

    def test_extra_property_rejected(self):
        errs = validate_manifest({"id": "x", "name": "X", "icon": "list", "order": 1, "description": "d",
                                  "roles": ["owner"], "kind": "module", "entry": "web/index.js", "colour": "red"}, "x")
        self.assertTrue(errs)

    def test_entry_outside_folder_rejected(self):
        write_plugin(self.root, "escape", {"entry": "../../etc/passwd"})
        good, invalid = discover(self.root)
        self.assertEqual(good, [])
        self.assertEqual(invalid[0]["folder"], "escape")

    def test_missing_dir(self):
        self.assertEqual(discover(self.root / "nope"), ([], []))


class RouterTest(unittest.TestCase):
    def test_params_and_precedence(self):
        r = Router("t")
        r.get("/{model}", lambda req: "param")
        r.get("/avatars", lambda req: "static")
        r.get("", lambda req: "root")
        r.post("/{run_id}/diff", lambda req: "diff")
        r.get("/file/{rest:path}", lambda req: "path")
        route, params, _ = r.match("GET", "/avatars")
        self.assertEqual(route.handler(None), "static")
        route, params, _ = r.match("GET", "/cc-sonnet")
        self.assertEqual(params, {"model": "cc-sonnet"})
        route, _, _ = r.match("GET", "")
        self.assertEqual(route.handler(None), "root")
        route, params, exists = r.match("GET", "/p1-0007/diff")
        self.assertIsNone(route)
        self.assertTrue(exists)  # → 405
        route, params, _ = r.match("POST", "/p1-0007/diff")
        self.assertEqual(params["run_id"], "p1-0007")
        route, params, _ = r.match("GET", "/file/src/a/b.ts")
        self.assertEqual(params["rest"], "src/a/b.ts")
        self.assertEqual(r.match("GET", "/a/b/c")[0], None)

    def test_unknown_role_rejected(self):
        with self.assertRaises(ValueError):
            Router("t").get("/x", lambda r: 1, roles=["admin"])

    def test_compile_static_count(self):
        _, names, static = compile_pattern("/{run_id}/diff")
        self.assertEqual((names, static), (["run_id"], 1))


class OwnManifestsTest(unittest.TestCase):
    def test_this_package_manifests_are_valid(self):
        for pid, order, roles in (("overview", 1, {"owner", "operator", "presenter", "viewer"}),
                                  ("readiness", 8, {"owner", "operator"}), ("users", 9, {"owner"})):
            m = json.loads((PLUGINS_DIR / pid / "plugin.json").read_text(encoding="utf-8"))
            self.assertEqual(validate_manifest(m, pid), [], pid)
            self.assertEqual(m["order"], order)
            self.assertEqual(set(m["roles"]), roles)
        r = json.loads((PLUGINS_DIR / "readiness" / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(r["readonly_roles"], ["operator"])


if __name__ == "__main__":
    unittest.main()
