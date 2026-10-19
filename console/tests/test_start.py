"""Start here (the landing page): five short blocks in plain words, a line for every plugin, and a click path that
matches the real Replay Theater. Through HTTP like the other plugin tests; nothing runs an agent or a runner."""
import json
import re
import unittest

from console.core import labels as L
from console.core.server import PLUGINS_DIR
from console.tests.helpers import ConsoleFixture

WEB = PLUGINS_DIR.parent / "web"
REPLAY_APP = PLUGINS_DIR / "replay" / "app" / "src"

# Any experiment code: tickets, V/S/W, stages, H2/HS-V2, detectors, research questions, reviewer conditions, run ids.
CODE = re.compile(r"\bX-(?:rename|remove|add|api|dep|units)\b|(?<![\w-])(?:[VSW][0-2]|P[0-9]|C8|X[12]|H2|D[1-8]|T[1-3])"
                  r"(?![\w-])|\bHS-V2\b|\bR-(?:S0|S2|C)\b|\bRQ[1-7]\b|\b[pPxXcCsS][\dt]-\d{3,4}\b|\bARCH-\d\b")


def texts(d: dict) -> list[str]:
    out = [d["title"], d["subtitle"], *d["pages"].values()]
    for b in d["blocks"]:
        out += [b["title"], *b.get("text", []), *b.get("list", []), *b.get("after", []), *b.get("steps", [])]
        if b.get("link"):
            out.append(b["link"]["label"])
    return out


class StartHere(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifests = {d.name: json.loads((d / "plugin.json").read_text(encoding="utf-8"))
                         for d in PLUGINS_DIR.iterdir() if (d / "plugin.json").exists()}

    def test_served_to_every_role_in_words_only(self):
        with ConsoleFixture(copy_real=("start",)) as fx:
            d = fx.owner.get("/api/start").json
            v = fx.client("v1", "viewer").get("/api/start")
            self.assertEqual(v.status, 200)
            self.assertEqual(v.json, d)
        self.assertLessEqual(len(d["blocks"]), 5)
        for t in texts(d):
            self.assertIsNone(CODE.search(t), t)
            for word in re.findall(r"[A-Za-z]+", t):   # simple English: no long words
                self.assertLessEqual(len(word), 10, f"{word!r} in {t!r}")
            for sentence in re.split(r"(?<=[.?!:])\s+", t):
                self.assertLessEqual(len(sentence.split()), 25, sentence)

    def test_the_facts_match_the_experiment(self):
        from console.plugins.start import api  # noqa: F401  (plain import works: the folder has no hyphen)
        d = api.payload()
        what = next(b for b in d["blocks"] if b["id"] == "what")
        blob = " ".join(what["text"])
        self.assertIn("Meridian Retail, a made-up company", blob)
        self.assertIn("does a rule written in the spec stop a coding agent", blob)
        # the three main-test setups (PREREGISTRATION.md §6: V0·S0, V0·S2, V2·S0), in the map's order of meaning
        self.assertEqual(len(what["list"]), 3)
        self.assertIn("own code, and its spec has no rule", what["list"][0])
        self.assertIn("own code, and its spec has the rule", what["list"][1])
        self.assertIn("every team's code, and its spec has no rule", what["list"][2])
        self.assertIn("{own repo · no rule, own repo · rule in the spec, every repo visible · no rule}", L.STAGES["P1"]["long"])

    def test_a_line_for_every_plugin_and_start_is_the_landing_page(self):
        from console.plugins.start import api
        self.assertEqual(set(api.PAGES), set(self.manifests))
        start = self.manifests["start"]
        self.assertEqual(start["order"], min(m["order"] for m in self.manifests.values()))
        self.assertEqual(sorted(m["order"] for m in self.manifests.values()), list(range(len(self.manifests))))
        self.assertTrue(start["simple"])
        self.assertEqual(set(start["roles"]), {"owner", "operator", "presenter", "viewer"})
        app = (WEB / "app.js").read_text(encoding="utf-8")
        self.assertIn('const LANDING = "start";', app)

    def test_the_three_clicks_match_the_theater(self):
        from console.plugins.start import api
        steps = next(b for b in api.BLOCKS if b["id"] == "watch")["steps"]
        self.assertEqual(len(steps), 3)
        replay = self.manifests["replay"]
        self.assertIn(f"Click {replay['name']} in the bar on the left", steps[0])
        self.assertTrue(replay["simple"], "the Theater is in the left bar in Simple view too")
        self.assertIn('aria-label="Run to replay"', (REPLAY_APP / "App.tsx").read_text(encoding="utf-8"))
        self.assertIn(L.run_name("p1-0002"), steps[1])          # how the run list names p1-0002
        self.assertIn('"Play (Space)"', (REPLAY_APP / "components" / "Player.tsx").read_text(encoding="utf-8"))
        self.assertIn("Press Play, or the space bar", steps[2])


if __name__ == "__main__":
    unittest.main()
