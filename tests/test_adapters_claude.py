"""Claude Code adapter: argv, env, stream parsing, init checks, closure classification. Never runs `claude`."""
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from harness.adapters import claude_code as cc
from harness.adapters.base import Limits

FIX = Path(__file__).parent / "fixtures"
WS = r"C:\avg\wst\r"
UNIT = {"name": "cc-sonnet", "adapter": "claude_code", "model": "sonnet", "effort": "medium"}


def lines(name):
    return (FIX / name).read_text(encoding="utf-8").splitlines()


class ArgvEnv(unittest.TestCase):
    def test_gen_argv_exact(self):
        argv = cc.build_argv(UNIT, Limits.for_session("gen"))
        self.assertEqual(argv[:5], ["-p", "--model", "sonnet", "--effort", "medium"])
        self.assertEqual(argv[argv.index("--tools") + 1], "Read,Edit,Write,Glob,Grep,Bash")
        i = argv.index("--allowedTools")
        self.assertEqual(argv[i + 1:i + 9], ["Bash(npm run *)", "Bash(npm test)", "Bash(npm test *)", "Bash(npx tsc)",
                                             "Bash(npx tsc *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)"])
        j = argv.index("--disallowedTools")
        self.assertEqual(argv[j + 1:j + 4], ["WebFetch", "WebSearch", "Agent"])
        for flag in ("--strict-mcp-config", "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections",
                     "--include-hook-events", "--verbose"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--permission-prompts") + 1], "none")
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "acceptEdits")
        self.assertEqual(argv[argv.index("--output-format") + 1], "stream-json")
        self.assertEqual(argv[argv.index("--max-turns") + 1], "30")
        self.assertNotIn("--resume", argv)
        self.assertNotIn("--bare", argv)
        self.assertNotIn("Bash(npx tsc*)", argv)

    def test_fix_argv_resume_and_turns(self):
        argv = cc.build_argv(dict(UNIT, max_budget_usd=2), Limits.for_session("fix1"), resume="abc")
        self.assertEqual(argv[argv.index("--max-turns") + 1], "15")
        self.assertEqual(argv[argv.index("--resume") + 1], "abc")
        self.assertEqual(argv[argv.index("--max-budget-usd") + 1], "2")

    def test_env_clean_and_isolated(self):
        dirty = {"CLAUDE_CODE_ENTRYPOINT": "x", "CLAUDECODE": "1", "ANTHROPIC_API_KEY": "k", "PATH": "p"}
        with mock.patch.dict("os.environ", dirty, clear=True), \
                mock.patch.object(cc.authenv, "oauth_token", return_value="tok-123"):
            env = cc.build_env(r"C:\avg\cfg\wst")
        self.assertNotIn("CLAUDECODE", env)
        self.assertNotIn("ANTHROPIC_API_KEY", env)
        self.assertNotIn("CLAUDE_CODE_ENTRYPOINT", env)
        self.assertEqual(env["CLAUDE_CODE_OAUTH_TOKEN"], "tok-123")
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], r"C:\avg\cfg\wst")
        self.assertEqual(env["ENABLE_CLAUDEAI_MCP_SERVERS"], "false")
        self.assertEqual(env["PATH"], "p")


