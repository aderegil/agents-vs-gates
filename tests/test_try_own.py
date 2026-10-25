"""harness.try_rules with your own repo, rules and tickets (harness/try_own.py): refusals, ticket files, the user's
pipeline, and one full mock run on examples/try-own-repo (needs node on PATH; no model calls)."""
from __future__ import annotations

import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace

from harness import paths, try_own, try_rules

EX = paths.REPO / "examples" / "try-own-repo"
HAVE_NODE = shutil.which("node") is not None and shutil.which("npm") is not None


def args(**kw):
    base = dict(repo=None, ci=None, their_tests=None, their_cmd=None, accept_cmd=None, setup_cmd=None)
    return SimpleNamespace(**{**base, **kw})


class Refusals(unittest.TestCase):
    def test_repo_must_not_be_the_experiments_data_or_inputs(self):
        for bad in (paths.SCENARIO, paths.SCENARIO / "repos" / "orders-service", paths.REPO / "oracle", paths.REPO):
            with self.subTest(bad=bad), self.assertRaises(try_own.OwnRefused):
                try_own.make_project(args(repo=str(bad)))

    def test_their_tests_must_be_outside_the_repo(self):
        with self.assertRaises(try_own.OwnRefused) as cm:
            try_own.make_project(args(repo=str(EX / "my-service"), their_tests=str(EX / "my-service" / "test"),
                                      their_cmd="node --test"))
        self.assertIn("outside --repo", str(cm.exception))

    def test_their_tests_and_cmd_go_together(self):
        with self.assertRaises(try_own.OwnRefused):
            try_own.make_project(args(repo=str(EX / "my-service"), their_tests=str(EX / "other-teams")))

    def test_own_flags_need_a_repo(self):
        err = io.StringIO()
        with redirect_stderr(err), redirect_stdout(io.StringIO()):
            code = try_rules.main(["--context", str(EX / "my-rules.md"), "--unit", "mock", "--ci", "npm test"])
        self.assertEqual(code, try_rules.EXIT_GUARD)
        self.assertIn("need --repo", err.getvalue())

    def test_with_a_repo_tickets_are_files(self):
        with self.assertRaises(try_rules.Refused):
            try_rules.parse_tickets("X-rename", own_repo=True)


class Tickets(unittest.TestCase):
    def test_ticket_files_become_ids_and_texts(self):
        ids, own = try_rules.parse_tickets(f"{EX / 'tickets' / 'rename-total.md'},X-remove")
        self.assertEqual(ids, ["rename-total", "X-remove"])
        self.assertIn("amountCents", own["rename-total"].text)

    def test_empty_ticket_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "empty.md"
            p.write_text("  \n", encoding="utf-8")
            with self.assertRaises(try_rules.Refused):
                try_rules.parse_tickets(str(p))


@unittest.skipUnless(HAVE_NODE, "needs node and npm")
class Pipeline(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-own-"))
        self.svc = self.tmp / "svc"
        shutil.copytree(EX / "my-service", self.svc)
        self.p = try_own.OwnPipeline(try_own.make_project(args(
            repo=str(EX / "my-service"), ci="npm run ci", their_tests=str(EX / "other-teams"), their_cmd="node --test",
            accept_cmd=f'node "{EX / "accept.mjs"}"')))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_green_repo_passes_every_gate(self):
        self.assertTrue(self.p.run_ci(self.svc, "V0", "t")["ok"])
        o = self.p.run_oracle(self.svc)
        self.assertEqual(sorted(o["consumers"]), ["invoicing", "reporting"])
        self.assertTrue(o["ok"])

    def test_a_rename_fails_ci_and_breaks_invoicing_only(self):
        f = self.svc / "src" / "order-event.js"
        f.write_text(f.read_text(encoding="utf-8").replace("    total:", "    amountCents:"), encoding="utf-8")
        ci = self.p.run_ci(self.svc, "V0", "t")
        self.assertFalse(ci["ok"])
        self.assertIn("CONTRACT FAIL: invoicing needs total", ci["feedback_text"])
        self.assertEqual(ci["checks"][0]["id"], try_own.CHECK_ID)
        o = self.p.run_oracle(self.svc)
        self.assertFalse(o["consumers"]["invoicing"]["ok"])
        self.assertTrue(o["consumers"]["reporting"]["ok"])
        self.assertEqual(self.p.check_ticket(self.svc, "rename-total")["ticket_done"], "done")

    def test_no_accept_cmd_means_not_evaluated(self):
        p = try_own.OwnPipeline(try_own.make_project(args(repo=str(EX / "my-service"))))
        self.assertIsNone(p.check_ticket(self.svc, "rename-total")["ticket_done"])
        self.assertTrue(p.run_ci(self.svc, "V0", "t")["ok"])          # no --ci: nothing gates


@unittest.skipUnless(HAVE_NODE, "needs node and npm")
class MockEndToEnd(unittest.TestCase):
    def test_example_repo_with_the_mock_agent(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = try_rules.main([
                "--context", str(EX / "my-rules.md"), "--unit", "mock", "--repo", str(EX / "my-service"),
                "--ci", "npm run ci", "--their-tests", str(EX / "other-teams"), "--their-cmd", "node --test",
                "--accept-cmd", f'node "{EX / "accept.mjs"}"', "--mock-script", str(EX / "mock" / "mock.json"),
                "--tickets", f"{EX / 'tickets' / 'rename-total.md'},{EX / 'tickets' / 'add-currency.md'}",
                "--n", "1", "--quiet"])
        self.assertEqual(code, try_rules.EXIT_OK, out.getvalue())
        text = out.getvalue()
        v = json.loads(Path(text.rsplit("Verdict: ", 1)[1].strip()).read_text(encoding="utf-8"))
        rt, ac = v["tickets"]["rename-total"], v["tickets"]["add-currency"]
        self.assertEqual((rt["broke_first"], rt["ci_caught"], rt["broke_final"], rt["ci_green_final"]), (1, 1, 0, 1))
        self.assertEqual(rt["teams_first"], {"invoicing": 1})
        self.assertEqual(rt["outcomes"], {"fixed_code": 1})
        self.assertEqual((ac["broke_first"], ac["outcomes"]), (0, {"passed_first_ci": 1}))
        self.assertEqual(rt["ticket"], {"done": 1})
        self.assertIn("Not comparable with the experiment", text)
        # the agent's workspace never held the other teams' tests
        run = paths.run_dir(paths.TRY_NS, rt["run_ids"][0])
        self.assertNotIn("invoicing.test", (run / "transcript.jsonl").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
