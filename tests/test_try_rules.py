"""harness.try_rules: your rules file as the agent's context, results only in results/try/, zero model calls.

Everything runs on the fake scenario (tests/_fake_scenario.py): temp AVG_ROOT and AVG_RESULTS_ROOT, a fake CI and fake
consumer tests, the mock agent. No Node, no worker node_modules, no pre-registration lock.
"""
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from harness import gitutil, jsonio, paths, record, scenario_io, try_rules, unitsio
from harness.adapters import mock as _mock_adapter  # noqa: F401  (imported once, before any test patches paths.REPO)
from harness.workspace import materialize
from tests._fake_scenario import FakeScenario

RULES = "# Team rules\n\n- Never break a deployed consumer: add fields, deprecate before you remove.\n"
REMOVE_READD = {"X-remove|V0|S0": {"gen": "X-remove/breaking", "repairs": ["X-remove/readd"]}}

# One audit hook per process (they cannot be removed); it records only while _AUDIT["on"] is set.
_AUDIT = {"on": False, "events": []}


def _audit(event, args):
    if _AUDIT["on"] and event in ("open", "os.listdir", "os.scandir") and args:
        p = args[0]
        if isinstance(p, (str, bytes, os.PathLike)):
            mode = args[1] if event == "open" and len(args) > 1 else None
            flags = args[2] if event == "open" and len(args) > 2 else 0
            _AUDIT["events"].append((event, os.fsdecode(p), mode, flags))


sys.addaudithook(_audit)


def run(argv, fs, scripts=None):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = try_rules.main(argv, pipeline=fs.pipeline, mock_scripts=scripts)
    return code, out.getvalue(), err.getvalue()


def _norm(p) -> str:
    return os.path.normcase(os.path.abspath(str(p)))


def _under(p, d) -> bool:
    p, d = _norm(p), _norm(d)
    return p == d or p.startswith(d.rstrip("\\/") + os.sep)


def _junction(link: Path, target: Path) -> bool:
    try:
        import _winapi
        target.mkdir(parents=True, exist_ok=True)
        link.parent.mkdir(parents=True, exist_ok=True)
        _winapi.CreateJunction(str(target), str(link))
        return True
    except (ImportError, AttributeError, OSError):
        return False


class TryRulesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fs = FakeScenario().__enter__()
        cls.rules = cls.fs.tmp / "inputs" / "my-rules.md"
        cls.rules.parent.mkdir(parents=True)
        cls.rules.write_text(RULES, encoding="utf-8", newline="\n")

    @classmethod
    def tearDownClass(cls):
        cls.fs.__exit__(None, None, None)

    def setUp(self):
        for d in (paths.results_root(), paths.avg_root()):
            if d.exists():
                for p in d.iterdir():
                    if p.is_dir() and not p.is_symlink() and not getattr(os.path, "isjunction", lambda _: False)(p):
                        gitutil.rmtree(p)
                    else:
                        os.rmdir(p) if p.is_dir() else p.unlink()

    def args(self, *extra):
        return ["--context", str(self.rules), "--unit", "mock", "--quiet", *extra]

    def verdict(self) -> dict:
        files = sorted((paths.ns_dir("try") / "verdicts").glob("*.json"))
        self.assertEqual(len(files), 1, files)
        return jsonio.read_json(files[0])

    # ---------------------------------------------------------------- the context file

    def test_context_file_replaces_the_s_text_under_the_adapters_name(self):
        units = unitsio.load_units()
        for unit, name in (("mock", "CLAUDE.md"), ("cc-sonnet", "CLAUDE.md"), ("codex", "AGENTS.md"),
                           ("agy-flash", "GEMINI.md")):
            ws = materialize("try", 1, unit, "X-rename", "V0", try_rules.SPEC, units=units, context_text=RULES)
            try:
                self.assertEqual(ws.context_file, name)
                self.assertEqual((ws.root / name).read_text(encoding="utf-8"), RULES)
                self.assertEqual([n for n in ("CLAUDE.md", "AGENTS.md", "GEMINI.md") if (ws.root / n).exists()], [name])
                self.assertTrue(_under(ws.root, paths.avg_root() / "wt1"))
                self.assertEqual(gitutil.show(ws.root, "base", name), RULES)       # part of the base commit
            finally:
                ws.clean()
        ws = materialize("try", 1, "mock", "X-rename", "V2", try_rules.SPEC, units=units, context_text=RULES)
        self.assertEqual((ws.root / "CLAUDE.md").read_text(encoding="utf-8"), scenario_io.V2_LINE + "\n\n" + RULES)
        ws.clean()
        ws = materialize("try", 1, "mock", "X-rename", "V0", "S2", units=units)    # experiment default unchanged
        self.assertEqual((ws.root / "CLAUDE.md").read_text(encoding="utf-8"), scenario_io.context_text("S2"))
        ws.clean()

    def test_load_context_normalizes_and_hashes(self):
        p = self.fs.tmp / "inputs" / "crlf.md"
        p.write_bytes(b"\xef\xbb\xbf# Rules\r\n- one")
        text, meta = try_rules.load_context(str(p))
        self.assertEqual(text, "# Rules\n- one\n")
        self.assertEqual(meta, {"name": "crlf.md", "sha256": hashlib.sha256(text.encode()).hexdigest(),
                                "bytes": len(text.encode())})

    # ---------------------------------------------------------------- end to end with the mock agent

    def test_mock_end_to_end_verdict_record_and_bundle(self):
        code, out, err = run(self.args("--tickets", "X-rename,X-remove", "--n", "2"), self.fs, REMOVE_READD)
        self.assertEqual(code, 0, err)
        v = self.verdict()
        xr, xm = v["tickets"]["X-rename"], v["tickets"]["X-remove"]
        self.assertEqual((xr["runs"], xr["broke_first"], xr["ci_caught"], xr["ci_missed"]), (2, 2, 2, 0))
        self.assertEqual(xr["ci_caught_checks"], {"ARCH-4": 2})
        self.assertEqual(xr["teams_first"], {"billing-service": 2, "analytics-ingest": 2})
        self.assertEqual((xr["broke_final"], xr["ci_green_final"], xr["ticket"]), (0, 2, {"done": 2}))
        self.assertEqual(xr["outcomes"], {"fixed_code": 2})
        self.assertEqual((xm["broke_first"], xm["ci_caught"], xm["broke_final"]), (2, 2, 0))
        self.assertEqual(xm["teams_first"], {"analytics-ingest": 2})
        self.assertEqual(xm["ticket"], {"not_done": 2})
        for line in ("X-rename: 2 run(s)", "Broke another team on the first try: 2 of 2",
                     "CI caught it: 2 of those 2 (ARCH-4 2). CI missed it: 0.",
                     "0 of 2 still break another team. CI green: 2 of 2.", "Ticket: done 2.", "Ticket: not done 2.",
                     "The other teams' tests decide if a change broke them. Not the agent, and not CI.",
                     "the mock agent is scripted. It does not read your file. Here it plays the experiment's S0"):
            self.assertIn(line, out)
        self.assertNotIn("oracle", out.lower())
        self.assertEqual(v["text"], out.strip())

        sha = hashlib.sha256(RULES.encode()).hexdigest()
        man = jsonio.read_json(paths.manifest_path("try"))
        self.assertEqual(man["namespace"], "try")
        self.assertEqual(len(man["runs"]), 4)
        self.assertEqual([r["ticket"] for r in man["runs"]], ["X-rename", "X-remove"] * 2)   # interleaved
        st = jsonio.read_json(paths.state_path("try"))
        self.assertEqual(st["namespace"], "try")
        self.assertEqual({r["status"] for r in st["runs"].values()}, {"done"})
        self.assertIsNone(st["runner"]["pid"])
        self.assertFalse(paths.runner_lock_path("try").exists())
        ctx_copy = paths.ns_dir("try") / man["tries"][v["meta"]["try_id"]]["context"]["copy"]
        self.assertEqual(ctx_copy.read_text(encoding="utf-8"), RULES)

        rid = man["runs"][0]["run_id"]
        d = paths.run_dir("try", rid)
        rec = jsonio.read_json(d / "record.json")
        self.assertEqual((rec["namespace"], rec["stage"], rec["spec"], rec["context_file"]),
                         ("try", "try", "custom", "CLAUDE.md"))
        self.assertEqual(rec["try"]["context"]["sha256"], sha)
        self.assertEqual(rec["try"]["mock_as"], "S0")
        self.assertEqual(record.validate(rec), [])
        self.assertTrue(rec["trace_valid"], rec.get("trace_violations"))
        clone = self.fs.tmp / "clone"
        subprocess.run(["git", *paths.GIT_INLINE, "clone", "-q", str(d / "workspace.bundle"), str(clone)],
                       env=paths.git_env(), check=True, capture_output=True)
        self.assertEqual(gitutil.show(clone, "base", "CLAUDE.md"), RULES)          # the agent got YOUR file
        gitutil.rmtree(clone)

    def test_mock_as_s2_plays_the_rules_script(self):
        code, out, err = run(self.args("--tickets", "X-rename", "--n", "1", "--mock-as", "S2"), self.fs)
        self.assertEqual(code, 0, err)
        xr = self.verdict()["tickets"]["X-rename"]
        self.assertEqual((xr["broke_first"], xr["broke_final"], xr["outcomes"]), (0, 0, {"passed_first_ci": 1}))
        self.assertIn("Broke another team on the first try: 0 of 1.", out)
        self.assertIn("CI had nothing to catch.", out)

    def test_needs_no_preregistration_lock(self):
        boom = mock.Mock(side_effect=AssertionError("try_rules must not check the pre-registration"))
        with mock.patch("harness.prereg.verify", boom), mock.patch("harness.prereg.verify_addendum", boom), \
                mock.patch.object(paths, "PREREG_LOCK", self.fs.tmp / "no-such.lock"):
            code, _, err = run(self.args("--tickets", "X-rename", "--n", "1"), self.fs)
        self.assertEqual(code, 0, err)
        boom.assert_not_called()

    # ---------------------------------------------------------------- isolation

    def test_never_reads_or_writes_the_experiment_namespaces(self):
        sentinels = {paths.manifest_path("real"): b'{"namespace": "real", "runs": []}\n',
                     paths.state_path("mock"): b'{"namespace": "mock", "runs": {}}\n'}
        for p, data in sentinels.items():
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        _AUDIT["events"].clear()
        _AUDIT["on"] = True
        try:
            code, _, err = run(self.args("--tickets", "X-rename,X-remove", "--n", "1"), self.fs, REMOVE_READD)
        finally:
            _AUDIT["on"] = False
        self.assertEqual(code, 0, err)
        touched = [e for e in _AUDIT["events"]
                   if any(_under(e[1], paths.ns_dir(ns)) for ns in paths.NAMESPACES)]
        self.assertEqual(touched, [])
        for p, data in sentinels.items():
            self.assertEqual(p.read_bytes(), data)
        self.assertEqual({p.name for p in paths.ns_dir("real").iterdir()}, {"manifest.json"})
        self.assertEqual({p.name for p in paths.ns_dir("mock").iterdir()}, {"state.json"})
        self.assertEqual({p.name for p in paths.avg_root().iterdir()}, {"wt1", "cfg"})
        self.assertEqual({p.name for p in (paths.avg_root() / "cfg").iterdir()}, {"wt1"})
        writes = [e for e in _AUDIT["events"] if e[0] == "open" and (
            (isinstance(e[2], str) and any(c in e[2] for c in "wax+"))
            or (isinstance(e[3], int) and e[3] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT)))]
        self.assertTrue(writes)
        for e in writes:   # writes land in results/try or the try worker; never in the repo (bytecode aside)
            self.assertFalse(_under(e[1], paths.REPO) and "__pycache__" not in e[1], e)
            if _under(e[1], paths.results_root()):
                self.assertTrue(_under(e[1], paths.ns_dir("try")), e)

    def assertRefusedNothingWritten(self, code, err, *needles):
        self.assertEqual(code, 2, err)
        self.assertIn("refused:", err)
        for n in needles:
            self.assertIn(n, err)
        self.assertFalse((paths.ns_dir("try") / "verdicts").exists())
        self.assertFalse(paths.runs_dir("try").exists())

    def test_refuses_a_try_folder_that_is_the_real_namespace(self):
        orig = paths.ns_dir
        with mock.patch.object(paths, "ns_dir", lambda ns: orig("real") if ns == "try" else orig(ns)):
            code, _, err = run(self.args(), self.fs)
        self.assertRefusedNothingWritten(code, err, "overlaps results/real")
        self.assertFalse(paths.ns_dir("real").exists())

    def test_refuses_a_results_root_inside_the_repos_mock_namespace(self):
        fake_repo = self.fs.tmp / "fake-repo"
        root = fake_repo / "results" / "mock"
        with mock.patch.object(paths, "REPO", fake_repo), mock.patch.dict(os.environ, {"AVG_RESULTS_ROOT": str(root)}):
            code, _, err = run(self.args(), self.fs)
            self.assertRefusedNothingWritten(code, err, "overlaps the repo's results/mock")
        self.assertFalse(root.exists())

    def test_refuses_a_foreign_state_file_in_the_try_folder(self):
        jsonio.write_json_atomic(paths.state_path("try"), {"namespace": "real", "runs": {}})
        code, _, err = run(self.args(), self.fs)
        self.assertRefusedNothingWritten(code, err, "is not a try file")

    def test_refuses_junctions_into_the_experiment(self):
        if not _junction(paths.ns_dir("try"), paths.ns_dir("real")):
            self.skipTest("junctions not available")
        code, _, err = run(self.args(), self.fs)
        self.assertRefusedNothingWritten(code, err, "overlaps results/real")
        self.assertEqual(list(paths.ns_dir("real").iterdir()), [])
        os.rmdir(paths.ns_dir("try"))
        self.assertTrue(_junction(paths.worker_dir("try", 1), paths.worker_dir("real", 1)))
        code, _, err = run(self.args(), self.fs)
        self.assertRefusedNothingWritten(code, err, "try worker folder")
        self.assertEqual(list(paths.worker_dir("real", 1).iterdir()), [])

    def test_try_namespace_paths(self):
        self.assertNotIn("try", paths.NAMESPACES)          # console, runner and analysis never list it
        self.assertEqual(paths.ns_dir("try"), paths.results_root() / "try")
        self.assertEqual(paths.worker_dir("try", 2), paths.avg_root() / "wt2")
        self.assertEqual(paths.cfg_dir("try", 2), paths.avg_root() / "cfg" / "wt2")
        self.assertEqual(try_rules.isolation_problems(), [])
        with self.assertRaises(try_rules.Refused):
            try_rules._in_try(paths.ns_dir("real") / "x.json")

    # ---------------------------------------------------------------- real agents and your own adapter

    def test_real_unit_needs_live_and_makes_no_call(self):
        from harness.adapters import claude_code
        before = claude_code.CALLS
        code, _, err = run(["--context", str(self.rules), "--unit", "cc-sonnet"], self.fs)
        self.assertRefusedNothingWritten(code, err, "--live")
        code, _, err = run(["--context", str(self.rules), "--unit", "cc-sonnet", "--live"], self.fs)
        self.assertRefusedNothingWritten(code, err, "not ready", "--ns try")      # wt1 has no node_modules
        self.assertEqual(claude_code.CALLS, before)

    def test_your_own_adapter_via_units_file(self):
        from harness.adapters import mock as mock_adapter
        seen = {}

        def run_session(ws, prompt, *, resume=None, unit, limits, on_event=None):
            seen["context"] = (ws.root / ws.context_file).read_text(encoding="utf-8")
            seen["unit"] = unit
            ws.mock_script = {"gen": "X-rename/correct", "repairs": []}         # stands in for a real CLI
            return mock_adapter.run_session(ws, prompt, resume=resume, unit=unit, limits=limits, on_event=on_event)

        mod = types.ModuleType("harness.adapters.fake_try")
        mod.run_session = run_session
        units_file = self.fs.tmp / "inputs" / "my-units.json"
        units_file.write_text(json.dumps({"_comment": "mine", "my-agent": {"adapter": "fake_try", "model": "m-1",
                                                                          "context_file": "AGENTS.md"}}),
                              encoding="utf-8")
        for pkg in ("typescript", "dependency-cruiser"):           # what doctor.worker_ready looks for
            p = paths.worker_dir("try", 1) / "node_modules" / pkg / "package.json"
            p.parent.mkdir(parents=True)
            p.write_text("{}", encoding="utf-8")
        with mock.patch.dict(sys.modules, {"harness.adapters.fake_try": mod}):
            code, out, err = run(["--context", str(self.rules), "--unit", "my-agent", "--units-file", str(units_file),
                                  "--live", "--tickets", "X-rename", "--n", "1", "--quiet"], self.fs)
        self.assertEqual(code, 0, err)
        self.assertEqual(seen["context"], RULES)
        self.assertEqual((seen["unit"]["name"], seen["unit"]["model"]), ("my-agent", "m-1"))
        self.assertNotIn("mock agent is scripted", out)
        rid = jsonio.read_json(paths.manifest_path("try"))["runs"][0]["run_id"]
        rec = jsonio.read_json(paths.run_dir("try", rid) / "record.json")
        self.assertEqual((rec["adapter"], rec["context_file"], rec["outcome"]), ("fake_try", "AGENTS.md", "passed_first_ci"))
        self.assertEqual(record.validate(rec), [])
        strict = dict(rec, namespace="mock")         # experiment records keep the strict enums
        self.assertTrue(any(e.startswith("spec") for e in record.validate(strict)))
        self.assertTrue(any(e.startswith("adapter") for e in record.validate(strict)))

    def test_units_file_cannot_replace_a_frozen_unit(self):
        f = self.fs.tmp / "inputs" / "bad-units.json"
        f.write_text(json.dumps({"mock": {"adapter": "mock"}}), encoding="utf-8")
        code, _, err = run(self.args("--units-file", str(f)), self.fs)
        self.assertRefusedNothingWritten(code, err, "already exists")
        f.write_text(json.dumps({"x": {"adapter": "no_such_adapter", "context_file": "AGENTS.md"}}), encoding="utf-8")
        code, _, err = run(["--context", str(self.rules), "--unit", "x", "--units-file", str(f)], self.fs)
        self.assertRefusedNothingWritten(code, err, "no_such_adapter")

    def test_bad_inputs_are_refused(self):
        empty = self.fs.tmp / "inputs" / "empty.md"
        empty.write_text("  \n", encoding="utf-8")
        binary = self.fs.tmp / "inputs" / "bin.md"
        binary.write_bytes(b"\xff\xfe\x00rules")
        for argv, needle in (
                (["--context", str(self.fs.tmp / "missing.md"), "--unit", "mock"], "no such file"),
                (["--context", str(empty), "--unit", "mock"], "empty"),
                (["--context", str(binary), "--unit", "mock"], "not UTF-8"),
                (self.args("--tickets", "X-nope"), "unknown X-nope"),
                (self.args("--n", "0"), "--n must be"),
                (self.args("--workers", "4"), "--workers must be"),
                (["--context", str(self.rules), "--unit", "no-unit"], "unknown unit")):
            code, _, err = run(argv, self.fs)
            self.assertRefusedNothingWritten(code, err, needle)


if __name__ == "__main__":
    unittest.main()
