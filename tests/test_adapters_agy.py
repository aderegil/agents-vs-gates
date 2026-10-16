"""agy adapter (addendum 1, unit agy-flash) with a fake `agy` (tests/fixtures/fake_agy.py). Never runs the real CLI."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from harness import cycle, jsonio, paths, record, unitsio
from harness.adapters import agy
from harness.adapters.base import Limits
from tests._fake_scenario import FakeScenario

FAKE = Path(__file__).parent / "fixtures" / "fake_agy.py"
UNIT = {"name": "agy-flash", "adapter": "agy", "model": "gemini-3.8-flash-medium", "effort": "medium",
        "effort_flag": False, "sandbox": True, "context_file": "GEMINI.md"}


def fake_real_home(tmp: Path) -> Path:
    """A stand-in for C:\\Users\\<me>: sign-in files, memory, rules and config that must not be seeded."""
    h = tmp / "realhome"
    g = h / ".gemini"
    cli = g / "antigravity-cli"
    for d in ("brain/old-conv", "conversations", "annotations", "knowledge", "implicit", "builtin", "log"):
        (cli / d).mkdir(parents=True, exist_ok=True)
    (cli / "brain" / "old-conv" / "task.md").write_text("Alfredo's earlier session", encoding="utf-8")
    (cli / "conversations" / "old.pb").write_text("x", encoding="utf-8")
    for name, text in (("jetski_state.pbtxt", "state"), ("installation_id", "id"), ("settings.json", '{"model": "x"}'),
                       ("conversation_summaries.db", "db"), ("history.jsonl", "{}"), ("cli.log", "log"),
                       ("jetbox_summaries_proto.pb", "pb")):
        (cli / name).write_text(text, encoding="utf-8")
    (g / "config").mkdir()
    (g / "config" / "config.json").write_text('{"alwaysAllow": ["*"]}', encoding="utf-8")
    for name in ("oauth_creds.json", "google_accounts.json", "GEMINI.md", "AGENTS.md", "settings.json"):
        (g / name).write_text("x", encoding="utf-8")
    return h


class AgyArgv(unittest.TestCase):
    def test_gen_argv_exact(self):
        lim = Limits.for_session("gen")
        self.assertEqual(agy.build_argv(UNIT, lim, "Do the ticket."),
                         ["-p", "Do the ticket.", "--model", "gemini-3.8-flash-medium", "--output-format",
                          "stream-json", "--dangerously-skip-permissions", "--disable-slash-commands",
                          "--print-timeout", "600s", "--sandbox"])

    def test_resume_and_effort(self):
        lim = Limits.for_session("fix1")
        argv = agy.build_argv(dict(UNIT, effort_flag=True, sandbox=False), lim, "CI failed", resume="c-1")
        self.assertEqual(argv[-4:], ["--effort", "medium", "--conversation", "c-1"])
        self.assertIn("360s", argv)
        self.assertNotIn("--sandbox", argv)

    def test_units_ext_merged_and_frozen_table_untouched(self):
        units = unitsio.load_units()
        self.assertEqual(units["agy-flash"]["adapter"], "agy")
        self.assertEqual(units["agy-flash"]["model"], "gemini-3.8-flash-medium")
        self.assertIn("cc-sonnet", units)
        self.assertNotIn("agy-flash", json.loads(paths.UNITS.read_text(encoding="utf-8")))


class AgyHome(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.real = fake_real_home(self.tmp)

    def test_seed_is_sign_in_files_only(self):
        home = self.tmp / "cfg"
        (home / "stale").mkdir(parents=True)
        info = agy.prepare_home(home, r"C:\avg\w1\r", source=self.real)
        cli = home / ".gemini" / "antigravity-cli"
        self.assertEqual(sorted(p.name for p in cli.iterdir()), ["installation_id", "jetski_state.pbtxt",
                                                                 "settings.json"])
        self.assertEqual(json.loads((cli / "settings.json").read_text(encoding="utf-8")),
                         {"trustedWorkspaces": [r"C:\avg\w1\r"]})
        root = sorted(p.name for p in (home / ".gemini").iterdir())
        self.assertEqual(root, ["antigravity-cli", "google_accounts.json", "oauth_creds.json"])
        self.assertFalse((home / "stale").exists())
        self.assertEqual(info["seeded"], 4)

    def test_wipe_is_verified(self):
        home = self.tmp / "cfg"
        home.mkdir()
        (home / "brain").mkdir()
        with mock.patch.object(agy.gitutil, "rmtree"):
            with self.assertRaisesRegex(RuntimeError, "could not be wiped"):
                agy.prepare_home(home, "W", source=self.real)

    def test_env(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "k", "GOOGLE_API_KEY": "k", "AGY_ADC_AUTH": "1",
                                          "GOOGLE_APPLICATION_CREDENTIALS": "c", "CLAUDE_CODE_OAUTH_TOKEN": "t"}):
            env = agy.build_env(r"C:\avg\cfg\w1")
        self.assertEqual(env["USERPROFILE"], r"C:\avg\cfg\w1")
        self.assertEqual(env["HOME"], r"C:\avg\cfg\w1")
        for k in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "AGY_ADC_AUTH", "GOOGLE_APPLICATION_CREDENTIALS",
                  "CLAUDE_CODE_OAUTH_TOKEN"):
            self.assertNotIn(k, env)

    def test_memory_fingerprint_sees_new_files_never_contents(self):
        before = agy.memory_fingerprint(self.real)
        self.assertEqual(agy.memory_changes(before, agy.memory_fingerprint(self.real)), [])
        (self.real / ".gemini" / "antigravity-cli" / "brain" / "new.md").write_text("m", encoding="utf-8")
        self.assertEqual(agy.memory_changes(before, agy.memory_fingerprint(self.real)), ["brain"])


def stream(*objs):
    return [json.dumps(o) for o in objs]


class AgyParse(unittest.TestCase):
    def test_tools_mapped_paired_and_usage(self):
        p = agy.parse_stream(stream(
            {"event": "init", "conversation_id": "c1", "model": "gemini-3.8-flash-medium"},
            {"event": "tool_call", "conversation_id": "c1", "id": "a", "tool": "run_command",
             "args": {"CommandLine": "npm test", "Cwd": r"C:\avg\w1\r"}},
            {"event": "tool_call", "conversation_id": "c1", "tool": "view_file",
             "args": {"AbsolutePath": r"C:\Users\x\secret.txt"}},
            {"event": "tool_result", "conversation_id": "c1", "id": "a", "status": "success", "exit_code": 0,
             "output": "ok"},
            {"event": "tool_result", "conversation_id": "c1", "status": "error", "output": "denied?"},
            {"event": "message", "conversation_id": "c1", "text": "Done."},
            {"event": "result", "conversation_id": "c1", "status": "success", "response": "Done.",
             "num_turns": 3, "usage": {"input_tokens": 10, "output_tokens": 5, "thinking_tokens": 7,
                                       "cache_read_tokens": 4, "total_tokens": 22}}), "gen")
        calls = [e for e in p.events if e["kind"] == "tool_call"]
        self.assertEqual([c["name"] for c in calls], ["Bash", "Read"])
        self.assertEqual(calls[0]["input"]["command"], "npm test")
        self.assertEqual(calls[1]["input"]["file_path"], r"C:\Users\x\secret.txt")
        results = [e for e in p.events if e["kind"] == "tool_result"]
        self.assertEqual([r["id"] for r in results], ["gen:a", calls[1]["id"]])     # id-less result pairs FIFO
        self.assertEqual(results[1]["status"], "error")
        self.assertEqual(p.messages, ["Done."])
        usage, extra = p.usage()
        self.assertEqual(usage, {"input_tokens": 10, "output_tokens": 12, "cache_read_input_tokens": 4,
                                 "cache_creation_input_tokens": 0})
        self.assertEqual(extra, {"output_tokens_raw": 5, "thinking_tokens": 7, "total_tokens": 22})
        self.assertEqual((p.conversation_id, p.model), ("c1", "gemini-3.8-flash-medium"))
        from harness import covariates, detectors
        self.assertTrue(covariates.compute(p.events)["ran_tests"])
        hits = detectors.out_of_workspace_access(p.events, Path(r"C:\avg\w1\r"))
        self.assertEqual([h["path"] for h in hits], [r"C:\Users\x\secret.txt"])

    def test_classification(self):
        def cls(lines, rc=0, stderr="", timed_out=False):
            return agy.classify(agy.parse_stream(lines, "gen"), rc, stderr, timed_out)
        ok = stream({"event": "result", "status": "success", "response": "x"})
        self.assertIsNone(cls(ok)["infra"])
        rate = cls(["AGY_ERROR You have reached your individual quota. Try again in 2 hours."], rc=3)
        self.assertEqual(rate["infra"]["kind"], "rate_limited")
        self.assertIsNotNone(rate["infra"]["reset_at"])
        self.assertEqual(cls(["AGY_ERROR Your AI credits balance is too low to continue."], rc=3)["infra"]["kind"],
                         "rate_limited")
        auth = cls(["AGY_ERROR Not signed in. Please sign in."], rc=3)
        self.assertEqual(auth["infra"]["kind"], "api_error")
        self.assertTrue(auth["infra"]["detail"].startswith("auth:"))
        t = cls(stream({"event": "result", "status": "timeout"}), rc=1)
        self.assertEqual((t["capped"], t["turn_cap"], t["infra"]), (True, "wall-clock-only", None))
        self.assertTrue(cls([], rc=None, timed_out=True)["capped"])
        self.assertEqual(cls([], rc=0)["infra"]["kind"], "cli_crash")
        self.assertEqual(cls([], rc=2, stderr="boom")["infra"]["kind"], "cli_crash")
        mcp = cls(stream({"event": "tool_call", "tool": "mcp_github_search", "args": {}}))
        self.assertEqual(mcp["infra"]["kind"], "isolation_breach")

    def test_deltas_joined_unknown_counted(self):
        p = agy.parse_stream(stream({"event": "thought", "text": "a"}, {"event": "thought", "text": "b"},
                                    {"event": "message_delta", "delta": "O"}, {"event": "message_delta", "delta": "K"},
                                    {"event": "frobnicate"}, {"event": "result", "status": "success", "response": "OK"}),
                             "gen")
        texts = [(e["text"], bool(e.get("reasoning"))) for e in p.events if e["kind"] == "text"]
        self.assertEqual(texts, [("ab", True), ("OK", False)])
        self.assertEqual(p.messages, ["OK"])
        self.assertEqual(p.unknown, {"frobnicate": 1})


class AgySession(unittest.TestCase):
    """run_session against the fake CLI (a real subprocess, a real per-run HOME)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.real = fake_real_home(self.tmp)
        self.ws = SimpleNamespace(root=self.tmp / "ws", cfg=self.tmp / "cfg")
        (self.ws.root / "src" / "core").mkdir(parents=True)
        (self.ws.root / "src" / "core" / "events.ts").write_text("totalCents\n", encoding="utf-8")
        self.log = self.tmp / "agy.log"
        self.env = {"AVG_AGY_REAL_HOME": str(self.real), "FAKE_AGY_LOG": str(self.log),
                    "FAKE_AGY_REAL_HOME": str(self.real)}

    def run_session(self, mode, resume=None, session="gen"):
        with mock.patch.dict(os.environ, dict(self.env, FAKE_AGY_MODE=mode)), \
                mock.patch.object(agy, "entry_argv", return_value=[sys.executable, str(FAKE)]):
            return agy.run_session(self.ws, "Do the ticket.", resume=resume, unit=UNIT,
                                   limits=Limits.for_session(session))

    def test_gen_then_resume_in_the_same_home(self):
        gen = self.run_session("rename_fix")
        self.assertIsNone(gen.infra, gen.infra)
        self.assertEqual((gen.num_turns, gen.subtype, gen.turn_cap), (4, "success", "wall-clock-only"))
        self.assertEqual(gen.usage["output_tokens"], 500)
        self.assertEqual(gen.usage_extra["thinking_tokens"], 200)
        self.assertEqual(gen.cli_version, "1.3.6-fake")
        self.assertEqual(gen.model_reported, "gemini-3.8-flash-medium")
        self.assertEqual(gen.isolation["real_home_memory_changed"], [])
        self.assertIn("amountCents", (self.ws.root / "src" / "core" / "events.ts").read_text(encoding="utf-8"))
        fix = self.run_session("rename_fix", resume=gen.session_id, session="fix1")
        self.assertIsNone(fix.infra, fix.infra)
        self.assertEqual(fix.session_id, gen.session_id)
        calls = [json.loads(l) for l in self.log.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([c["userprofile"] for c in calls], [str(self.ws.cfg)] * 2)
        self.assertNotIn("--conversation", calls[0]["argv"])
        self.assertEqual(calls[1]["argv"][calls[1]["argv"].index("--conversation") + 1], gen.session_id)
        self.assertEqual(Path(calls[0]["cwd"]).resolve(), self.ws.root.resolve())
        self.assertTrue(gen.record_entry()["usage_extra"]["total_tokens"])

    def test_leak_into_real_home_is_an_isolation_breach(self):
        r = self.run_session("leak")
        self.assertEqual(r.infra["kind"], "isolation_breach")
        self.assertEqual(r.isolation["real_home_memory_changed"], ["brain"])

    def test_rate_limit_and_resume_in_a_fresh_home_fails(self):
        self.assertEqual(self.run_session("rate").infra["kind"], "rate_limited")
        r = self.run_session("ok", resume="not-in-this-home", session="fix1")
        self.assertEqual(r.infra["kind"], "api_error")


class AgyCycle(unittest.TestCase):
    """A whole run through cycle.execute_run with unit agy-flash and the fake CLI: CI, repair via --conversation,
    oracle, record and trace."""

    def test_break_then_fix(self):
        with FakeScenario() as fs:
            tmp = Path(tempfile.mkdtemp())
            real = fake_real_home(tmp)
            units = {"agy-flash": dict(UNIT, name=None)}
            units["agy-flash"].pop("name")
            entry = {"run_id": "st-agy1", "stage": "selftest", "unit": "agy-flash", "ticket": "X-rename",
                     "wording": "W1", "paraphrase": None, "visibility": "V0", "spec": "S0", "replicate": 1,
                     "cell": "X-rename|V0|S0|W1|agy-flash"}
            with mock.patch.dict(os.environ, {"AVG_AGY_REAL_HOME": str(real), "FAKE_AGY_MODE": "rename_fix"}), \
                    mock.patch.object(agy, "entry_argv", return_value=[sys.executable, str(FAKE)]):
                rec = cycle.execute_run(entry, ns="mock", worker_ns="selftest", worker=1, units=units,
                                        pipeline=fs.pipeline, seed=7)
            self.assertEqual(rec["outcome"], "fixed_code", rec.get("infra_failure"))
            self.assertEqual(rec["context_file"], "GEMINI.md")
            self.assertEqual(rec["adapter"], "agy")
            self.assertEqual(rec["repair_attempts"], 1)
            self.assertTrue(rec["metrics"]["staging_break"])
            self.assertTrue(rec["trace_valid"], rec.get("trace_violations"))
            self.assertTrue(rec["covariates"]["ran_tests"])
            self.assertEqual(rec["sessions"][1]["kind"], "fix1")
            d = paths.run_dir("mock", "st-agy1")
            self.assertEqual(record.validate(jsonio.read_json(d / "record.json")), [])


class LiveSchema(unittest.TestCase):
    """The shape agy 1.3.6 really prints (smoke 2026-10-16): {"event": X, X: {...}} with step_update steps."""

    def test_call_1_of_the_smoke(self):
        cid = "542ce56e-e53f-40ea-b794-8af45a48d262"
        u = {"input_tokens": 12892, "output_tokens": 82, "thinking_tokens": 78, "cache_read_tokens": 0,
             "total_tokens": 12974}
        lines = [json.dumps(x) for x in (
            {"event": "init", "conversation_id": cid, "init": {"model": "gemini-3.8-flash-medium", "cwd": "C:/x",
                                                               "tools": ["run_command"], "permission_mode": "p"}},
            {"event": "step_update", "step_update": {"conversation_id": cid, "step_index": 0, "state": "DONE",
                                                     "step_type": "user_input"}},
            {"event": "step_update", "step_update": {"conversation_id": cid, "step_index": 1, "state": "ACTIVE",
                                                     "step_type": "agent_response", "text_delta": "OK. KIWI"}},
            {"event": "step_update", "step_update": {"conversation_id": cid, "step_index": 2, "state": "ACTIVE",
                                                     "step_type": "run_command", "CommandLine": "npm test"}},
            {"event": "step_update", "step_update": {"conversation_id": cid, "step_index": 2, "state": "DONE",
                                                     "step_type": "run_command", "output": "1 passing"}},
            {"event": "result", "result": {"conversation_id": cid, "status": "SUCCESS", "response": "OK. KIWI\n",
                                           "duration_seconds": 2.5, "num_turns": 1, "usage": u}})]
        p = agy.parse_stream(lines, "gen")
        self.assertEqual((p.model, p.conversation_id, p.unknown), ("gemini-3.8-flash-medium", cid, {}))
        self.assertEqual(p.messages, ["OK. KIWI"])
        calls = [e for e in p.events if e["kind"] == "tool_call"]
        self.assertEqual((calls[0]["name"], calls[0]["input"]["command"]), ("Bash", "npm test"))
        self.assertEqual([e["status"] for e in p.events if e["kind"] == "tool_result"], ["success"])
        self.assertEqual(p.usage()[0]["output_tokens"], 160)
        self.assertEqual(agy.classify(p, 0, "", False)["subtype"], "success")


if __name__ == "__main__":
    unittest.main()
