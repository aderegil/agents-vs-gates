"""Codex smoke, dry: evaluate() on synthetic --json streams, the dry run, and the per-unit smoke guard. Never runs codex."""
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from harness import jsonio, paths, runner, smoke_codex
from harness.adapters import codex as cx


def stream(*items, message=None, model=None):
    out = [json.dumps({"type": "thread.started", "thread_id": "th-1", **({"model": model} if model else {})}),
           json.dumps({"type": "turn.started"})]
    for i, (cmd, output, status) in enumerate(items):
        out.append(json.dumps({"type": "item.started", "item": {"id": f"c{i}", "type": "command_execution",
                                                                "command": cmd, "status": "in_progress"}}))
        out.append(json.dumps({"type": "item.completed", "item": {
            "id": f"c{i}", "type": "command_execution", "command": cmd, "aggregated_output": output,
            "exit_code": 0 if status == "completed" else 1, "status": status}}))
    if message:
        out.append(json.dumps({"type": "item.completed", "item": {"id": "m", "type": "agent_message", "text": message}}))
    out.append(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 100, "cached_input_tokens": 0,
                                                               "output_tokens": 7}}))
    return out


def parse(lines, max_turns=30):
    p = cx.JsonlParser("smoke", max_turns=max_turns)
    for l in lines:
        p.feed(l)
    return p


OK = {"rc": 0, "stderr": "", "timed_out": False}


class EvaluateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-sc-"))
        self.env = os.environ.get("AVG_ROOT")
        os.environ["AVG_ROOT"] = str(self.tmp)
        smoke_codex.smoke_dir().mkdir(parents=True)
        smoke_codex.outside_dir().mkdir(parents=True)

    def tearDown(self):
        if self.env is None:
            os.environ.pop("AVG_ROOT", None)
        else:
            os.environ["AVG_ROOT"] = self.env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def by_name(self, checks):
        return {c["name"]: c["ok"] for c in checks}

    def test_call1_clean_start(self):
        p = parse(stream(message="OK KIWI", model="gpt-5.6-terra"))
        got = self.by_name(smoke_codex.evaluate(1, p, OK, smoke_codex.smoke_dir(), ["auth.json", "rules"]))
        self.assertTrue(all(got.values()), got)
        got = self.by_name(smoke_codex.evaluate(1, parse(stream(message="OK")), OK, smoke_codex.smoke_dir(),
                                                ["auth.json", "config.toml", "rules"]))
        self.assertFalse(got["workspace AGENTS.md read (reply ends with KIWI)"])
        self.assertFalse(got["CODEX_HOME held only auth.json and rules/"])

    def test_call2_sandbox_refusal_fails(self):
        ok = parse(stream(("npm test", "> test\nSMOKE_TEST_OK\n", "completed")))
        self.assertTrue(smoke_codex.evaluate(2, ok, OK, smoke_codex.smoke_dir())[0]["ok"])
        bad = parse(stream(("npm test", 'CreateProcess { message: "windows unelevated restricted-token sandbox cannot '
                                        'enforce split writable root sets directly; refusing to run unsandboxed" }',
                            "failed")))
        c = smoke_codex.evaluate(2, bad, OK, smoke_codex.smoke_dir())[0]
        self.assertFalse(c["ok"])
        self.assertIn("refusing to run unsandboxed", c["detail"])

    def test_call3_inside_and_outside(self):
        ws = smoke_codex.smoke_dir()
        (ws / "notes.txt").write_text("smoke notes\nedited\n", encoding="utf-8")
        got = self.by_name(smoke_codex.evaluate(3, parse(stream()), OK, ws))
        self.assertTrue(got["write inside the workspace"])
        self.assertTrue(got["write outside the workspace refused"])
        (smoke_codex.outside_dir() / "outside.txt").write_text("x", encoding="utf-8")
        self.assertFalse(self.by_name(smoke_codex.evaluate(3, parse(stream()), OK, ws))["write outside the workspace refused"])

    def test_call5_refusals_and_outside_read(self):
        ws = smoke_codex.smoke_dir()
        p = parse(stream(('node -e "console.log(1)"', "forbidden by policy", "failed"),
                         ("curl https://example.com", "forbidden by policy", "failed"),
                         ("git commit --allow-empty -m x", "forbidden by policy", "failed"),
                         (r"type ..\smoke-codex-outside\canary.txt", "denied", "failed")))
        got = self.by_name(smoke_codex.evaluate(5, p, OK, ws))
        self.assertTrue(all(got.values()), got)
        p = parse(stream(('node -e "console.log(1)"', "1\n", "completed")))
        self.assertFalse(self.by_name(smoke_codex.evaluate(5, p, OK, ws))["node -e refused"])

    def test_call6_turn_cap(self):
        p = parse(stream(("dir", "a\n", "completed"), ("type a", "x\n", "completed")), max_turns=2)
        self.assertTrue(smoke_codex.evaluate(6, p, {"rc": None, "stderr": "", "timed_out": False}, smoke_codex.smoke_dir())[0]["ok"])

    def test_dry_run_makes_no_call(self):
        before = cx.CALLS
        out = io.StringIO()
        with redirect_stdout(out), mock.patch.object(cx, "entry_argv", return_value=["codex.exe"]):
            self.assertEqual(smoke_codex.main(True, False), 0)
        self.assertEqual(cx.CALLS, before)
        text = out.getvalue()
        self.assertIn("DRY RUN: 0 calls made", text)
        self.assertIn('model_reasoning_effort=\\"medium\\"', text)
        self.assertIn("exec\", \"resume\"", text)
        self.assertEqual(smoke_codex.main(False, False), 2)     # refuses without --i-am-authorized


class SmokeGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-sg-"))
        self.env = os.environ.get("AVG_RESULTS_ROOT")
        os.environ["AVG_RESULTS_ROOT"] = str(self.tmp)

    def tearDown(self):
        if self.env is None:
            os.environ.pop("AVG_RESULTS_ROOT", None)
        else:
            os.environ["AVG_RESULTS_ROOT"] = self.env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_each_adapter_needs_its_own_smoke(self):
        self.assertEqual(runner.smoke_files({"cc-sonnet"}), {"smoke.json": ""})
        self.assertEqual(runner.smoke_files({"codex"}), {"smoke-codex.json": " --unit codex"})
        jsonio.write_json_atomic(paths.results_root() / "smoke.json", {"ok": True})
        self.assertFalse(any("smoke" in e for e in runner.guard_errors("real", "X1", {"cc-sonnet"})))
        errs = runner.guard_errors("real", "X1", {"codex"})
        self.assertTrue(any("smoke-codex.json" in e and "--unit codex" in e for e in errs), errs)
        jsonio.write_json_atomic(paths.results_root() / "smoke-codex.json", {"ok": True})
        self.assertFalse(any("smoke" in e for e in runner.guard_errors("real", "X1", {"codex"})))


if __name__ == "__main__":
    unittest.main()
