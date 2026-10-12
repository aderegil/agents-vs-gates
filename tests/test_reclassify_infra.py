import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout

from harness import jsonio, paths, reclassify_infra, runner
from harness.jsonio import read_json, read_jsonl, write_jsonl
from tests._analysis_fixture import ResultsTree, record

DEAD = "MXC launcher: failed to create the process security environment: CreateProcessSecurityEnvironment failed " \
       "(HRESULT = 0x80070020)\n"


def transcript(dead_from: int | None, calls: int = 3) -> list[dict]:
    out = []
    for i in range(1, calls + 1):
        dead = dead_from is not None and i >= dead_from
        out += [{"ts": f"2026-10-12T16:12:0{i}Z", "session": "gen", "kind": "tool_call", "id": f"item_{i}",
                 "name": "Bash", "input": {"command": "rg -n channel"}},
                {"ts": f"2026-10-12T16:12:0{i}Z", "session": "gen", "kind": "tool_result", "id": f"item_{i}",
                 "status": "error" if dead else "success", "output": DEAD if dead else "src/a.ts:1:channel"}]
    return out


def tree(t):
    """p6-0001 dead from its first command, p6-0002 dead after one good command (attempt 2), p6-0003 healthy."""
    for n, dead_from in ((1, 1), (2, 2), (3, None)):
        rid = f"p6-{n:04d}"
        t.add(record(rid, "P6", "X-rename", "V0", "S0", unit="codex", outcome="no_change"))
        write_jsonl(t.ns_dir / "runs" / rid / "transcript.jsonl", transcript(dead_from))
    t.state_runs["p6-0002"]["attempts"] = 2
    t.write(unblinded=["P6"])


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = reclassify_infra.main(argv)
    return code, out.getvalue(), err.getvalue()


class TestReclassify(unittest.TestCase):
    def test_dry_run_lists_only_the_dead_and_changes_nothing(self):
        with ResultsTree() as t:
            tree(t)
            before = (t.ns_dir / "state.json").read_bytes()
            code, out, _ = run(["--ns", "real", "--stage", "P6"])
            self.assertEqual(code, 0)
            self.assertIn("p6-0001", out)
            self.assertIn("attempts/p6-0002/attempt-2", out)
            self.assertNotIn("p6-0003", out)
            self.assertIn("2 run(s) to re-queue, 0 refused", out)
            self.assertEqual((t.ns_dir / "state.json").read_bytes(), before)
            self.assertFalse((t.ns_dir / "attempts").exists())

    def test_apply_archives_and_requeues(self):
        with ResultsTree() as t:
            tree(t)
            rec_before = (t.ns_dir / "runs" / "p6-0001" / "record.json").read_bytes()
            code, out, err = run(["--ns", "real", "--runs", "p6-0001,p6-0002", "--apply"])
            self.assertEqual(code, 0, err)
            arch = t.ns_dir / "attempts" / "p6-0001" / "attempt-1"
            self.assertEqual((arch / "record.json").read_bytes(), rec_before)          # moved unchanged
            self.assertTrue((arch / "transcript.jsonl").exists())
            note = read_json(arch / "reclassified.json")
            self.assertEqual((note["from_outcome"], note["infra_failure"]["kind"]), ("no_change", "sandbox_unavailable"))
            self.assertTrue((t.ns_dir / "attempts" / "p6-0002" / "attempt-2").exists())
            self.assertFalse((t.ns_dir / "runs" / "p6-0001").exists())
            self.assertTrue((t.ns_dir / "runs" / "p6-0003").exists())                  # untouched
            st = read_json(paths.state_path("real"))
            r = st["runs"]["p6-0001"]
            self.assertEqual((r["status"], r["infra_failures"]), ("pending", 1))
            self.assertEqual(r["reclassified"][0]["archive"], "attempts/p6-0001/attempt-1")
            self.assertEqual(st["runs"]["p6-0003"], {"status": "done"})
            import jsonschema
            jsonschema.validate(st["runs"], json.loads((paths.CONTRACTS / "state.schema.json").read_text(
                encoding="utf-8"))["properties"]["runs"])
            log = read_jsonl(paths.runner_log_path("real"))
            self.assertEqual([e["run_id"] for e in log if e["event"] == "reclassified"], ["p6-0001", "p6-0002"])
            # the runner picks them up again, with the same ids
            m = {"runs": [{"run_id": f"p6-{n:04d}", "stage": "P6"} for n in (1, 2, 3)]}
            todo = [x["run_id"] for x in m["runs"] if st["runs"][x["run_id"]]["status"] in ("pending", "infra_failure")]
            self.assertEqual(todo, ["p6-0001", "p6-0002"])
            # a second apply finds nothing to do and cannot overwrite the archive
            code, out, _ = run(["--ns", "real", "--runs", "p6-0001", "--apply"])
            self.assertEqual(code, 2)

    def test_refusals_change_nothing(self):
        with ResultsTree() as t:
            tree(t)
            before = (t.ns_dir / "state.json").read_bytes()
            code, out, err = run(["--ns", "real", "--runs", "p6-0001,p6-0003", "--apply"])     # 0003 is healthy
            self.assertEqual(code, 2)
            self.assertIn("REFUSED p6-0003: no dead-sandbox signature", out)
            self.assertEqual(code, run(["--ns", "real", "--apply"])[0])                       # --apply needs --runs
            self.assertEqual((t.ns_dir / "state.json").read_bytes(), before)
            st = read_json(paths.state_path("real"))
            st["runner"] = {"pid": None, "status": "running"}
            jsonio.write_json_atomic(paths.state_path("real"), st)
            code, _, err = run(["--ns", "real", "--runs", "p6-0001", "--apply"])
            self.assertEqual(code, 2)
            self.assertIn("runner is alive", err)
            self.assertTrue((t.ns_dir / "runs" / "p6-0001" / "record.json").exists())
            self.assertFalse((t.ns_dir / "attempts").exists())


class TestRunnerRequeuesSandboxUnavailable(unittest.TestCase):
    def test_requeued_not_stopping_the_batch(self):
        with ResultsTree() as t:
            t.write()
            st = runner.State("real", runner.new_state("real"))
            b = runner.Batch("real", "P6", [], st, {"seed": 1}, workers=1, max_runs=None, max_minutes=None,
                             unit_label=None, quiet=True)
            entry = {"run_id": "p6-0001", "stage": "P6"}
            b._infra(entry, {"kind": "sandbox_unavailable", "detail": "sandbox could not start a command"}, 1)
            self.assertEqual(st.run("p6-0001")["status"], "infra_failure")
            self.assertEqual(st.run("p6-0001")["infra_failures"], 1)
            self.assertEqual(b.queue, [entry])
            self.assertIsNone(b.stop_reason)


if __name__ == "__main__":
    unittest.main()
