"""Tests for replay/export.py (spec 22.5.1, 24). Run: python -m unittest discover (from the repo root)."""
from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import jsonschema

from replay import export as ex

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "replay" / "fixtures"
SCHEMA = json.loads((REPO / "docs" / "contracts" / "replay.schema.json").read_text(encoding="utf-8"))
TRACE_SCHEMA = json.loads((REPO / "trace" / "schema" / "simulation-log-event-2.1.0.json").read_text(encoding="utf-8"))
CONTRACT_EXAMPLE = REPO / "docs" / "contracts" / "examples" / "trace-m1-xrename-v0s0.jsonl"


def load(name: str) -> list[dict]:
    return ex.read_trace(FIXTURES / name)


def all_traces() -> dict[str, list[dict]]:
    out = {p.name: ex.read_trace(p) for p in sorted(FIXTURES.glob("*.jsonl"))}
    out["contract-example"] = ex.read_trace(CONTRACT_EXAMPLE)
    return out


class FixturesAreValidTraces(unittest.TestCase):
    def test_every_fixture_line_validates_against_trace_2_1(self):
        files = sorted(FIXTURES.glob("*.jsonl"))
        self.assertGreaterEqual(len(files), 4)
        for p in files:
            for ev in ex.read_trace(p):
                jsonschema.validate(ev, TRACE_SCHEMA)

    def test_break_repair_fixture_is_the_contract_example(self):
        self.assertEqual((FIXTURES / "m1-xrename-v0s0-break-repair.jsonl").read_bytes(), CONTRACT_EXAMPLE.read_bytes())


