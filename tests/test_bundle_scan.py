"""Codex audit 2026-10-11: workspace.bundle keeps the raw git history, so it is scanned for tokens, user paths and
canaries and the record is flagged (the sanitizer only rewrites transcript, diffs, record and trace)."""
import unittest

from harness import cycle, gitutil, jsonio, paths, record, sanitize
from tests._fake_scenario import CAN_BROKER, FakePipeline, FakeScenario
from tests.test_cycle import S_BREAK_FIX, entry

WIN_PATH = "C:" + chr(92) + "Users" + chr(92) + "someone" + chr(92) + "proj"
PUBLIC_PATH = "C:" + chr(92) + "Users" + chr(92) + "Public" + chr(92) + "x"
FAKE_TOKEN = "sk-ant-api03-" + "x" * 24      # shape only; never a real credential


class SideCommitPipeline(FakePipeline):
    """On the first CI call, leaves a commit on a side branch of the workspace repo (what an agent that runs
    `git commit` itself would do). It is in no CI ref, so no diff and no transcript line shows it."""

    def __init__(self, message, body):
        super().__init__()
        self.message, self.body, self.done = message, body, False

    def run_ci(self, ws_root, V, run_id):
        if not self.done:
            self.done = True
            cur = gitutil.git(ws_root, "rev-parse", "--abbrev-ref", "HEAD").strip()
            gitutil.git(ws_root, "checkout", "-q", "-b", "agent-side")
            (ws_root / "notes.txt").write_text(self.body, encoding="utf-8", newline="\n")
            gitutil.git(ws_root, "add", "-A")
            gitutil.git(ws_root, "commit", "-q", "--no-verify", "-m", self.message)
            gitutil.git(ws_root, "checkout", "-q", cur)
        return super().run_ci(ws_root, V, run_id)


class BundleScanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = FakeScenario().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.fake.__exit__(None, None, None)

    def run_one(self, rid, pipeline):
        return cycle.execute_run(entry(rid), ns="mock", worker_ns="selftest", worker=1, pipeline=pipeline,
                                 mock_script=S_BREAK_FIX, seed=7)

    def test_clean_run_is_not_flagged(self):
        rec = self.run_one("st-b0", self.fake.pipeline)
        self.assertEqual(rec["bundle_scan"], {"token": False, "user_paths": 0, "canary": 0})
        self.assertFalse(rec["token_exposed"])
        self.assertFalse(rec["contamination"]["flag"])
        self.assertEqual(record.validate(jsonio.read_json(paths.run_dir("mock", "st-b0") / "record.json")), [])

    def test_token_in_side_commit_flags_token_exposed(self):
        rec = self.run_one("st-b1", SideCommitPipeline("wip " + FAKE_TOKEN, "scratch\n"))
        self.assertTrue(rec["bundle_scan"]["token"])
        self.assertTrue(rec["token_exposed"])
        self.assertNotIn(FAKE_TOKEN, (paths.run_dir("mock", "st-b1") / "record.json").read_text(encoding="utf-8"))
        self.assertTrue((paths.run_dir("mock", "st-b1") / "workspace.bundle").exists())

    def test_canary_and_user_path_in_side_commit(self):
        body = "\n".join([CAN_BROKER, WIN_PATH, "/api/users/42", ""])
        rec = self.run_one("st-b2", SideCommitPipeline("notes", body))
        self.assertEqual(rec["bundle_scan"], {"token": False, "user_paths": 1, "canary": 1})
        self.assertFalse(rec["token_exposed"])
        self.assertTrue(rec["contamination"]["flag"])
        hit = rec["contamination"]["hits"][0]
        self.assertEqual((hit["canary"], hit["origin"], hit["where"]), (CAN_BROKER, "broker", "workspace.bundle"))
        self.assertEqual(record.validate(jsonio.read_json(paths.run_dir("mock", "st-b2") / "record.json")), [])

    def test_scan_unit(self):
        s = sanitize.scan(f"{FAKE_TOKEN} /Users/bob/a /c/Users/al/b " + PUBLIC_PATH + " /api/users/1")
        self.assertTrue(s["token"])
        self.assertEqual(s["user_paths"], 2)
        self.assertEqual(sanitize.scan("")["canary_hits"], [])


if __name__ == "__main__":
    unittest.main()
