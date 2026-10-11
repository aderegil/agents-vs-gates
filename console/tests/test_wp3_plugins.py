"""The Overview, Readiness and Users plugins of WP3, through HTTP. ctx.spawn is always mocked: these tests never run
the smoke test, the freeze, the doctor or the runner."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from console.core import experiment
from console.tests.helpers import PW, ConsoleFixture
from harness import paths
from harness.jsonio import write_json_atomic

PLUGINS = ("overview", "readiness", "users")


def seed_mock(results: Path, unblind: bool = False):
    ns = results / "mock"
    runs = []
    for i in range(1, 6):
        runs.append({"run_id": f"p0-{i:04d}", "stage": "P0", "unit": "mock", "ticket": "X-rename", "wording": "W1",
                     "visibility": "V0", "spec": "S0", "replicate": i, "round": i, "cell": "X-rename|V0|S0|W1|mock"})
    for i in range(1, 11):
        runs.append({"run_id": f"p1-{i:04d}", "stage": "P1", "unit": "mock", "ticket": "X-rename", "wording": "W1",
                     "visibility": "V0", "spec": "S0", "replicate": i, "round": i, "cell": "X-rename|V0|S0|W1|mock"})
    write_json_atomic(ns / "manifest.json", {"schema": "manifest/1", "seed": 1, "namespace": "mock",
                                             "generated_at": "2026-10-11T00:00:00Z", "runs": runs})
    st_runs = {r["run_id"]: {"status": "done" if r["run_id"] <= "p1-0007" or r["stage"] == "P0" else "pending",
                             "infra_failures": 1 if r["run_id"] == "p1-0002" else 0} for r in runs}
    state = {"schema": "state/1", "namespace": "mock", "runs": st_runs,
             "runner": {"pid": None, "status": "idle"}, "workers": {},
             "unblinded": {"P1": {"at": "2026-10-11T10:00:00Z", "forced": True, "by": "t"}} if unblind else {},
             "usage": {"P1": {"input_tokens": 1000, "output_tokens": 500, "minutes": 3.5}}, "updated_at": "2026-10-11T10:00:00Z"}
    write_json_atomic(ns / "state.json", state)
    for i in range(1, 8):
        rid = f"p1-{i:04d}"
        write_json_atomic(ns / "runs" / rid / "record.json", {
            "run_id": rid, "stage": "P1", "outcome": "fixed_code", "ticket_done": "done" if i <= 6 else "not_done",
            "metrics": {"staging_break": i <= 4, "consumer_break_ci": i <= 2}})


class OverviewTest(unittest.TestCase):
    def test_blinded_then_unblinded(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_mock(fx.results)
            d = fx.owner.get("/api/overview?ns=mock").json
            p1 = next(s for s in d["stages"] if s["stage"] == "P1")
            self.assertEqual((p1["done"], p1["total"], p1["blinding"], p1["infra_events"]), (7, 10, "blinded", 1))
            self.assertEqual(next(s for s in d["stages"] if s["stage"] == "P0")["blinding"], "visible")
            self.assertEqual(d["headlines"], [])
            self.assertNotIn("fixed_code", json.dumps(d))
            self.assertEqual(d["counts"]["mock"]["done"], 12)
            self.assertIn(d["next"]["text"], ("Run the smoke test", "Review the failed smoke test"))
            self.assertEqual(d["smoke"]["status"], "not_run")

            seed_mock(fx.results, unblind=True)
            d = fx.owner.get("/api/overview?ns=mock").json
            texts = [h["text"] for h in d["headlines"]]
            self.assertIn("4 of 7 PRs broke a deployed consumer (staging oracle)", texts)
            self.assertIn("6 of 7 runs completed the ticket", texts)
            self.assertFalse(any("%" in t for t in texts))

    def test_visible_to_viewer(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            self.assertEqual(fx.client("vic", "viewer").get("/api/overview").status, 200)

    def test_next_action_rules(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            write_json_atomic(fx.results / "smoke.json", {"ok": True, "at": "x", "checks": []})
            d = fx.owner.get("/api/overview").json
            self.assertEqual(d["smoke"]["status"], "passed")
            self.assertTrue(d["next"]["text"].startswith("Generate the run manifest"))
            write_json_atomic(fx.results / "real" / "state.json", {"runner": {"status": "rate_limited",
                                                                              "rate_limited_until": "2026-10-11T14:05:00Z"}, "runs": {}})
            d = fx.owner.get("/api/overview").json
            self.assertTrue(d["next"]["text"].startswith("Usage limit reached"))
            self.assertEqual(d["last_quota_event"]["until"], "2026-10-11T14:05:00Z")


class ReadinessTest(unittest.TestCase):
    def setUp(self):
        self.fx = ConsoleFixture(copy_real=PLUGINS).__enter__()
        self.plugin = self.fx.app.by_id["readiness"]
        self.mod = sys.modules["avg_plugin_readiness"]
        self.spawn = mock.Mock(return_value=4242)
        self.plugin.ctx.spawn = self.spawn
        self.op = self.fx.client("opal", "operator")

    def tearDown(self):
        self.fx.__exit__(None, None, None)

    def test_smoke_requires_owner_typed_confirmation_and_is_audited(self):
        o = self.fx.owner
        d = o.get("/api/readiness/smoke").json
        self.assertEqual(len(d["calls"]), 5)
        self.assertEqual(d["confirm_text"], "RUN SMOKE")
        self.assertEqual(self.op.get("/api/readiness/smoke").json["can_run"], False)
        self.assertEqual(self.op.post("/api/readiness/smoke", {"confirm": "RUN SMOKE"}).status, 403)
        self.assertEqual(o.post("/api/readiness/smoke", {"confirm": "run smoke"}).status, 400)
        with mock.patch.object(self.mod, "module_available", return_value=False):
            self.assertEqual(o.post("/api/readiness/smoke", {"confirm": "RUN SMOKE"}).status, 409)
        self.spawn.assert_not_called()
        with mock.patch.object(self.mod, "module_available", return_value=True), \
                mock.patch("console.core.runner_ctl.pid_alive", return_value=False):
            r = o.post("/api/readiness/smoke", {"confirm": "RUN SMOKE"})
        self.assertEqual(r.status, 200, r.text)
        argv = self.spawn.call_args[0][0]
        self.assertIn("harness.smoke", argv)
        self.assertIn("--i-am-authorized", argv)
        self.assertEqual(o.get("/api/audit?action=smoke.run").json["entries"][0]["user"], "owner1")

    def test_freeze_blocked_until_p0_and_never_spawned_in_tests(self):
        d = self.fx.owner.get("/api/readiness/lock").json
        self.assertFalse(d["can_freeze"])
        self.assertTrue(any("P0" in b for b in d["freeze_blockers"]))
        r = self.fx.owner.post("/api/readiness/freeze", {"confirm": "FREEZE"})
        self.assertEqual(r.status, 409)
        self.assertEqual(self.fx.owner.post("/api/readiness/freeze", {}).status, 400)
        self.assertEqual(self.op.post("/api/readiness/freeze", {"confirm": "FREEZE"}).status, 403)
        self.spawn.assert_not_called()

    def test_freeze_spawns_when_allowed(self):
        with mock.patch.object(self.mod, "module_available", return_value=True), \
                mock.patch.object(experiment, "p0_complete", return_value=True), \
                mock.patch.object(experiment, "prereg_status", return_value={"frozen": False, "files": []}), \
                mock.patch("console.core.runner_ctl.pid_alive", return_value=False):
            r = self.fx.owner.post("/api/readiness/freeze", {"confirm": "FREEZE"})
        self.assertEqual(r.status, 200, r.text)
        self.assertIn("--freeze", self.spawn.call_args[0][0])
        self.assertEqual(self.fx.owner.get("/api/audit?action=prereg.freeze").json["total"], 1)

    def test_lock_parsing(self):
        with tempfile.TemporaryDirectory() as t:
            repo = Path(t)
            (repo / "a.md").write_text("A", encoding="utf-8")
            (repo / "b.md").write_text("B", encoding="utf-8")
            lock = repo / "PREREGISTRATION.lock"
            lock.write_text(json.dumps({"schema": "prereg-lock/1", "frozen_at": "2026-10-20T10:00:00+00:00",
                                        "aggregate_sha256": "abcdef0123456789" * 4,
                                        "files": {"a.md": experiment.sha256_file(repo / "a.md"), "b.md": "0" * 64,
                                                  "c.md": "1" * 64}}), encoding="utf-8")
            with mock.patch.object(paths, "PREREG_LOCK", lock), mock.patch.object(paths, "REPO", repo):
                s = experiment.prereg_status()
        self.assertTrue(s["frozen"])
        self.assertEqual(s["short_hash"], "abcdef012345")
        self.assertEqual({f["path"]: f["status"] for f in s["files"]}, {"a.md": "same", "b.md": "changed", "c.md": "missing"})

    def test_units_editor(self):
        with tempfile.TemporaryDirectory() as t:
            units = Path(t) / "units.json"
            units.write_text(paths.UNITS.read_text(encoding="utf-8"), encoding="utf-8")
            with mock.patch.object(paths, "UNITS", units), mock.patch.object(paths, "PREREG_LOCK", Path(t) / "nolock"):
                o = self.fx.owner
                self.assertTrue(o.get("/api/readiness/units").json["editable"])
                self.assertFalse(self.op.get("/api/readiness/units").json["editable"])
                r = o.post("/api/readiness/units", {"units": {"cc-sonnet": {"model": "claude-sonnet-x-1", "effort": "high"}}})
                self.assertEqual(r.status, 200, r.text)
                saved = json.loads(units.read_text(encoding="utf-8"))
                self.assertEqual((saved["cc-sonnet"]["model"], saved["cc-sonnet"]["effort"]), ("claude-sonnet-x-1", "high"))
                self.assertEqual(saved["mock"], {"adapter": "mock"})
                self.assertEqual(o.post("/api/readiness/units", {"units": {"cc-sonnet": {"effort": "turbo"}}}).status, 400)
                self.assertEqual(o.post("/api/readiness/units", {"units": {"cc-sonnet": {"adapter": "x"}}}).status, 400)
                self.assertEqual(o.post("/api/readiness/units", {"units": {"mock": {"model": "x"}}}).status, 400)
                self.assertEqual(o.post("/api/readiness/units", {"units": {"nope": {"model": "x"}}}).status, 400)
                self.assertEqual(self.op.post("/api/readiness/units", {"units": {"cc-sonnet": {"effort": "low"}}}).status, 403)
                audit = o.get("/api/audit?action=units.update").json["entries"]
                self.assertEqual(audit[0]["detail"]["changes"]["cc-sonnet"]["effort"], ["medium", "high"])
            lock = Path(t) / "PREREGISTRATION.lock"
            lock.write_text("{}", encoding="utf-8")
            with mock.patch.object(paths, "UNITS", units), mock.patch.object(paths, "PREREG_LOCK", lock):
                self.assertTrue(self.fx.owner.get("/api/readiness/units").json["locked"])
                self.assertEqual(self.fx.owner.post("/api/readiness/units", {"units": {"cc-sonnet": {"effort": "low"}}}).status, 409)

    def test_token_never_returns_the_value(self):
        secret = "sk-ant-oat01-" + "Z" * 40
        with tempfile.TemporaryDirectory() as t:
            env = Path(t) / ".env"
            env.write_text(f"CLAUDE_CODE_OAUTH_TOKEN={secret}\n", encoding="utf-8")
            with mock.patch.object(paths, "env_file", return_value=env):
                r = self.fx.owner.get("/api/readiness/token")
        self.assertTrue(r.json["has_token"])
        self.assertNotIn(secret, r.text)
        self.assertNotIn("ZZZZ", r.text)

    def test_checklist(self):
        with tempfile.TemporaryDirectory() as t:
            md = Path(t) / "REVIEW-CHECKLIST.md"
            md.write_text("# Review\n## Scenario\n- [ ] canonical orders-service leaks no hints\n- [x] canaries placed\n"
                          "## Texts\n- [ ] tickets approved\n", encoding="utf-8")
            with mock.patch.object(experiment, "checklist_path", return_value=md):
                d = self.fx.owner.get("/api/readiness/checklist").json
                self.assertEqual((d["exists"], d["total"], d["done"]), (True, 3, 1))
                self.assertEqual(d["items"][0]["section"], "Scenario")
                iid = d["items"][0]["id"]
                self.assertEqual(self.op.post("/api/readiness/checklist", {"id": iid, "checked": True}).status, 403)
                r = self.fx.owner.post("/api/readiness/checklist", {"id": iid, "checked": True})
                self.assertEqual(r.status, 200, r.text)
                item = next(i for i in r.json["items"] if i["id"] == iid)
                self.assertEqual((item["checked"], item["by"]), (True, "owner1"))
                self.assertEqual(self.fx.owner.post("/api/readiness/checklist", {"id": "nope", "checked": True}).status, 404)
            with mock.patch.object(experiment, "checklist_path", return_value=Path(t) / "missing.md"):
                self.assertEqual(self.fx.owner.get("/api/readiness/checklist").json["exists"], False)

    def test_doctor_unavailable_degrades(self):
        with mock.patch.object(self.mod, "module_available", return_value=False):
            r = self.fx.owner.get("/api/readiness/doctor")
        self.assertEqual((r.status, r.json["available"]), (200, False))

    def test_viewer_has_no_access(self):
        self.assertEqual(self.fx.client("vic", "viewer").get("/api/readiness/token").status, 403)


class UsersTest(unittest.TestCase):
    def test_user_management_rules(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            o = fx.owner
            r = o.post("/api/users", {"username": "Ana", "role": "operator", "password": PW})
            self.assertEqual((r.status, r.json["user"]["username"]), (200, "ana"))
            self.assertEqual(o.post("/api/users", {"username": "ana", "role": "viewer", "password": PW}).status, 409)
            self.assertEqual(o.post("/api/users", {"username": "bo", "role": "god", "password": PW}).status, 400)
            self.assertEqual(o.post("/api/users", {"username": "bo", "role": "viewer", "password": "short"}).status, 400)
            listing = o.get("/api/users").json
            self.assertNotIn("hash", json.dumps(listing))
            self.assertNotIn("salt", json.dumps(listing))
            self.assertEqual(o.post("/api/users/owner1/role", {"role": "viewer"}).status, 409)   # self
            self.assertEqual(o.post("/api/users/owner1/disable", {}).status, 409)                # self
            ana = fx.client()
            self.assertEqual(ana.login("ana", PW).status, 200)
            self.assertEqual(ana.get("/api/users").status, 403)                                   # operator
            self.assertEqual(o.post("/api/users/ana/role", {"role": "presenter"}).status, 200)
            self.assertEqual(o.post("/api/users/ana/password", {"password": "fresh-Password-9"}).status, 200)
            self.assertEqual(ana.get("/api/plugins").status, 401)                                 # sessions ended
            self.assertEqual(ana.login("ana", "fresh-Password-9").status, 200)
            self.assertEqual(o.post("/api/users/ana/disable", {}).status, 200)
            self.assertEqual(ana.get("/api/plugins").status, 401)
            self.assertEqual(fx.client().login("ana", "fresh-Password-9").status, 401)
            self.assertEqual(o.post("/api/users/ana/enable", {}).status, 200)
            self.assertEqual(o.post("/api/users/ghost/disable", {}).status, 404)
            # second owner: the first may then be demoted by the second, but never the last one
            o.post("/api/users", {"username": "zoe", "role": "owner", "password": PW})
            zoe = fx.client()
            zoe.login("zoe", PW)
            self.assertEqual(zoe.post("/api/users/owner1/disable", {}).status, 200)
            self.assertEqual(len(fx.app.users.active_owners()), 1)
            actions = {e["action"] for e in zoe.get("/api/audit").json["entries"]}
            for a in ("users.create", "users.role", "users.password_reset", "users.disable", "users.enable", "login"):
                self.assertIn(a, actions)


if __name__ == "__main__":
    unittest.main()