class Parser(unittest.TestCase):
    def test_success_stream(self):
        p = cc.parse_stream(lines("claude_stream_success.jsonl"), "gen", WS)
        self.assertIsNone(p.breach)
        self.assertEqual(p.session_id, "0f1e2d3c-aaaa-bbbb-cccc-000000000001")
        kinds = [e["kind"] for e in p.events]
        self.assertEqual(kinds, ["text", "tool_call", "tool_result", "tool_call", "tool_result", "tool_call",
                                 "tool_result", "text"])
        self.assertTrue(all(e["session"] == "gen" and e["ts"] for e in p.events))
        call = p.events[1]
        self.assertEqual((call["id"], call["name"]), ("toolu_01", "Read"))
        self.assertIn("file_path", call["input"])
        statuses = [e["status"] for e in p.events if e["kind"] == "tool_result"]
        self.assertEqual(statuses, ["success", "denied", "error"])  # denial known only from result.permission_denials
        self.assertIn("# fail 1", p.events[6]["output"])
        self.assertEqual(p.usage()["output_tokens"], 95)
        c = cc.classify(p.result)
        self.assertEqual((c["subtype"], c["capped"], c["infra"]), ("success", False, None))

    def test_timestamps_kept(self):
        p = cc.parse_stream([(l, f"2026-10-11T09:00:0{i}.000Z") for i, l in enumerate(lines("claude_stream_success.jsonl"))],
                            "gen", WS)
        self.assertEqual(p.events[0]["ts"], "2026-10-11T09:00:01.000Z")

    def test_max_turns_is_capped_not_infra(self):
        p = cc.parse_stream(lines("claude_stream_max_turns.jsonl"), "fix1", WS)
        c = cc.classify(p.result)
        self.assertTrue(c["capped"])
        self.assertEqual(c["turn_cap"], "max-turns")
        self.assertIsNone(c["infra"])

    def test_wall_clock_is_capped(self):
        c = cc.classify(None, "", timed_out=True)
        self.assertEqual((c["capped"], c["turn_cap"], c["infra"]), (True, "wall-clock-only", None))

    def test_rate_limit_with_reset(self):
        p = cc.parse_stream(lines("claude_stream_rate_limit.jsonl"), "gen", WS)
        c = cc.classify(p.result)
        self.assertEqual(c["infra"]["kind"], "rate_limited")
        self.assertEqual(c["infra"]["reset_at"], "2025-10-11T18:00:00Z")

    def test_reset_clock_text(self):
        now = datetime(2026, 10, 11, 13, 0, tzinfo=timezone.utc)
        self.assertEqual(cc.parse_reset("5-hour limit reached ∙ resets 3pm", now), "2026-10-11T15:00:00+00:00")
        self.assertEqual(cc.parse_reset("resets at 9:30 am", now), "2026-10-12T09:30:00+00:00")
        self.assertIsNone(cc.parse_reset("no time here", now))

    def test_429_in_stderr_without_result(self):
        c = cc.classify(None, "Error: 429 Too Many Requests", rc=1)
        self.assertEqual(c["infra"]["kind"], "rate_limited")

    def test_api_error(self):
        p = cc.parse_stream(lines("claude_stream_api_error.jsonl"), "gen", WS)
        self.assertEqual(cc.classify(p.result)["infra"]["kind"], "api_error")

    def test_cli_crash(self):
        c = cc.classify(None, "segfault", rc=3)
        self.assertEqual(c["infra"]["kind"], "cli_crash")

    def test_mcp_breach(self):
        p = cc.parse_stream(lines("claude_stream_mcp_breach.jsonl"), "gen", WS)
        self.assertIn("mcp_servers", p.breach)
        self.assertIn("unexpected tools", p.breach)

    def test_hook_breach(self):
        p = cc.parse_stream(lines("claude_stream_hook.jsonl"), "gen", WS)
        self.assertTrue(p.breach.startswith("hook event"))

    def test_init_checks(self):
        ok = {"tools": sorted(cc.EXPECTED_TOOLS), "mcp_servers": [], "plugins": [], "permissionMode": "acceptEdits", "cwd": WS}
        self.assertIsNone(cc.check_init(ok, WS))
        self.assertIn("permissionMode", cc.check_init(dict(ok, permissionMode="bypassPermissions"), WS))
        self.assertIn("cwd", cc.check_init(dict(ok, cwd=r"C:\avg"), WS))
        self.assertIn("plugins", cc.check_init(dict(ok, plugins=[{"name": "x"}]), WS))


class RunSession(unittest.TestCase):
    """run_session with the process layer faked: feeds fixture lines through on_line."""

    def _run(self, fixture, timed_out=False):
        def fake(argv, *, cwd, env, stdin_text, wall_clock_s, on_line):
            self.seen = {"argv": argv, "stdin": stdin_text, "cwd": cwd, "env": env}
            killed = False
            for i, l in enumerate(lines(fixture)):
                if on_line(l, f"2026-10-11T09:00:{i:02d}.000Z") == "kill":
                    killed = True
                    break
            return {"rc": 0 if not killed else 1, "stderr": "", "timed_out": timed_out, "killed": killed, "duration_ms": 1234}

        tmp = tempfile.mkdtemp()
        ws = SimpleNamespace(root=WS, cfg=Path(tmp) / "cfg")
        events = []
        before = cc.CALLS
        with mock.patch.object(cc.proc, "run_streaming", fake), mock.patch.object(cc, "cli_version", return_value="2.1.296"), \
                mock.patch.object(cc, "claude_exe", return_value="claude.exe"), \
                mock.patch.object(cc.authenv, "oauth_token", return_value=None):
            res = cc.run_session(ws, "PROMPT", unit=UNIT, limits=Limits.for_session("gen"), on_event=events.append)
        self.assertEqual(cc.CALLS, before + 1)
        return res, events

    def test_success(self):
        res, events = self._run("claude_stream_success.jsonl")
        self.assertEqual(self.seen["stdin"], "PROMPT")
        self.assertNotIn("PROMPT", self.seen["argv"])
        self.assertEqual(self.seen["argv"][0], "claude.exe")
        self.assertIsNone(res.infra)
        self.assertEqual(res.model_reported, "claude-sonnet-4-5-20250929")
        self.assertEqual(res.num_turns, 4)
        self.assertEqual(res.final_text, "Renamed the fields in OrderPlaced.")
        self.assertEqual(events[-1]["kind"], "final")
        self.assertEqual(events[-1]["usage"]["input_tokens"], 1270)
        self.assertEqual(res.record_entry()["usage"]["cache_read_input_tokens"], 18900)
        self.assertEqual(res.isolation["permissionMode"], "acceptEdits")

    def test_breach_kills(self):
        res, _ = self._run("claude_stream_mcp_breach.jsonl")
        self.assertEqual(res.infra["kind"], "isolation_breach")

    def test_capped_by_max_turns(self):
        res, _ = self._run("claude_stream_max_turns.jsonl")
        self.assertTrue(res.capped)
        self.assertIsNone(res.infra)


if __name__ == "__main__":
    unittest.main()
