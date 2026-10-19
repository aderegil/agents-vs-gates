"""Tests for the Teams & Avatars plugin (console/plugins/teams): data files and API handlers with a fake Request.
Lives here (WP5's test package) so `python -m unittest` from the repo root discovers it."""
from __future__ import annotations

import importlib.util
import json
import os
import unittest
from pathlib import Path

import jsonschema

REPO = Path(__file__).resolve().parents[2]
PLUGIN = REPO / "console" / "plugins" / "teams"
# the talk's working folder (not in this repo): cited fuentes/ sources are checked only when AVG_TALK_DIR points to it
FUENTES = Path(os.environ.get("AVG_TALK_DIR") or "__no_talk_folder__")
PHASES = ["discovery", "planning", "implementation", "review", "testing", "deployment", "maintenance"]
V21 = {"originator", "product_owner", "tech_lead", "engineer", "policy_owner", "code_owner", "release_manager",
       "supervisor", "researcher", "requirements_agent", "task_planner", "code_agent", "code_simplifier",
       "review_agent", "verifier", "devops_agent", "monitoring_agent", "architect", "ci", "staging", "flow_engine"}
TRACE_ACTORS = {"flow-engine", "code-orders", "ci", "staging", "architect"}


def load_api():
    spec = importlib.util.spec_from_file_location("avg_teams_plugin_api", PLUGIN / "api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Req:
    def __init__(self, **params):
        self.params = params
        self.query = {}
        self.ns = "mock"
        self.user = {"username": "v", "role": "viewer"}


class TeamsData(unittest.TestCase):
    def setUp(self):
        self.api = load_api()

    def test_five_models_in_order(self):
        ids = [m["id"] for m in self.api.load_all()]
        self.assertEqual(ids, ["anthropic", "aws", "kiro", "ai-sdlc-io", "agents-vs-gates"])

    def test_members_are_complete_and_sourced(self):
        seeds = set()
        for m in self.api.load_all():
            ids = set()
            self.assertTrue(m.get("gaps"), m["id"])
            for g in m["gaps"]:
                self.assertTrue(g["text"] and g["citation"]["file"], (m["id"], g))
            for x in m["members"]:
                with self.subTest(model=m["id"], member=x.get("id")):
                    for k in ("id", "role", "actor_type", "responsibility", "phase", "citation", "display_name", "seed"):
                        self.assertTrue(x.get(k), k)
                    self.assertIn(x["actor_type"], ("human", "agent", "system"))
                    self.assertIn(x["phase"], PHASES)
                    self.assertTrue(x["v21_role"] is None or x["v21_role"] in V21, x["v21_role"])
                    self.assertLessEqual(len(x["responsibility"]), 140)
                    self.assertTrue(x["citation"]["file"] and x["citation"]["section"])
                    self.assertNotIn(x["id"], ids)
                    self.assertNotIn(x["seed"], seeds)
                    ids.add(x["id"])
                    seeds.add(x["seed"])
                    if x["actor_type"] == "human":
                        self.assertIn(" · ", x["display_name"], "humans carry a short fictional name")
                    cited = x["citation"]["file"]
                    if cited.startswith("docs/"):
                        self.assertTrue((REPO / cited).is_file(), cited)
                    elif cited.startswith("fuentes/") and FUENTES.is_dir():
                        self.assertNotIn("restringido", cited)
                        # fuentes/ se movió a 2-produccion/investigacion/ (reorganización del 15 oct 2026)
                        local = FUENTES / "2-produccion" / "investigacion" / cited.removeprefix("fuentes/")
                        self.assertTrue(local.is_file(), cited)

    def test_ai_sdlc_io_label_and_trace_seeds(self):
        by_id = {m["id"]: m for m in self.api.load_all()}
        self.assertEqual(by_id["ai-sdlc-io"]["label"], "early-stage open-source project, not an industry standard")
        avg_seeds = {x["seed"] for x in by_id["agents-vs-gates"]["members"]}
        self.assertTrue(TRACE_ACTORS <= avg_seeds, "the experiment's model uses the trace actor ids as seeds")
        maya = next(x for x in by_id["agents-vs-gates"]["members"] if x["seed"] == "architect")
        self.assertEqual(maya["display_name"], "Maya · Architect")


class TeamsApi(unittest.TestCase):
    def setUp(self):
        self.api = load_api()
        self.routes = {}

        class Router:
            def get(_s, path, fn, roles=None):
                self.routes[path] = fn

        self.api.register(Router(), ctx=None)

    def test_routes(self):
        self.assertEqual(list(self.routes), ["", "/avatars", "/{model}"])

    def test_list_model_avatars(self):
        body = self.routes[""](Req())
        self.assertEqual(len(body["models"]), 5)
        self.assertEqual(body["phases"], PHASES)
        m = self.routes["/{model}"](Req(model="aws"))
        self.assertEqual(m["id"], "aws")
        self.assertEqual(len([x for x in m["members"] if x["actor_type"] == "agent"]), 14)
        av = self.routes["/avatars"](Req())["avatars"]
        self.assertEqual(len(av), sum(x["members"] for x in body["models"]))
        for a in av:
            self.assertEqual(a["avatar"]["style"], a["actor_type"])
            if a["actor_type"] != "agent":
                self.assertIsNone(a["avatar"]["badge"])

    def test_unknown_model_404(self):
        for bad in ("nope", "../replay/plugin", ""):
            with self.assertRaises(self.api.ApiError) as cm:
                self.routes["/{model}"](Req(model=bad))
            self.assertEqual(cm.exception.status, 404)

    def test_manifest_and_shared_avatar_module(self):
        manifest = json.loads((PLUGIN / "plugin.json").read_text(encoding="utf-8"))
        schema = json.loads((REPO / "docs" / "contracts" / "plugin.schema.json").read_text(encoding="utf-8"))
        jsonschema.validate(manifest, schema)
        self.assertEqual((manifest["id"], manifest["order"], manifest["kind"], manifest["entry"]),
                         ("teams", 7, "module", "web/index.js"))   # 7 since Start here took 0 (theater-1016)
        self.assertEqual(len(manifest["roles"]), 4)
        js = (PLUGIN / "web" / "avatar.js").read_text(encoding="utf-8")
        self.assertIn("renderAvatar", js)
        self.assertIn('import { renderAvatar } from "./avatar.js"', (PLUGIN / "web" / "index.js").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
