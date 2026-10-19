"""Smoke test: dry run lists 5 calls, live mode refuses without authorization, evaluation from fixtures."""
import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness import smoke
from harness.adapters import claude_code as cc

FIX = Path(__file__).parent / "fixtures"


class Smoke(unittest.TestCase):
    def test_dry_run_prints_five_calls_no_token(self):
        buf = io.StringIO()
        with mock.patch.object(cc.authenv, "oauth_token", return_value="sk-" + "ant-oat01-SECRET"), \
                mock.patch.object(smoke.proc, "run_streaming", side_effect=AssertionError("no live call")), \
                contextlib.redirect_stdout(buf):
            rc = smoke.main(["--dry-run"])
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertEqual(out.count("argv:  "), 5)
        self.assertNotIn("SECRET", out)
        self.assertIn('"--max-turns", "2"', out)
        self.assertIn("<session_id of call 3>", out)
        self.assertIn("--strict-mcp-config", out)
        self.assertIn('"sonnet"', out)

    def test_live_refused_without_flag(self):
        err = io.StringIO()
        with mock.patch.object(smoke.proc, "run_streaming", side_effect=AssertionError("no live call")), \
                contextlib.redirect_stderr(err):
            self.assertEqual(smoke.main([]), 2)
        self.assertIn("authorization", err.getvalue())

    def test_evaluate_from_fixtures(self):
        ws = Path(tempfile.mkdtemp())
        p = cc.parse_stream((FIX / "claude_stream_success.jsonl").read_text(encoding="utf-8").splitlines(), "s1",
                            r"C:\avg\wst\r")
        checks = smoke.evaluate(1, p, {"rc": 0}, r"C:\avg\wst\r")
        self.assertTrue(all(c["ok"] for c in checks), checks)
        p2 = cc.parse_stream((FIX / "claude_stream_max_turns.jsonl").read_text(encoding="utf-8").splitlines(), "s2")
        self.assertTrue(smoke.evaluate(2, p2, {"rc": 0}, ws)[0]["ok"])
        p3 = cc.parse_stream((FIX / "claude_stream_mcp_breach.jsonl").read_text(encoding="utf-8").splitlines(), "s1",
                             r"C:\avg\wst\r")
        self.assertFalse(all(c["ok"] for c in smoke.evaluate(1, p3, {"rc": 0}, r"C:\avg\wst\r")))
        md = smoke.markdown({"ok": True, "at": "x", "checks": checks, "token_in_env": "no"})
        self.assertIn("| 1 |", md)


if __name__ == "__main__":
    unittest.main()
