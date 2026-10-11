import io
import json
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from trace import validate

EXAMPLES = Path(__file__).resolve().parent.parent / "trace" / "examples"


class TraceExamplesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(EXAMPLES / "expected.json", encoding="utf-8") as f:
            cls.expected = json.load(f)

    def test_package_is_ours_not_stdlib(self):
        self.assertTrue(Path(validate.__file__).resolve().is_relative_to(EXAMPLES.parent))

    def test_valid_examples(self):
        for name in self.expected["valid"]:
            with self.subTest(name=name):
                self.assertEqual(validate.validate_file(EXAMPLES / name), [])

    def test_invalid_examples_exact(self):
        self.assertGreaterEqual(len(self.expected["invalid"]), 8)
        rules = set()
        for name, exp in self.expected["invalid"].items():
            with self.subTest(name=name):
                got = {(v["rule"], v["seq"]) for v in validate.validate_file(EXAMPLES / name)}
                self.assertEqual(got, {(e["rule"], e["seq"]) for e in exp})
                rules |= {e["rule"] for e in exp}
        self.assertTrue({9, 10, 11, 12, 13} <= rules)

    def test_every_example_file_is_listed(self):
        listed = set(self.expected["valid"]) | set(self.expected["invalid"])
        self.assertEqual({p.name for p in EXAMPLES.glob("*.jsonl")}, listed)


class RuleUnitTest(unittest.TestCase):
    def _load(self, name):
        with open(EXAMPLES / name, encoding="utf-8") as f:
            return [json.loads(l) for l in f if l.strip()]

    def test_bad_json_line_reported_without_seq(self):
        p = Path(self._tmp()) / "bad.jsonl"
        p.write_text((EXAMPLES / "valid-minimal.jsonl").read_text(encoding="utf-8") + "{not json\n", encoding="utf-8")
        viol = validate.validate_file(p)
        self.assertTrue(any(v["seq"] is None and "line 13" in v["message"] for v in viol))

    def test_timestamp_without_zone(self):
        evs = self._load("valid-minimal.jsonl")
        evs[2]["timestamp"] = "2026-10-11T09:00:02"
        self.assertIn((2, 2), {(v["rule"], v["seq"]) for v in validate.validate_events(evs)})

    def test_artifact_version_must_step_by_one(self):
        evs = self._load("valid-m1-selftest.jsonl")
        upd = next(e for e in evs if e["event_type"] == "ARTIFACT_UPDATED")
        upd["payload"]["version"] = 3
        self.assertIn((5, upd["seq"]), {(v["rule"], v["seq"]) for v in validate.validate_events(evs)})

    def test_policy_human_must_be_simulated(self):
        evs = self._load("valid-spec-example-2.1.jsonl")
        dec = next(e for e in evs if e["event_type"] == "APPROVAL_DECIDED")
        dec["metadata"] = {"policy": "auto-approve-if-ci-green"}
        self.assertIn((13, dec["seq"]), {(v["rule"], v["seq"]) for v in validate.validate_events(evs)})

    def test_self_review_forbidden(self):
        evs = self._load("valid-spec-example-2.1.jsonl")
        rev = next(e for e in evs if e["event_type"] == "REVIEW_SUBMITTED" and e["actor"]["actor_id"] == "rev-01")
        rev["actor"] = {"actor_id": "code-01", "actor_type": "agent", "role": "code_agent"}
        self.assertIn((8, rev["seq"]), {(v["rule"], v["seq"]) for v in validate.validate_events(evs)})

    def test_cli_exit_codes(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(validate.main([str(EXAMPLES / "valid-minimal.jsonl")]), 0)
            self.assertEqual(validate.main([str(EXAMPLES / "invalid-rule11-gate-touched-by-ci.jsonl")]), 1)
        out = buf.getvalue()
        self.assertIn("VALID 12 events", out)
        self.assertIn("seq=10 rule=11", out)

    def _tmp(self):
        import tempfile
        d = tempfile.mkdtemp(prefix="avg-trace-")
        self.addCleanup(__import__("shutil").rmtree, d, True)
        return d


if __name__ == "__main__":
    unittest.main()
