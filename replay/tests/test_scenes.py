"""The scripted AI-SDLC scenes (replay/scenes): valid traces, labelled illustrations, never runs."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from replay.scenes import make_scenes as ms

REPO = Path(__file__).resolve().parents[2]


class Scenes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.built = ms.build()

    def test_traces_valid_and_replays_match_the_schema(self):
        self.assertEqual(ms.check(self.built), [])

    def test_every_scene_is_labelled_an_illustration_with_its_source(self):
        for sc, rep in self.built:
            self.assertEqual(rep["meta"]["source"], "illustration", sc.sid)
            self.assertEqual(rep["meta"]["legend"], "Illustration · scripted from public documentation")
            ill = rep["scene"]["illustration"]
            for k in ("model", "source", "date", "stages", "rule", "blocks", "outcome"):
                self.assertIn(k, ill, sc.sid)
            self.assertTrue(rep["meta"]["illustration_source"])

    def test_same_feature_and_premise_everywhere_and_lengths(self):
        for sc, rep in self.built:
            texts = " ".join(str((e.get("visual") or {}).get("narration", "")) for e in sc.events)
            self.assertIn(ms.MISS, texts, sc.sid)
            self.assertTrue(40_000 <= rep["meta"]["duration_ms"] <= 80_000, (sc.sid, rep["meta"]["duration_ms"]))

    def test_only_the_gate_checks_architecture_in_ci(self):
        arch = {sc.sid: any(e["event_type"] == "CHECK_COMPLETED" and e["payload"].get("rule_id") for e in sc.events)
                for sc, _ in self.built}
        self.assertEqual({k for k, v in arch.items() if v}, {"aisdlc-gate"})

    def test_committed_files_are_current(self):
        for sc, rep in self.built:
            pub = ms.PUBLIC / f"{sc.sid}.json"
            self.assertEqual(json.loads(pub.read_text(encoding="utf-8")), rep, f"{pub} is stale: run make_scenes")

    def test_real_exports_unchanged_by_illustration_support(self):
        from replay import export as ex
        trace = ex.read_trace(REPO / "replay" / "fixtures" / "m1-xrename-v0s0-break-repair.jsonl")
        rep = ex.build_replay(trace)
        self.assertNotIn("illustration", rep["scene"])
        self.assertNotIn("illustration_source", rep["meta"])


if __name__ == "__main__":
    unittest.main()
