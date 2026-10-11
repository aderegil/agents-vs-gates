"""Codex adapter, dry (spec 10.9): argv, CODEX_HOME, JSONL parsing. Never runs `codex`."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from harness.adapters import codex, gemini
from harness.adapters.base import Limits

FIX = Path(__file__).parent / "fixtures" / "codex_exec.jsonl"


class CodexArgv(unittest.TestCase):
    def test_exec_argv_exact(self):
        self.assertEqual(codex.build_argv({"model": "gpt-x"}, r"C:\avg\w1\r"),
                         ["exec", "--json", "-m", "gpt-x", "--sandbox", "workspace-write", "--ignore-user-config",
                          "--ignore-rules", "-C", r"C:\avg\w1\r", "-"])

    def test_resume_argv_exact(self):
        argv = codex.build_argv({"model": "gpt-x"}, r"C:\avg\w1\r", resume="th-1")
        self.assertEqual(argv, ["exec", "resume", "th-1", "--json", "-c", 'sandbox_mode="workspace-write"',
                                "--ignore-user-config", "--ignore-rules", "-"])
        self.assertNotIn("--sandbox", argv)
        self.assertNotIn("-C", argv)
        self.assertNotIn("--ephemeral", argv)

    def test_native_entry_js_uses_node(self):
        with mock.patch("harness.doctor.codex_native_entry", return_value=r"C:\x\codex.js"):
            argv = codex.entry_argv()
        self.assertEqual(argv[-1], r"C:\x\codex.js")
        self.assertIn("node", Path(argv[0]).name.lower())
        with mock.patch("harness.doctor.codex_native_entry", return_value=r"C:\x\bin\codex.exe"):
            self.assertEqual(codex.entry_argv(), [r"C:\x\bin\codex.exe"])

    def test_codex_home_only_auth(self):
        tmp = Path(tempfile.mkdtemp())
        src = tmp / "auth.json"
        src.write_text('{"k": "v"}', encoding="utf-8")
        home = tmp / "home"
        (home / "old").mkdir(parents=True)
        codex.prepare_home(home, src)
        self.assertEqual(sorted(p.name for p in home.iterdir()), ["auth.json"])
        env = codex.build_env(home)
        self.assertEqual(env["CODEX_HOME"], str(home))


class CodexParse(unittest.TestCase):
    def test_fixture(self):
        p = codex.parse_jsonl(FIX.read_text(encoding="utf-8").splitlines(), "gen")
        self.assertEqual(p.thread_id, "0199a213-81c0-7800-8aa1-bbab2a035a53")
        kinds = [(e["kind"], e.get("name") or e.get("status") or "") for e in p.events]
        self.assertEqual(kinds, [("text", ""), ("tool_call", "Bash"), ("tool_result", "success"), ("tool_call", "Edit"),
                                 ("tool_result", "success"), ("tool_call", "Bash"), ("tool_result", "error"), ("text", "")])
        self.assertTrue(p.events[0]["reasoning"])
        self.assertEqual(p.usage, {"input_tokens": 24763, "output_tokens": 122, "cache_read_input_tokens": 24448,
                                   "cache_creation_input_tokens": 0})
        self.assertEqual(p.messages, ["Renamed totalCents to amountCents."])
        self.assertIsNone(codex.classify(p, 0, "", False)["infra"])

    def test_failure_classification(self):
        p = codex.parse_jsonl([json.dumps({"type": "turn.failed", "error": {"message": "429 rate limit exceeded"}})], "gen")
        self.assertEqual(codex.classify(p, 1, "", False)["infra"]["kind"], "rate_limited")
        p = codex.parse_jsonl([json.dumps({"type": "error", "message": "stream disconnected"})], "gen")
        self.assertEqual(codex.classify(p, 1, "", False)["infra"]["kind"], "api_error")
        p = codex.parse_jsonl([], "gen")
        self.assertEqual(codex.classify(p, 2, "boom", False)["infra"]["kind"], "cli_crash")
        self.assertTrue(codex.classify(p, None, "", True)["capped"])
        p = codex.parse_jsonl([json.dumps({"type": "item.started", "item": {"id": "i", "type": "mcp_tool_call",
                                                                            "server": "s", "tool": "t"}})], "gen")
        self.assertEqual(codex.classify(p, 0, "", False)["infra"]["kind"], "isolation_breach")

    def test_prices_empty_means_no_cost(self):
        self.assertIsNone(codex.price_cost("gpt-x", {"input_tokens": 10}))
        prices = {"models": {"gpt-x": {"input_per_mtok": 1.0, "cached_input_per_mtok": 0.1, "output_per_mtok": 10.0}}}
        self.assertAlmostEqual(codex.price_cost("gpt-x", {"input_tokens": 1_000_000, "output_tokens": 100_000,
                                                          "cache_read_input_tokens": 0}, prices), 2.0)

    def test_run_session_faked(self):
        def fake(argv, *, cwd, env, stdin_text, wall_clock_s, on_line):
            self.argv, self.stdin = argv, stdin_text
            for l in FIX.read_text(encoding="utf-8").splitlines():
                on_line(l, "2026-10-11T09:00:00.000Z")
            return {"rc": 0, "stderr": "", "timed_out": False, "killed": False, "duration_ms": 5}

        ws = SimpleNamespace(root=r"C:\avg\w1\r", cfg=Path(tempfile.mkdtemp()) / "cx")
        before = codex.CALLS
        with mock.patch.object(codex.proc, "run_streaming", fake), mock.patch.object(codex, "entry_argv", return_value=["codex.exe"]), \
                mock.patch.object(codex, "cli_version", return_value="0.154"), mock.patch.object(codex, "prepare_home"):
            res = codex.run_session(ws, "TICKET", unit={"model": "gpt-x"}, limits=Limits.for_session("gen"))
        self.assertEqual(codex.CALLS, before + 1)
        self.assertEqual(self.stdin, "TICKET")
        self.assertEqual(self.argv[-1], "-")
        self.assertEqual(res.session_id, "0199a213-81c0-7800-8aa1-bbab2a035a53")
        self.assertEqual(res.events[-1]["kind"], "final")
        self.assertEqual(res.final_text, "Renamed totalCents to amountCents.")
        self.assertEqual(res.turn_cap, "wall-clock-only")


class GeminiStub(unittest.TestCase):
    def test_stub(self):
        with self.assertRaisesRegex(NotImplementedError, "stub"):
            gemini.run_session(None, "x", unit={}, limits=None)


if __name__ == "__main__":
    unittest.main()