class BuildReplay(unittest.TestCase):
    def test_all_outputs_validate_against_contract(self):
        for name, events in all_traces().items():
            with self.subTest(trace=name):
                jsonschema.validate(ex.build_replay(events), SCHEMA)

    def test_pure_and_deterministic(self):
        events = load("m1-xremove-v1-gate.jsonl")
        before = copy.deepcopy(events)
        a = ex.build_replay(events)
        b = ex.build_replay(copy.deepcopy(events))
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))
        self.assertEqual(events, before, "build_replay must not mutate its input")

    def test_typical_run_lasts_40_to_90_seconds(self):
        for name, events in all_traces().items():
            with self.subTest(trace=name):
                d = ex.build_replay(events)["meta"]["duration_ms"]
                self.assertTrue(40_000 <= d <= 90_000, d)

    def test_meta_mock_legend_and_fields(self):
        r = ex.build_replay(load("m1-xrename-v0s0-break-repair.jsonl"))
        m = r["meta"]
        self.assertEqual(m["legend"], "SIMULATED (mock agent) — not a real run")
        self.assertEqual(m["source"], "mock")
        self.assertEqual((m["run_id"], m["unit"], m["ticket"], m["date"]), ("st-0001", "mock", "X-rename", "2026-10-11"))
        self.assertEqual(m["condition"], {"V": "V0", "S": "S0", "W": "W1"})
        self.assertEqual((m["outcome"], m["ticket_done"]), ("fixed_code", "done"))
        self.assertEqual(m["schema"], "replay/1")
        self.assertEqual(len(m["trace_sha256"]), 64)

    def test_real_source_legend(self):
        events = load("m1-xrename-v0s0-break-repair.jsonl")
        events[0]["metadata"] = dict(events[0]["metadata"], source="real", unit="cc-sonnet",
                                     model="claude-sonnet-4-5-20250929")
        r = ex.build_replay(events)
        self.assertEqual(r["meta"]["legend"], "Replay of a real run")
        agent = next(a for a in r["actors"] if a["id"] == "code-orders")
        self.assertEqual(agent["avatar"]["badge"], "Mock")  # roster model wins over metadata.model
        events[0]["payload"]["roster"][1].pop("model")
        agent = next(a for a in ex.build_replay(events)["actors"] if a["id"] == "code-orders")
        self.assertEqual(agent["avatar"]["badge"], "Sonnet")

    def test_actors_avatars_and_homes(self):
        r = ex.build_replay(load("m1-xrename-v0s0-break-repair.jsonl"))
        a = {x["id"]: x for x in r["actors"]}
        self.assertEqual(a["code-orders"]["avatar"], {"style": "agent", "seed": "code-orders", "badge": "Mock"})
        self.assertEqual(a["code-orders"]["home"], "desk-orders")
        self.assertEqual(a["ci"]["avatar"]["style"], "system")
        self.assertEqual(a["ci"]["home"], "ci-tower")
        self.assertEqual(a["staging"]["home"], "staging-bench")
        self.assertEqual(a["flow-engine"]["home"], "dispatch")
        self.assertEqual(a["architect"]["avatar"]["style"], "human")
        self.assertIsNone(a["architect"]["avatar"]["badge"])
        self.assertTrue(a["architect"]["simulated"])
        places = {p["id"]: p for p in r["places"]}
        for pid in ("product-desk", "planning-room", "desk-orders", "desk-billing", "desk-analytics", "desk-storefront",
                    "review-table", "ci-tower", "merge-gate", "staging-bench", "architecture-library"):
            self.assertIn(pid, places)
        self.assertEqual(places["staging-bench"]["note"], "hidden from the agent")
        self.assertEqual(places["desk-orders"]["label"], "Checkout · orders")

    def test_markers_break_repair(self):
        r = ex.build_replay(load("m1-xrename-v0s0-break-repair.jsonl"))
        kinds = [m["kind"] for m in r["markers"]]
        self.assertEqual(kinds, ["task_assigned", "pr_opened", "ci_fail", "repair", "ci_pass", "oracle", "oracle",
                                 "session_end"])
        labels = [m["label"] for m in r["markers"]]
        self.assertIn("CI failed: ARCH-4", labels)
        self.assertIn("Oracle (gen): 2 of 3 consumers fail", labels)
        self.assertEqual([m["t_ms"] for m in r["markers"]], sorted(m["t_ms"] for m in r["markers"]))

    def test_markers_gate_and_units(self):
        gate = ex.build_replay(load("m1-xremove-v1-gate.jsonl"))
        self.assertIn("gate_touched", [m["kind"] for m in gate["markers"]])
        step = next(s for s in gate["steps"] if s["action"] == "gate_touch")
        self.assertEqual(step["place"], "ci-tower")
        self.assertIn("contracts/consumers/analytics-ingest.json", step["text"])
        mv = [s for s in gate["steps"] if s["action"] == "move" and s["place"] == "ci-tower"]
        self.assertEqual(len(mv), 1, "the agent walks into the CI tower when it touches the gate")
        units = ex.build_replay(load("m1-xunits-v0s0-oracle.jsonl"))
        kinds = [m["kind"] for m in units["markers"]]
        self.assertIn("ci_pass", kinds)
        self.assertNotIn("ci_fail", kinds)
        bad = [s for s in units["steps"] if s["action"] == "oracle" and s["check"]["status"] == "fail"]
        self.assertTrue(bad and all(s["detail"]["contradicts_ci"] for s in bad))
        additive = ex.build_replay(load("m1-xrename-v0s2-additive.jsonl"))
        self.assertEqual([m["kind"] for m in additive["markers"]].count("ci_pass"), 1)

    def test_text_comes_from_the_trace(self):
        events = load("m1-xrename-v0s0-break-repair.jsonl")
        r = ex.build_replay(events)
        blob = json.dumps(events, ensure_ascii=False)
        by_seq = {e["seq"]: e for e in events}
        for s in r["steps"]:
            if not s.get("text") or s["action"] in ("move",):
                continue
            # each '·'-joined piece (and the oracle "consumer (state): message" pieces) is literal trace text
            pieces = [x.strip() for x in s["text"].replace("…", "").replace(" (gen): ", " · ")
                      .replace(" (final): ", " · ").split(" · ")]
            for piece in pieces:
                self.assertIn(json.dumps(piece, ensure_ascii=False)[1:-1][:80], blob, (s["seq"], piece))
            self.assertIn(s["seq"], by_seq)

    def test_check_step_carries_real_ci_output(self):
        r = ex.build_replay(load("m1-xrename-v0s0-break-repair.jsonl"))
        fail = next(s for s in r["steps"] if s["action"] == "check" and s.get("check", {}).get("status") == "fail")
        self.assertEqual(fail["check"], {"id": "ARCH-4", "status": "fail", "rule": "ARCH-4"})
        self.assertTrue(fail["text"].startswith("ARCH-4 FAIL billing-service: OrderPlaced.totalCents missing"))
        self.assertEqual(fail["place"], "ci-tower")

    def test_steps_are_ordered_and_timed(self):
        for name, events in all_traces().items():
            r = ex.build_replay(events)
            t = [s["t_ms"] for s in r["steps"]]
            self.assertEqual(t, sorted(t), name)
            self.assertEqual(r["steps"][0]["t_ms"], 0)
            for s in r["steps"]:
                self.assertLessEqual(s["t_ms"], s["t_real_ms"])

    def test_time_compression(self):
        self.assertEqual(ex.compress_times([0, 1000, 4000, 10_000, 13_001, 13_500]),
                         [0, 1000, 4000, 5500, 7000, 7499])
        self.assertEqual(ex.compress_times([5_000]), [0])

    def test_model_badge(self):
        self.assertEqual(ex.model_badge("claude-sonnet-4-5-20250929"), "Sonnet")
        self.assertEqual(ex.model_badge("claude-opus-4-1"), "Opus")
        self.assertEqual(ex.model_badge("mock"), "Mock")
        self.assertEqual(ex.model_badge("gpt-5-codex"), "Codex")
        self.assertIsNone(ex.model_badge(None))

    def test_rejects_trace_without_session_start(self):
        events = load("m1-xrename-v0s0-break-repair.jsonl")[1:]
        with self.assertRaises(ValueError):
            ex.build_replay(events)


class Cli(unittest.TestCase):
    def test_cli_writes_replay_json(self):
        with tempfile.TemporaryDirectory() as d:
            proc = subprocess.run([sys.executable, "-X", "utf8", "-m", "replay.export", str(CONTRACT_EXAMPLE),
                                   "--out", d], cwd=REPO, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            data = json.loads((Path(d) / "replay.json").read_text(encoding="utf-8"))
            jsonschema.validate(data, SCHEMA)
            self.assertEqual(data["meta"]["run_id"], "st-0001")

    def test_cli_missing_file(self):
        proc = subprocess.run([sys.executable, "-m", "replay.export", "nope.jsonl", "--out", "x"], cwd=REPO,
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
