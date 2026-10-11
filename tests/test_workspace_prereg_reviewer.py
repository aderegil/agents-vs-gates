import json
import shutil
import tempfile
import unittest
from pathlib import Path

from harness import gitutil, prereg, reviewer, scenario_io
from harness.workspace import add_npm_script, materialize
from tests._fake_scenario import CAN_BILLING, FakeScenario


class WorkspaceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fs = FakeScenario().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fs.__exit__(None, None, None)

    def test_v0_context_file_by_cli_and_base_tag(self):
        units = {"mock": {"adapter": "mock"}, "cx": {"adapter": "codex"}}
        ws = materialize("selftest", 1, "cx", "X-rename", "V0", "S1", units=units)
        names = sorted(p.name for p in ws.root.iterdir())
        self.assertIn("AGENTS.md", names)
        self.assertNotIn("CLAUDE.md", names)
        self.assertNotIn("architecture", names)
        self.assertEqual((ws.root / "AGENTS.md").read_text(encoding="utf-8"), scenario_io.context_text("S1"))
        self.assertEqual(gitutil.git(ws.root, "tag").split(), ["base"])
        self.assertEqual(gitutil.git(ws.root, "status", "--porcelain"), "")
        self.assertEqual(ws.service_dir, ws.root)
        ws.clean()

    def test_v1_extras_without_canaries(self):
        ws = materialize("selftest", 1, "mock", "X-remove", "V1", "S0", units={"mock": {"adapter": "mock"}})
        cons = sorted(p.name for p in (ws.root / "contracts" / "consumers").iterdir())
        self.assertEqual(cons, ["analytics-ingest__OrderCancelled.json", "analytics-ingest__OrderPlaced.json",
                                "billing-service__OrderPlaced.json"])
        for p in (ws.root / "contracts" / "consumers").iterdir():
            self.assertNotIn("CANARY", p.read_text(encoding="utf-8"))
            self.assertNotIn("_canary", json.loads(p.read_text(encoding="utf-8")))
        pkg = json.loads((ws.root / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(pkg["scripts"]["contracts"], "node scripts/verify-contracts.mjs")
        ws.clean()

    def test_v2_layout(self):
        ws = materialize("selftest", 1, "mock", "X-rename", "V2", "S2", units={"mock": {"adapter": "mock"}})
        self.assertEqual(sorted(p.name for p in ws.root.iterdir() if p.name != ".git"),
                         ["CLAUDE.md", "analytics-ingest", "billing-service", "orders-service", "web-storefront"])
        ctx = (ws.root / "CLAUDE.md").read_text(encoding="utf-8")
        self.assertTrue(ctx.startswith(scenario_io.V2_LINE + "\n\n"))
        self.assertTrue(ctx.endswith(scenario_io.context_text("S2")))
        billing = (ws.root / "billing-service" / "src" / "onOrderPlaced.ts").read_text(encoding="utf-8")
        self.assertNotIn(CAN_BILLING, billing)
        self.assertIn("totalCents", billing)
        self.assertEqual(ws.service_prefix, "orders-service/")
        snap = ws.archive("base")
        self.assertTrue((snap / "src" / "core" / "events.ts").exists())
        self.assertFalse(snap.is_relative_to(ws.root))
        ws.clean()

    def test_add_npm_script_keeps_format(self):
        d = Path(tempfile.mkdtemp())
        try:
            p = d / "package.json"
            p.write_text('{\n  "name": "x",\n  "engines": { "node": ">=24" },\n  "scripts": {\n    "a": "b"\n  }\n}\n',
                         encoding="utf-8")
            add_npm_script(p, "contracts", "node scripts/verify-contracts.mjs")
            self.assertEqual(p.read_text(encoding="utf-8"),
                             '{\n  "name": "x",\n  "engines": { "node": ">=24" },\n  "scripts": {\n    "a": "b",\n'
                             '    "contracts": "node scripts/verify-contracts.mjs"\n  }\n}\n')
        finally:
            shutil.rmtree(d)


class SelftestLogicTest(unittest.TestCase):
    def test_truth_rows_with_fake_pipeline(self):
        import io
        from harness import selftest
        with FakeScenario() as fs:
            buf = io.StringIO()
            code = selftest.run_truth_table(pipeline=fs.pipeline, out=lambda s: print(s, file=buf), rows=["1", "7"])
            self.assertEqual(code, 0, buf.getvalue())
            self.assertIn("TRUTH TABLE 2/2 OK", buf.getvalue())

    def test_default_cases_cover_manifest_and_demos(self):
        from harness import manifest, selftest
        cs = selftest.cases("default")
        combos = {(c["entry"]["ticket"], c["entry"]["visibility"], c["entry"]["spec"], c["entry"]["wording"]) for c in cs}
        want = {(r["ticket"], r["visibility"], r["spec"], r["wording"]) for r in manifest.generate(ns="mock")["runs"]}
        self.assertEqual(want - combos, set())
        self.assertEqual([c["entry"]["run_id"] for c in cs if c.get("demo")],
                         ["st-demo-1", "st-demo-2", "st-demo-3", "st-demo-4"])
        self.assertTrue(all(c["expect"].get("outcome") for c in cs))
        self.assertEqual(len(selftest.cases("full")), 55 + len(selftest.EXTRA) + 4)


class PreregTest(unittest.TestCase):
    def test_freeze_and_verify_on_temp_copy(self):
        d = Path(tempfile.mkdtemp(prefix="avg-prereg-"))
        try:
            files = {"PREREGISTRATION.md": "# prereg\n", "scenario/tasks/X-rename.md": "t\n",
                     "scenario/context/orders-service/S0.md": "s0\n", "harness/texts/ci_feedback.md": "fb\n",
                     "analysis/RUBRIC.md": "r\n", "harness/units.json": "{}\n", "ci/run.py": "x\n",
                     "ci/checks/arch4.mjs": "y\n", "results/real/manifest.json": "{}\n", "other.txt": "not frozen\n"}
            for rel, t in files.items():
                (d / rel).parent.mkdir(parents=True, exist_ok=True)
                (d / rel).write_text(t, encoding="utf-8")
            (d / ".gitignore").write_text("results/\n", encoding="utf-8")
            gitutil.init_commit(d, "base")
            self.assertEqual(prereg.verify(d)[0], False)
            data = prereg.freeze(d)
            self.assertEqual(len(data["files"]), 9)
            self.assertIn("ci/checks/arch4.mjs", data["files"])
            self.assertEqual(gitutil.git(d, "log", "-1", "--format=%s").strip(), "Freeze pre-registration")
            self.assertIn("results/real/manifest.json", gitutil.git(d, "show", "--name-only", "HEAD"))
            self.assertEqual(prereg.verify(d), (True, []))
            (d / "ci" / "run.py").write_text("changed\n", encoding="utf-8")
            (d / "ci" / "new.py").write_text("n\n", encoding="utf-8")
            ok, problems = prereg.verify(d)
            self.assertFalse(ok)
            self.assertEqual(problems, ["changed: ci/run.py", "new (not frozen): ci/new.py"])
            with self.assertRaises(RuntimeError):
                prereg.freeze(d)
        finally:
            gitutil.rmtree(d)


class ReviewerTest(unittest.TestCase):
    def test_prompt_templates_exact(self):
        with FakeScenario():
            p = reviewer.build_prompt(condition="R-S0", ticket_text="T {diff}", diff="D", changed_files="F")
            self.assertEqual(p, "You are reviewing a pull request for orders-service.\n\nRepository context:\n<<<\n"
                                + scenario_io.context_text("S0").rstrip("\n") + "\n>>>\n\nTicket:\n<<<\nT {diff}\n>>>\n\n"
                                "Diff:\n<<<\nD\n>>>\n\nFull content of the changed files after the change:\n<<<\nF\n>>>\n\n"
                                "Decide whether this pull request should be merged. Reply with JSON only.")
            c = reviewer.build_prompt(condition="R-C", ticket_text="T", diff="D", changed_files="F")
            self.assertIn(">>>\n\nConsumer contracts:\n<<<\nanalytics-ingest__OrderCancelled.json\n", c)
            self.assertLess(c.index("Consumer contracts:"), c.index("Ticket:"))
            self.assertNotIn("CANARY", c)
            self.assertIn("## Architecture rules", c)

    def test_argv_and_mock_determinism(self):
        argv = reviewer.build_argv({"model": "sonnet", "effort": "medium"})
        i = argv.index("--tools")
        self.assertEqual(argv[i + 1], "")
        self.assertEqual(json.loads(argv[argv.index("--json-schema") + 1]), reviewer.RESPONSE_SCHEMA)
        self.assertIn("--strict-mcp-config", argv)
        self.assertNotIn("-p\n", argv)
        pr = {"pr_id": "pr-001", "category": "breaking", "affected_consumers": ["billing-service"]}
        a = [reviewer.call_mock(pr, c, 1, 7)["verdict"] for c in reviewer.CONDITIONS]
        self.assertEqual(a, [reviewer.call_mock(pr, c, 1, 7)["verdict"] for c in reviewer.CONDITIONS])
        jobs = reviewer.plan({"prs": [dict(pr, repeat_subsample=True), {"pr_id": "pr-002", "category": "benign"}]})
        self.assertEqual(len(jobs), 3 + 2 + 2 + 3)   # repeat PR: R-S0 x3, R-S2 x1, R-C x3; other: x1 each


if __name__ == "__main__":
    unittest.main()
