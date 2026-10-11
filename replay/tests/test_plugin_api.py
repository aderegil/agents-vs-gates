"""Tests for replay/service.py and the Replay Theater plugin API (console/plugins/replay/api.py), with a fake Request
and a temporary results root (AVG_RESULTS_ROOT), so they run before the console shell exists."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import jsonschema

from replay import service

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "replay" / "fixtures"
SCHEMA = json.loads((REPO / "docs" / "contracts" / "replay.schema.json").read_text(encoding="utf-8"))
PLUGIN = REPO / "console" / "plugins" / "replay"


def load_api():
    spec = importlib.util.spec_from_file_location("avg_replay_plugin_api", PLUGIN / "api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeRequest:
    def __init__(self, ns="mock", params=None, query=None):
        self.method = "GET"
        self.path = ""
        self.ns = ns
        self.params = params or {}
        self.query = query or {}
        self.json = None
        self.body = b""
        self.user = {"username": "viewer1", "role": "viewer"}


class FakeRouter:
    def __init__(self):
        self.routes = {}

    def get(self, path, fn, roles=None):
        self.routes[("GET", path)] = fn

    def post(self, path, fn, roles=None):
        self.routes[("POST", path)] = fn


def retag(src: Path, dst: Path, run_id: str, stage: str, source: str = "mock") -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with open(src, encoding="utf-8") as f, open(dst, "w", encoding="utf-8", newline="\n") as g:
        for line in f:
            e = json.loads(line)
            e["session_id"] = e["run_id"] = run_id
            if e["event_type"] == "SESSION_STARTED":
                e["metadata"] = dict(e["metadata"], run_id=run_id, stage=stage, source=source)
            g.write(json.dumps(e, ensure_ascii=False) + "\n")


class PluginApi(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="avg-replay-"))
        self._old = os.environ.get("AVG_RESULTS_ROOT")
        os.environ["AVG_RESULTS_ROOT"] = str(self.tmp)
        runs = self.tmp / "mock" / "runs"
        # selftest run (always visible), trace only
        (runs / "st-0001").mkdir(parents=True)
        shutil.copyfile(FIXTURES / "m1-xrename-v0s0-break-repair.jsonl", runs / "st-0001" / "events.jsonl")
        # P1 run with a record.json (blinded until unblinded)
        retag(FIXTURES / "m1-xunits-v0s0-oracle.jsonl", runs / "p1-0001" / "events.jsonl", "p1-0001", "P1")
        record = json.loads((REPO / "docs" / "contracts" / "examples" / "record.json").read_text(encoding="utf-8"))
        record.update(run_id="p1-0001", stage="P1", ticket="X-units", outcome="passed_first_ci")
        (runs / "p1-0001" / "record.json").write_text(json.dumps(record), encoding="utf-8")
        # a run folder without a trace is not listed
        (runs / "p1-0002").mkdir()
        (self.tmp / "mock" / "state.json").write_text(json.dumps({"runs": {}, "unblinded": {}}), encoding="utf-8")
        self.api = load_api()
        self.router = FakeRouter()
        self.api.register(self.router, ctx=None)

    def tearDown(self):
        if self._old is None:
            os.environ.pop("AVG_RESULTS_ROOT", None)
        else:
            os.environ["AVG_RESULTS_ROOT"] = self._old
        shutil.rmtree(self.tmp, ignore_errors=True)

    def call(self, path, **kw):
        return self.router.routes[("GET", path)](FakeRequest(**kw))

    def test_routes_registered(self):
        self.assertEqual(set(self.router.routes), {("GET", "/list"), ("GET", "/run/{run_id}"), ("POST", "/export")})

    def test_list_respects_blinding(self):
        body = self.call("/list")
        self.assertEqual(body["ns"], "mock")
        runs = {r["run_id"]: r for r in body["runs"]}
        self.assertEqual(set(runs), {"st-0001", "p1-0001"})
        st = runs["st-0001"]
        self.assertEqual((st["stage"], st["ticket"], st["source"], st["date"]), ("selftest", "X-rename", "mock", "2026-10-11"))
        self.assertEqual(st["condition"], {"V": "V0", "S": "S0", "W": "W1"})
        self.assertFalse(st["blinded"])
        p1 = runs["p1-0001"]
        self.assertTrue(p1["blinded"])
        self.assertIsNone(p1["outcome"])
        # unblind P1 -> outcome appears
        (self.tmp / "mock" / "state.json").write_text(json.dumps({"unblinded": {"P1": {"at": "x"}}}), encoding="utf-8")
        p1 = {r["run_id"]: r for r in self.call("/list")["runs"]}["p1-0001"]
        self.assertEqual(p1["outcome"], "passed_first_ci")
        self.assertFalse(p1["blinded"])

    def test_run_builds_validates_and_caches(self):
        r = self.call("/run/{run_id}", params={"run_id": "st-0001"})
        jsonschema.validate(r, SCHEMA)
        cache = self.tmp / "mock" / "runs" / "st-0001" / "replay.json"
        self.assertTrue(cache.is_file())
        self.assertEqual(json.loads(cache.read_text(encoding="utf-8"))["meta"]["trace_sha256"], r["meta"]["trace_sha256"])
        # a stale cache (different sha) is rebuilt
        stale = json.loads(cache.read_text(encoding="utf-8"))
        stale["meta"]["trace_sha256"] = "0" * 64
        stale["steps"] = []
        cache.write_text(json.dumps(stale), encoding="utf-8")
        again = self.call("/run/{run_id}", params={"run_id": "st-0001"})
        self.assertTrue(again["steps"])
        # a valid cache is served as is
        marked = json.loads(cache.read_text(encoding="utf-8"))
        marked["meta"]["from_cache"] = True
        cache.write_text(json.dumps(marked), encoding="utf-8")
        self.assertTrue(self.call("/run/{run_id}", params={"run_id": "st-0001"})["meta"].get("from_cache"))

    def test_run_errors(self):
        for run_id, status in (("p1-0002", 404), ("nope", 404), ("../x", 404), ("p1-0001", 403)):
            with self.subTest(run_id=run_id):
                with self.assertRaises(self.api.ApiError) as cm:
                    self.call("/run/{run_id}", params={"run_id": run_id})
                self.assertEqual(getattr(cm.exception, "status", None), status)
        with self.assertRaises(self.api.ApiError) as cm:
            self.call("/list", ns="prod")
        self.assertEqual(cm.exception.status, 400)

    def _finish(self, run_id: str, stage: str, ns: str = "mock", fixture: str = "m1-xrename-v0s2-additive.jsonl"):
        d = self.tmp / ns / "runs" / run_id
        retag(FIXTURES / fixture, d / "events.jsonl", run_id, stage, source="mock" if ns == "mock" else "real")
        record = {"run_id": run_id, "stage": stage, "namespace": ns, "ticket": "X-rename", "visibility": "V0",
                  "spec": "S2", "wording": "W1", "out_of_scope_edits": []}
        (d / "record.json").write_text(json.dumps(record), encoding="utf-8")
        return d

    def test_export_new_runs_writes_only_visible_finished_runs(self):
        # st-0001 has no record.json (not finished); p1-0001 is blinded; x1-0001 (pilot, visible) is finished
        x1 = self._finish("x1-0001", "X1")
        p1 = self.tmp / "mock" / "runs" / "p1-0001"
        res = self.router.routes[("POST", "/export")](FakeRequest())
        self.assertEqual(res["exported"], ["x1-0001"])
        self.assertEqual(res["unfinished"], ["st-0001"])
        self.assertEqual(res["skipped_blinded"], 1)
        self.assertEqual(res["errors"], {})
        self.assertTrue((x1 / "replay.json").is_file())
        self.assertFalse((p1 / "replay.json").exists(), "a blinded run is never exported")
        replay = json.loads((x1 / "replay.json").read_text(encoding="utf-8"))
        jsonschema.validate(replay, SCHEMA)
        self.assertEqual(replay["scene"]["spec"], "S2")
        # second call: nothing new; a record change makes it stale and it is re-exported
        res = self.router.routes[("POST", "/export")](FakeRequest())
        self.assertEqual((res["exported"], res["fresh"]), ([], ["x1-0001"]))
        rec = json.loads((x1 / "record.json").read_text(encoding="utf-8"))
        rec["visibility"] = "V2"
        (x1 / "record.json").write_text(json.dumps(rec), encoding="utf-8")
        res = self.router.routes[("POST", "/export")](FakeRequest())
        self.assertEqual(res["exported"], ["x1-0001"])
        self.assertEqual(json.loads((x1 / "replay.json").read_text(encoding="utf-8"))["scene"]["visibility"], "V2")

    def test_export_real_namespace_and_listing_flags(self):
        self._finish("p0-0001", "P0", ns="real")
        lst = {r["run_id"]: r for r in self.call("/list", ns="real")["runs"]}
        self.assertEqual(lst["p0-0001"]["source"], "real")
        self.assertTrue(lst["p0-0001"]["finished"])
        self.assertFalse(lst["p0-0001"]["cached"])
        res = self.router.routes[("POST", "/export")](FakeRequest(ns="real"))
        self.assertEqual(res["exported"], ["p0-0001"])
        self.assertTrue({r["run_id"]: r for r in self.call("/list", ns="real")["runs"]}["p0-0001"]["cached"])

    def test_real_namespace_is_separate(self):
        self.assertEqual(self.call("/list", ns="real")["runs"], [])
        with self.assertRaises(service.ReplayNotFound):
            service.load_run_replay("real", "st-0001")

    def test_plugin_manifest(self):
        manifest = json.loads((PLUGIN / "plugin.json").read_text(encoding="utf-8"))
        schema = json.loads((REPO / "docs" / "contracts" / "plugin.schema.json").read_text(encoding="utf-8"))
        jsonschema.validate(manifest, schema)
        self.assertEqual((manifest["id"], manifest["order"], manifest["kind"]), ("replay", 5, "iframe"))
        self.assertEqual(manifest["roles"], ["owner", "operator", "presenter", "viewer"])
        self.assertTrue((PLUGIN / manifest["entry"]).is_file(), "commit-ready dist must exist (npm run build)")


if __name__ == "__main__":
    unittest.main()
