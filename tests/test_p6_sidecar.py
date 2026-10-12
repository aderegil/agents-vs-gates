"""P6 (Codex replication) as a sidecar beside the frozen manifest.json, and `runner --stage P6 --part`.
No model call, no runner launch outside --dry-run, results root in a temp folder."""
import hashlib
import io
import json
import os
import shutil
import tempfile
import unittest
from collections import Counter, defaultdict
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from harness import jsonio, manifest, paths, prereg, runner

# sha256 of the P6 runs that `generate(20261011, ns, with_p6=True)` made before runs carried `part`
# (json.dumps(runs, sort_keys=True)); the sidecar must reproduce them exactly once `part` is dropped.
PINNED = {"real": "7a92de831c33c61b9b2c0bc9b27a2abb260562d1fe0ea462cd4d805fc83f61c1",
          "mock": "52f1ae68bc64f171a812f0f83b9098aec79f3a57fc15f602c02ce5e974b49dce"}


def _sha(runs):
    return hashlib.sha256(json.dumps(runs, sort_keys=True).encode()).hexdigest()


class P6RunsTest(unittest.TestCase):
    def test_sidecar_reproduces_the_with_p6_runs(self):
        for ns, sha in PINNED.items():
            runs = manifest.generate_p6(ns=ns)["runs"]
            self.assertEqual(_sha([{k: v for k, v in r.items() if k != "part"} for r in runs]), sha, ns)

    def test_parts_and_cells(self):
        m = manifest.generate_p6()
        runs = m["runs"]
        self.assertEqual([r["run_id"] for r in runs], [f"p6-{i:04d}" for i in range(1, 122)])
        self.assertEqual(m["parts"], {"P1": 60, "P2": 10, "P4": 51})
        self.assertEqual(m["stage_counts"], {"P6": 121})
        self.assertTrue(all(r["unit"] == "codex" and r["stage"] == "P6" for r in runs))
        self.assertEqual(manifest.validate(m), [])
        base = manifest.generate()["runs"]
        for part in manifest.P6_PARTS:
            want = Counter((r["cell"].replace("|cc-sonnet", "|codex"), bool(r.get("control")))
                           for r in base if r["stage"] == part)
            got = Counter((r["cell"], bool(r.get("control"))) for r in runs if r["part"] == part)
            self.assertEqual(got, want, part)

    def test_p1_part_keeps_rounds_and_paraphrase_slots(self):
        p1 = [r for r in manifest.generate_p6()["runs"] if r["part"] == "P1"]
        by_round = defaultdict(list)
        for r in p1:
            by_round[r["round"]].append(r["cell"])
        self.assertEqual(sorted(by_round), list(range(1, 11)))
        self.assertTrue(all(len(set(c)) == len(c) == 6 for c in by_round.values()))   # one replicate of each cell
        claude = {(r["cell"].replace("|cc-sonnet", "|codex"), r["replicate"]): r["paraphrase"]
                  for r in manifest.generate()["runs"] if r["stage"] == "P1"}
        self.assertEqual({(r["cell"], r["replicate"]): r["paraphrase"] for r in p1}, claude)

    def test_sidecar_is_not_a_frozen_file(self):
        self.assertNotIn(f"results/real/{manifest.P6_NAME}", prereg.frozen_files(paths.REPO))


class P6SidecarFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-p6-"))
        self.env = os.environ.get("AVG_RESULTS_ROOT")
        os.environ["AVG_RESULTS_ROOT"] = str(self.tmp)
        self.base = manifest.generate(ns="mock")
        jsonio.write_json_atomic(paths.manifest_path("mock"), self.base)

    def tearDown(self):
        if self.env is None:
            os.environ.pop("AVG_RESULTS_ROOT", None)
        else:
            os.environ["AVG_RESULTS_ROOT"] = self.env
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_write_once_and_load_merges(self):
        before = manifest.sha256(paths.manifest_path("mock"))
        self.assertEqual(Counter(r["stage"] for r in manifest.load("mock")["runs"])["P6"], 0)
        out, m = manifest.write_p6("mock")
        self.assertEqual(out, paths.manifest_path("mock").with_name("manifest-p6.json"))
        self.assertEqual(manifest.sha256(paths.manifest_path("mock")), before)       # manifest.json untouched
        merged = manifest.load("mock")
        self.assertEqual(merged["runs"][:len(self.base["runs"])], self.base["runs"])
        self.assertEqual(Counter(r["stage"] for r in merged["runs"])["P6"], 121)
        self.assertEqual(merged["p6_sidecar"]["sha256"], manifest.sha256(out))
        self.assertEqual(manifest.validate(merged), [])
        with self.assertRaisesRegex(RuntimeError, "exists"):
            manifest.write_p6("mock")
        manifest.write_p6("mock", force=True)                                    # nothing started yet
        state = runner.load_state("mock", merged)
        self.assertEqual(state["p6_manifest_sha256"], manifest.sha256(out))
        state["runs"]["p6-0003"] = {"status": "done"}
        jsonio.write_json_atomic(paths.state_path("mock"), state)
        with self.assertRaisesRegex(RuntimeError, "have started"):
            manifest.write_p6("mock", force=True)

    def test_refusals(self):
        with self.assertRaisesRegex(RuntimeError, "seed"):
            manifest.write_p6("mock", seed=1)
        jsonio.write_json_atomic(paths.manifest_path("mock"), manifest.generate(ns="mock", with_p6=True))
        with self.assertRaisesRegex(RuntimeError, "already holds the P6 runs"):
            manifest.write_p6("mock")

    def test_runner_part_dry_run(self):
        manifest.write_p6("mock")
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(runner.main(["--ns", "mock", "--stage", "P6", "--part", "P1", "--dry-run"]), 0)
        lines = out.getvalue().splitlines()
        self.assertIn("60 run(s) would run (60 pending in P6, namespace mock)", lines[-1])
        p1_ids = {r["run_id"] for r in manifest.load("mock")["runs"] if r.get("part") == "P1"}
        self.assertEqual({l.split()[0] for l in lines[:-1]}, p1_ids)
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(runner.main(["--ns", "mock", "--stage", "P1", "--part", "P1", "--dry-run"]),
                             runner.EXIT_GUARD)
        self.assertIn("only to --stage P6", err.getvalue())


if __name__ == "__main__":
    unittest.main()
