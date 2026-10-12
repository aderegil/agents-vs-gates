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


OFF = [a for f in codex.FEATURES_OFF for a in ("-c", f"features.{f}=false")]
POLICY = ["-c", 'approval_policy="never"', "-c", 'web_search="disabled"'] + OFF


class CodexArgv(unittest.TestCase):
    UNIT = {"model": "gpt-x", "effort": "medium", "windows_sandbox": "mxc"}

    def test_parity_features_off(self):
        for f in ("code_mode_host", "unified_exec_tty", "apps", "plugins", "remote_plugin", "browser_use",
                  "computer_use", "image_generation", "multi_agent", "skill_search", "tool_suggest", "hooks", "goals"):
            self.assertIn(f"features.{f}=false", codex.build_argv(self.UNIT, "W"))
            self.assertIn(f"features.{f}=false", codex.build_argv(self.UNIT, "W", resume="th"))
        self.assertIn('web_search="disabled"', codex.build_argv(self.UNIT, "W"))

    def test_exec_argv_exact(self):
        self.assertEqual(codex.build_argv(self.UNIT, r"C:\avg\w1\r"),
                         ["exec", "--json", "-m", "gpt-x"] + POLICY +
                         ["-c", 'model_reasoning_effort="medium"', "-c", 'windows.sandbox="mxc"',
                          "--sandbox", "workspace-write", "--ignore-user-config", "-C", r"C:\avg\w1\r", "-"])
        # without effort/backend in the unit only the approval policy is added
        self.assertEqual(codex.build_argv({"model": "gpt-x"}, "W")[:6],
                         ["exec", "--json", "-m", "gpt-x", "-c", 'approval_policy="never"'])
        self.assertNotIn("--ignore-rules", codex.build_argv(self.UNIT, "W"))

    def test_resume_argv_exact(self):
        argv = codex.build_argv(self.UNIT, r"C:\avg\w1\r", resume="th-1")
        self.assertEqual(argv, ["exec", "resume", "th-1", "--json", "-c", 'sandbox_mode="workspace-write"',
                                "-c", 'model="gpt-x"'] + POLICY +
                         ["-c", 'model_reasoning_effort="medium"', "-c", 'windows.sandbox="mxc"',
                          "--ignore-user-config", "-"])
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

    def test_codex_home_wipe_is_verified(self):
        tmp = Path(tempfile.mkdtemp())
        home = tmp / "home"
        home.mkdir()
        (home / "memories_1.sqlite").write_text("x", encoding="utf-8")
        with mock.patch.object(codex.shutil, "rmtree"):          # a wipe that silently fails
            with self.assertRaisesRegex(RuntimeError, "could not be wiped.*memories_1.sqlite"):
                codex.prepare_home(home, tmp / "missing-auth.json")

    def test_codex_home_only_auth(self):
        tmp = Path(tempfile.mkdtemp())
        src = tmp / "auth.json"
        src.write_text('{"k": "v"}', encoding="utf-8")
        home = tmp / "home"
        (home / "old").mkdir(parents=True)
        codex.prepare_home(home, src)
        self.assertEqual(sorted(p.name for p in home.iterdir()), ["auth.json", "rules"])
        self.assertEqual([p.name for p in (home / "rules").iterdir()], ["agents-vs-gates.rules"])
        rules = (home / "rules" / "agents-vs-gates.rules").read_text(encoding="utf-8")
        for denied in ('["node"]', '"curl"', '["find"]', '"rm"', '"commit"'):
            self.assertIn(denied, rules)
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

    def test_turn_cap_counts_tool_calls(self):
        def cmd(i):
            return json.dumps({"type": "item.started", "item": {"id": f"c{i}", "type": "command_execution",
                                                                "command": "bash -lc 'ls'", "status": "in_progress"}})
        p = codex.JsonlParser("gen", max_turns=3)
        p.feed(cmd(1))
        p.feed(cmd(2))
        self.assertFalse(p.capped)
        p.feed(cmd(3))                        # the 3rd tool call = the 3rd turn: cut here, like --max-turns 3
        self.assertTrue(p.capped)
        c = codex.classify(p, None, "", False)
        self.assertEqual((c["subtype"], c["capped"], c["turn_cap"], c["infra"]), ("error_max_turns", True, "max-turns", None))
        # a wall-clock end is still capped, with its own turn_cap
        q = codex.JsonlParser("gen", max_turns=30)
        q.feed(cmd(1))
        self.assertEqual(codex.classify(q, None, "", True)["turn_cap"], "wall-clock-only")

    def test_sandbox_refusal_is_an_isolation_failure(self):
        msg = ('CreateProcess { message: "UnsupportedOperation(\\"windows unelevated restricted-token sandbox cannot '
               'enforce split writable root sets directly; refusing to run unsandboxed\\")" }')
        p = codex.parse_jsonl([json.dumps({"type": "item.completed", "item": {
            "id": "c1", "type": "command_execution", "command": "cat x", "aggregated_output": msg, "exit_code": -1,
            "status": "failed"}})], "gen")
        c = codex.classify(p, 0, "", False)
        self.assertEqual(c["infra"]["kind"], "isolation_breach")
        self.assertIn("sandbox unavailable", c["infra"]["detail"])
        # an ordinary failing command is not
        p = codex.parse_jsonl([json.dumps({"type": "item.completed", "item": {
            "id": "c1", "type": "command_execution", "command": "npm test", "aggregated_output": "# fail 1",
            "exit_code": 1, "status": "failed"}})], "gen")
        self.assertIsNone(codex.classify(p, 0, "", False)["infra"])

    def test_usage_limits_are_rate_limited_with_reset(self):
        from datetime import datetime
        now = datetime(2026, 10, 11, 12, 0).astimezone()
        for text in ("You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.",
                     "usage_limit_reached", "Rate limit reached for gpt-x. Please try again in 20s.",
                     "429 Too Many Requests", "insufficient_quota"):
            p = codex.parse_jsonl([json.dumps({"type": "turn.failed", "error": {"message": text}})], "gen")
            self.assertEqual(codex.classify(p, 1, "", False)["infra"]["kind"], "rate_limited", text)
        self.assertEqual(codex.parse_reset_codex("try again in 2 hours 5 minutes.", now)[:16], "2026-10-11T14:05")
        self.assertEqual(codex.parse_reset_codex("try again in 3 days 1 hour", now)[:16], "2026-10-14T13:00")
        self.assertEqual(codex.parse_reset_codex("usage limit; try again at 3:05 PM.", now)[:16], "2026-10-11T15:05")

    def test_transient_reconnect_errors_are_not_failures(self):
        lines = [json.dumps({"type": "error", "message": "Reconnecting... 1/5"})] + \
            FIX.read_text(encoding="utf-8").splitlines()
        p = codex.parse_jsonl(lines, "gen")
        self.assertEqual(p.notices, ["Reconnecting... 1/5"])
        self.assertIsNone(codex.classify(p, 0, "", False)["infra"])

    def test_model_reported_from_stream(self):
        p = codex.parse_jsonl([json.dumps({"type": "thread.started", "thread_id": "t", "model": "gpt-5.6-terra"})], "gen")
        self.assertEqual(p.model, "gpt-5.6-terra")
        self.assertIsNone(codex.parse_jsonl(FIX.read_text(encoding="utf-8").splitlines(), "gen").model)

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
        self.assertEqual(res.turn_cap, "max-turns")


class GeminiStub(unittest.TestCase):
    def test_stub(self):
        with self.assertRaisesRegex(NotImplementedError, "stub"):
            gemini.run_session(None, "x", unit={}, limits=None)


if __name__ == "__main__":
    unittest.main()
