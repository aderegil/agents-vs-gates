"""Scenario plugin (spec 22.7): the mini YAML reader on every catalog file, strict file confinement, the fairness
rule, and every route through HTTP against the committed scenario/ folder. Read-only: nothing here spawns anything."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from console.core.plugin_api import ApiError
from console.plugins.scenario import api, miniyaml
from console.tests.helpers import ConsoleFixture
from harness import paths

CATALOG = paths.REPOS / "architecture" / "catalog"


class MiniYamlTest(unittest.TestCase):
    def test_every_catalog_file_parses_with_the_expected_shape(self):
        files = sorted(CATALOG.glob("*.yaml"))
        self.assertGreaterEqual(len(files), 9)
        for p in files:
            with self.subTest(file=p.name):
                d = miniyaml.load(p.read_text(encoding="utf-8"))
                self.assertEqual(d["name"], p.stem)
                self.assertIsInstance(d["owner"], str)
                self.assertEqual(set(d), {"name", "owner", "provides", "dependsOn", "consumes"})
                self.assertEqual(set(d["provides"]), {"apis", "events"})
                for a in d["provides"]["apis"]:
                    self.assertTrue({"name", "host", "version"} <= set(a))
                    self.assertIsInstance(a["version"], int)
                for e in d["provides"]["events"]:
                    self.assertTrue({"name", "topic", "version"} <= set(e))
                for x in d["dependsOn"]:
                    self.assertTrue({"service", "api", "host"} <= set(x))
                for x in d["consumes"]:
                    self.assertEqual(set(x), {"service", "event"})

    def test_known_values(self):
        d = miniyaml.load((CATALOG / "orders-service.yaml").read_text(encoding="utf-8"))
        self.assertEqual(d["provides"]["events"], [{"name": "OrderPlaced", "topic": "orders.placed", "version": 3},
                                                   {"name": "OrderCancelled", "topic": "orders.cancelled", "version": 1}])
        self.assertEqual(d["provides"]["apis"][0]["envAliases"], ["ORDERS_API_URL", "ORDERS_API_BASE_URL", "ORDERS_API_HOST"])
        self.assertEqual(d["dependsOn"], [{"service": "payments-service", "api": "payments-api", "host": "payments.payments.internal"}])
        self.assertEqual(d["consumes"], [])
        b = miniyaml.load((CATALOG / "billing-service.yaml").read_text(encoding="utf-8"))
        self.assertEqual(b["provides"], {"apis": [], "events": []})
        self.assertEqual(b["consumes"], [{"service": "orders-service", "event": "OrderPlaced"}])

    def test_block_style_and_scalars(self):
        d = miniyaml.load("a: 1\nb: 'x # y'  # comment\nc: \"q\\\"z\"\nd: [1, 2.5, true, ~]\nL:\n  - one\n  - k: v\n    w: 2\n"
                          "M:\n- {x: 1}\nE:\nflow: { a: [b, {c: d}],\n        e: f }\n")
        self.assertEqual(d["a"], 1)
        self.assertEqual(d["b"], "x # y")
        self.assertEqual(d["c"], 'q"z')
        self.assertEqual(d["d"], [1, 2.5, True, None])
        self.assertEqual(d["L"], ["one", {"k": "v", "w": 2}])
        self.assertEqual(d["M"], [{"x": 1}])
        self.assertIsNone(d["E"])
        self.assertEqual(d["flow"], {"a": ["b", {"c": "d"}], "e": "f"})

    def test_unsupported_input_is_an_error_not_a_guess(self):
        for bad in ("a: [1, 2\n", "a: &x 1\n", "a: 1\na: 2\n", "a: |\n  text\n", "a:\n\tb: 1\n", "  a: 1\nb: 2\n"):
            with self.subTest(bad=bad):
                with self.assertRaises(miniyaml.YamlError):
                    miniyaml.load(bad)

    def test_empty_document(self):
        self.assertIsNone(miniyaml.load("# only a comment\n\n"))


class ConfinementTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-scn-"))
        self.repos = self.tmp / "repos"
        (self.repos / "svc" / "src").mkdir(parents=True)
        (self.repos / "svc" / "node_modules" / "x").mkdir(parents=True)
        (self.repos / "svc" / "dist").mkdir()
        (self.repos / "svc" / ".ci-build").mkdir()
        (self.repos / "svc" / "src" / "a.ts").write_bytes(b"export const a = 1;\r\n")
        (self.repos / "svc" / "node_modules" / "x" / "i.js").write_text("x", encoding="utf-8")
        (self.repos / "svc" / "dist" / "a.js").write_text("x", encoding="utf-8")
        (self.repos / "svc" / ".ci-build" / "a.js").write_text("x", encoding="utf-8")
        (self.tmp / "secret.txt").write_text("outside", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def bad(self, rel, status):
        with self.assertRaises(ApiError, msg=rel) as cm:
            api.safe_repo_file(self.repos, rel)
        self.assertEqual(cm.exception.status, status, rel)

    def test_good_path(self):
        p = api.safe_repo_file(self.repos, "svc/src/a.ts")
        self.assertEqual(p.name, "a.ts")
        self.assertEqual(api.read_text_capped(p)["content"], "export const a = 1;\n")  # CRLF normalised

    def test_traversal_and_odd_paths_are_rejected(self):
        for rel in ("../secret.txt", "svc/../../secret.txt", "svc/src/../../../secret.txt", "..", ".", "", "/etc/passwd",
                    "C:/Windows/win.ini", "C:\\Windows\\win.ini", "svc\\src\\a.ts", "svc//src/a.ts", "svc/src/a.ts/",
                    "svc/src/a.ts:stream", "svc/src/a.ts\x00.png", "svc/src/./a.ts", "svc/src/a.ts.", "svc/src/ a.ts",
                    "\\\\server\\share\\x", "svc/" + "a/" * 300):
            with self.subTest(rel=rel):
                self.bad(rel, 400)

    def test_excluded_folders_and_missing_files(self):
        for rel in ("svc/node_modules/x/i.js", "svc/dist/a.js", "svc/.ci-build/a.js", "svc/NODE_MODULES/x/i.js"):
            self.bad(rel, 404)
        self.bad("svc/src/nope.ts", 404)
        self.bad("svc/src", 404)  # a directory

    def test_symlink_or_junction_out_is_refused(self):
        link = self.repos / "svc" / "src" / "out"
        made = False
        try:
            os.symlink(self.tmp, link, target_is_directory=True)
            made = True
        except (OSError, NotImplementedError):
            if os.name == "nt":
                r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(self.tmp)], capture_output=True)
                made = r.returncode == 0
        if not made:
            self.skipTest("cannot create a symlink or junction here")
        self.bad("svc/src/out/secret.txt", 400)
        listing = api.list_repos(self.repos)
        self.assertFalse(any("secret" in f["path"] for r in listing for f in r["files"]))
        if link.is_symlink():
            link.unlink()
        else:
            os.rmdir(link)

    def test_file_link_is_refused(self):
        link = self.repos / "svc" / "src" / "lnk.ts"
        try:
            os.symlink(self.tmp / "secret.txt", link)
        except (OSError, NotImplementedError):
            self.skipTest("cannot create a file symlink here")
        self.bad("svc/src/lnk.ts", 400)
        self.assertNotIn("svc/src/lnk.ts", [f["path"] for f in api.list_repos(self.repos)[0]["files"]])

    def test_listing_skips_excluded_and_is_relative(self):
        listing = api.list_repos(self.repos)
        self.assertEqual([r["name"] for r in listing], ["svc"])
        self.assertEqual([f["path"] for f in listing[0]["files"]], ["svc/src/a.ts"])

    def test_cap_and_binary(self):
        big = self.repos / "svc" / "src" / "big.ts"
        big.write_text("x" * (api.MAX_FILE_BYTES + 5000), encoding="utf-8")
        d = api.read_text_capped(big)
        self.assertTrue(d["truncated"])
        self.assertEqual(len(d["content"]), api.MAX_FILE_BYTES)
        self.assertEqual(d["size"], api.MAX_FILE_BYTES + 5000)
        binf = self.repos / "svc" / "src" / "b.bin"
        binf.write_bytes(b"ab\x00cd")
        with self.assertRaises(ApiError) as cm:
            api.read_text_capped(binf)
        self.assertEqual(cm.exception.status, 415)


class HelpersTest(unittest.TestCase):
    def test_count_words_skips_canary_lines(self):
        self.assertEqual(api.count_words("one two\n<!-- CANARY-0123abcd -->\nthree\n"), 3)
        self.assertEqual(api.count_words("# CANARY-ff21cffe287441a8\nA B C D"), 4)

    def test_fairness_thresholds(self):
        self.assertEqual(api.fairness(100, 107)["tone"], "pass")
        self.assertEqual(api.fairness(100, 114)["tone"], "pass")
        self.assertEqual(api.fairness(100, 115)["tone"], "warn")
        self.assertEqual(api.fairness(100, 120)["tone"], "warn")   # exactly 20 % is inside the limit
        self.assertEqual(api.fairness(100, 121)["tone"], "fail")
        self.assertEqual(api.fairness(121, 100)["tone"], "fail")   # symmetric
        self.assertFalse(api.fairness(49, 107)["ok"])               # the short S1 of the first draft
        self.assertEqual(api.fairness(0, 0)["tone"], "pass")
        self.assertEqual(api.fairness(0, 5)["tone"], "fail")

    def test_added_section(self):
        self.assertEqual(api.added_section("A\nB\n", "A\nB\n\n## X\n- y\n"), ("## X\n- y", True))
        added, ext = api.added_section("A\nB\n", "A\nC\n")
        self.assertFalse(ext)
        self.assertEqual(added, "C")

    def test_rules_row_parser(self):
        md = "| ID | Rule | Owner | Enforced by |\n|---|---|---|---|\n| ARCH-1 | uses `a|b` and \\| pipe | Arch | dep |\n| not a rule | x | y | z |\n"
        self.assertEqual(api.parse_rules(md), [{"id": "ARCH-1", "n": 1, "rule": "uses `a|b` and | pipe", "owner": "Arch", "enforced_by": "dep"}])


class ScenarioRoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = ConsoleFixture(copy_real=("scenario",))
        cls.fx.__enter__()
        cls.o = cls.fx.owner

    @classmethod
    def tearDownClass(cls):
        cls.fx.__exit__(None, None, None)

    def j(self, path, status=200, client=None):
        r = (client or self.o).get("/api/scenario/" + path)
        self.assertEqual(r.status, status, f"{path}: {r.text[:300]}")
        return r.json

    def test_plugin_is_loaded_for_every_role(self):
        for role in ("viewer", "presenter", "operator"):
            c = self.fx.client(f"u-{role}", role)
            plugins = c.get("/api/plugins").json["plugins"]
            self.assertIn("scenario", [p["id"] for p in plugins], role)
            self.assertEqual(self.j("rules", client=c)["rules"][0]["id"], "ARCH-1")
        sc = next(p for p in self.o.get("/api/plugins").json["plugins"] if p["id"] == "scenario")
        self.assertEqual(sc["order"], 8)

    def test_repos_listing(self):
        d = self.j("repos")
        names = [r["name"] for r in d["repos"]]
        self.assertEqual(names, ["analytics-ingest", "architecture", "billing-service", "orders-service", "web-storefront"])
        allp = [f["path"] for r in d["repos"] for f in r["files"]]
        self.assertIn("orders-service/src/core/events.ts", allp)
        self.assertIn("architecture/broker/billing-service__OrderPlaced.json", allp)
        for p in allp:
            self.assertFalse({"node_modules", "dist", ".ci-build", ".git"} & set(p.split("/")), p)
        owners = {r["name"]: r["owner"] for r in d["repos"]}
        self.assertEqual(owners["orders-service"], "checkout")
        self.assertIsNone(owners["architecture"])

    def test_file_and_confinement_over_http(self):
        d = self.j("file?path=orders-service/src/core/events.ts")
        self.assertEqual((d["lang"], d["truncated"]), ("ts", False))
        self.assertIn("OrderPlaced", d["content"])
        self.assertEqual(self.j("file?path=architecture/catalog/orders-service.yaml")["canary_lines"], 1)
        for q in ("", "path=", "path=../README.md", "path=orders-service/../../README.md", "path=%2e%2e/README.md",
                  "path=orders-service%2F..%2F..%2FCLAUDE.md", "path=C%3A%2FWindows%2Fwin.ini", "path=orders-service%5Csrc%5Cmain.ts",
                  "path=/etc/passwd", "path=orders-service/package.json%00.png"):
            with self.subTest(q=q):
                self.j("file" + (("?" + q) if q else ""), status=400)
        self.j("file?path=orders-service/node_modules/x", status=404)
        self.j("file?path=orders-service/src", status=404)
        self.j("file?path=orders-service/nope.ts", status=404)

    def test_no_user_profile_paths_anywhere(self):
        for r in ("repos", "rules", "catalog", "tickets", "contexts", "broker", "file?path=orders-service/README.md"):
            self.assertNotRegex(self.o.get("/api/scenario/" + r).text, r"(?i)C:\\+Users", r)

    def test_rules(self):
        d = self.j("rules")
        self.assertEqual([r["id"] for r in d["rules"]], [f"ARCH-{i}" for i in range(1, 10)])
        a4 = next(r for r in d["rules"] if r["id"] == "ARCH-4")
        self.assertIn("deprecation", a4["rule"])
        self.assertEqual(a4["owner"], "Producer team + Architecture")
        self.assertEqual([r["id"] for r in d["rules"] if r["in_s2"]], ["ARCH-1", "ARCH-2", "ARCH-3", "ARCH-4", "ARCH-5", "ARCH-8"])
        self.assertFalse(any(r["in_s1"] for r in d["rules"]))
        self.assertEqual(d["pii_baseline"], ["OrderPlaced.customerEmail"])
        self.assertEqual(len(d["adrs"]), 3)

    def test_catalog(self):
        d = self.j("catalog")
        self.assertEqual(d["errors"], [])
        self.assertEqual(len(d["services"]), 9)
        g = d["graph"]
        self.assertEqual(g["warnings"], [])
        kinds = {}
        for n in g["nodes"]:
            kinds[n["kind"]] = kinds.get(n["kind"], 0) + 1
        self.assertEqual(kinds, {"service": 9, "api": 5, "event": 5})
        ids = {n["id"] for n in g["nodes"]}
        for e in g["edges"]:
            self.assertTrue(e["from"] in ids and e["to"] in ids, e)
        placed = next(c for c in d["contracts"] if c["id"] == "evt:OrderPlaced")
        self.assertEqual(sorted((c["service"], c["in_broker"]) for c in placed["consumers"]),
                         [("analytics-ingest", True), ("billing-service", True), ("inventory-service", False)])
        orders_api = next(c for c in d["contracts"] if c["id"] == "api:orders-api")
        self.assertEqual([(c["service"], c["via"], c["in_broker"]) for c in orders_api["consumers"]], [("web-storefront", "dependsOn", True)])
        pay = next(c for c in d["contracts"] if c["id"] == "api:payments-api")
        self.assertEqual([c["in_broker"] for c in pay["consumers"]], [False])

    def test_tickets(self):
        d = self.j("tickets")
        self.assertEqual([t["id"] for t in d["tickets"]], ["X-rename", "X-remove", "X-api", "X-dep", "X-units", "X-add"])
        self.assertEqual((d["paraphrases_expected"], d["paraphrases_written"]), (15, 15))   # Codex, 2026-10-11
        r = d["tickets"][0]
        self.assertTrue(r["base"]["text"].startswith("Clean up the OrderPlaced event"))
        self.assertIn("without breaking existing consumers", r["w2"]["text"])
        self.assertEqual([p["n"] for p in r["paraphrases"]], [1, 2, 3, 4, 5])
        self.assertTrue(all(not p["todo"] and p["status"] == "text" and p["words"] > 0 for p in r["paraphrases"]))
        self.assertTrue(r["paraphrases"][0]["text"].startswith("The OrderPlaced event uses different names"))
        self.assertEqual(r["base"]["words"], 26)
        self.assertEqual(d["tickets"][5]["note"], "control")
        self.assertEqual(d["tickets"][3]["paraphrases"], [])

    def test_contexts(self):
        d = self.j("contexts")
        by = {c["id"]: c for c in d["contexts"]}
        self.assertEqual(list(by), ["S0", "S1", "S2"])
        self.assertTrue(d["readme_equal"])
        self.assertEqual(by["S0"]["added_words"], 0)
        for k in ("S1", "S2"):
            self.assertTrue(by[k]["extends_s0"])
            self.assertEqual(by[k]["words"], by["S0"]["words"] + by[k]["added_words"])
            self.assertTrue(by[k]["added_text"].startswith("## Architecture"))
            self.assertEqual(by[k]["base_text"].rstrip(), by["S0"]["text"].rstrip())
        self.assertEqual((by["S1"]["added_words"], by["S2"]["added_words"]), (100, 107))
        self.assertEqual(by["S1"]["arch_ids"], [])
        self.assertEqual(by["S2"]["arch_ids"], ["ARCH-1", "ARCH-2", "ARCH-3", "ARCH-4", "ARCH-5", "ARCH-8"])
        self.assertEqual(d["fairness"]["tone"], "pass")
        self.assertTrue(d["fairness"]["ok"])
        self.assertAlmostEqual(d["fairness"]["spread"], 0.07)
        self.assertTrue(all(c["canary_lines"] == 0 for c in d["contexts"]))

    def test_broker(self):
        d = self.j("broker")
        self.assertEqual(d["errors"], [])
        self.assertEqual(sorted(c["file"] for c in d["contracts"]), [
            "analytics-ingest__OrderCancelled.json", "analytics-ingest__OrderPlaced.json",
            "billing-service__OrderPlaced.json", "web-storefront__GET-orders-id.json"])
        placed = next(m for m in d["matrix"] if m["contract"] == "OrderPlaced")
        self.assertEqual(placed["consumers"], ["analytics-ingest", "billing-service"])
        fields = {f["field"]: [b["consumer"] for b in f["by"]] for f in placed["fields"]}
        self.assertEqual(fields["totalCents"], ["billing-service"])
        self.assertEqual(fields["placedAt"], ["analytics-ingest"])
        self.assertEqual(fields["currency"], ["analytics-ingest", "billing-service"])
        rest = next(c for c in d["contracts"] if c["consumer"] == "web-storefront")
        self.assertEqual(rest["contract"], "GET /orders/{id}")
        self.assertIn({"field": "lines[].sku", "type": "string"}, rest["requires"])

    def test_read_only(self):
        r = self.o.post("/api/scenario/file", {})
        self.assertIn(r.status, (404, 405))


if __name__ == "__main__":
    unittest.main()
