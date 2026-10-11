"""Run Control plugin (spec §22.2) through HTTP. The runner is never started: runner_ctl.launch_runner is mocked, and the
"runner alive" cases use this test process's own PID. Guards, confirmations, blinding and roles are exercised."""
import contextlib
import io
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from console.core import runner_ctl
from console.tests.helpers import ConsoleFixture
from harness import manifest as manifest_mod
from harness import paths, runner
from harness.jsonio import read_json, write_json_atomic

PLUGINS = ("run-control",)
MARK = "OUTCOME-MARKER-should-never-leak"


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def seed(results, ns="mock", p1_done=3, p0_done=5, runner_state=None, workers=None, unblind=()):
    """Manifest from the real generator; P0 done p0_done, P1 done p1_done (records carry MARK as outcome)."""
    m = manifest_mod.generate(20261011, ns)
    nsd = results / ns
    write_json_atomic(nsd / "manifest.json", m)
    runs = {}
    p0 = [r["run_id"] for r in m["runs"] if r["stage"] == "P0"]
    p1 = [r["run_id"] for r in m["runs"] if r["stage"] == "P1"]
    base = datetime(2026, 10, 11, 9, 0, tzinfo=timezone.utc)
    for r in m["runs"]:
        runs[r["run_id"]] = {"status": "pending"}
    for i, rid in enumerate(p0[:p0_done] + p1[:p1_done]):
        runs[rid] = {"status": "done", "attempts": 1, "worker": 1, "started_at": iso(base + timedelta(minutes=i)),
                     "ended_at": iso(base + timedelta(minutes=i, seconds=50))}
        stage = "P0" if rid.startswith("p0") else "P1"
        write_json_atomic(nsd / "runs" / rid / "record.json", {
            "run_id": rid, "stage": stage, "ticket": "X-rename", "cell": "X-rename|V0|S0|W1|mock", "outcome": MARK,
            "ticket_done": "done", "metrics": {"staging_break": True}, "duration_ms": 50000,
            "totals": {"turns": 7, "input_tokens": 1000, "output_tokens": 200}})
    state = {"schema": "state/1", "namespace": ns, "runs": runs,
             "runner": runner_state or {"pid": None, "status": "idle"}, "workers": workers or {},
             "unblinded": {s: {"at": iso(base), "forced": False, "by": "t"} for s in unblind},
             "usage": {"P0": {"runs": p0_done, "input_tokens": 5000, "output_tokens": 800, "cache_read_tokens": 20000,
                              "cache_creation_tokens": 1000, "minutes": 4.5},
                       "P1": {"runs": p1_done, "input_tokens": 3000, "output_tokens": 500, "cache_read_tokens": 9000,
                              "cache_creation_tokens": 700, "minutes": 2.5}},
            "updated_at": iso(base)}
    write_json_atomic(nsd / "state.json", state)
    return m


def running_state(stage="P1", done=1, planned=4, workers=2, **extra):
    now = datetime.now(timezone.utc)
    r = {"pid": os.getpid(), "status": "running", "started_at": iso(now - timedelta(minutes=3)), "stage": stage,
         "unit": "mock", "workers": workers, "batch": {"max_runs": planned, "max_minutes": None, "done": done, "planned": planned},
         "rate_limited_until": None, "sleep_prevented": True, "heartbeat_at": iso(now), "message": None}
    r.update(extra)
    return r


class StagesTest(unittest.TestCase):
    def test_cards_counts_and_blinding(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            d = fx.owner.get("/api/run-control/stages?ns=mock").json
            self.assertEqual([c["stage"] for c in d["stages"]], ["P0", "X1", "P1", "P2", "P3", "P4", "P5", "P6"])
            by = {c["stage"]: c for c in d["stages"]}
            self.assertEqual((by["P0"]["done"], by["P0"]["total"], by["P0"]["status"], by["P0"]["blinding"]), (5, 5, "complete", "visible"))
            self.assertEqual((by["P1"]["done"], by["P1"]["total"], by["P1"]["status"], by["P1"]["blinding"]), (3, 40, "in_progress", "blinded"))
            self.assertEqual(by["P2"]["status"], "pending")
            self.assertEqual(by["P3"]["status"], "not_in_manifest")
            self.assertFalse(by["P3"]["runnable"])
            self.assertEqual((by["X1"]["total"], by["X1"]["blinding"], by["X1"]["runnable"], by["X1"]["name"]),
                             (40, "visible", True, "Pilot X1 · exploratory"))
            self.assertEqual((by["P0"]["minutes"], by["P1"]["tokens"]), (4.5, 13200))
            self.assertEqual(len(by["P1"]["cells"]), 4)
            self.assertEqual(sum(c["done"] for c in by["P1"]["cells"]), 3)
            # outcomes: visible stage yes, blinded stage never
            self.assertEqual(by["P0"]["outcomes"], {MARK: 5})
            self.assertIsNone(by["P1"]["outcomes"])
            self.assertEqual(by["P1"]["outcomes_note"], "Blinded until stage complete")
            self.assertTrue(all(c["outcomes"] is None for c in by["P1"]["cells"]))
            self.assertNotIn(MARK, json.dumps(by["P1"]))
            self.assertEqual(d["workers_notice"], "Parallel runs don't add quota; they spend it faster")

    def test_complete_stage_stays_blinded_until_unblinded(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, p1_done=40)
            p1 = next(c for c in fx.owner.get("/api/run-control/stages?ns=mock").json["stages"] if c["stage"] == "P1")
            self.assertEqual((p1["status"], p1["blinding"], p1["outcomes"]), ("complete", "blinded", None))
            seed(fx.results, p1_done=40, unblind=("P1",))
            p1 = next(c for c in fx.owner.get("/api/run-control/stages?ns=mock").json["stages"] if c["stage"] == "P1")
            self.assertEqual((p1["blinding"], p1["outcomes"]), ("unblinded", {MARK: 40}))

    def test_guards_per_namespace(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, "mock")
            seed(fx.results, "real", p0_done=0, p1_done=0)
            real = {c["stage"]: c for c in fx.owner.get("/api/run-control/stages?ns=real").json["stages"]}
            codes = lambda c: [r["code"] for r in c["guard"]["reasons"]]  # noqa: E731
            with mock.patch("harness.prereg.lock_info", return_value=None):
                real = {c["stage"]: c for c in fx.owner.get("/api/run-control/stages?ns=real").json["stages"]}
                self.assertEqual(codes(real["P0"]), ["smoke"])
                self.assertEqual(codes(real["P1"]), ["smoke", "prereg"])
                self.assertTrue(real["P1"]["guard"]["blocked"])
            write_json_atomic(fx.results / "smoke.json", {"ok": True})
            with mock.patch("harness.prereg.lock_info", return_value=None):
                real = {c["stage"]: c for c in fx.owner.get("/api/run-control/stages?ns=real").json["stages"]}
                self.assertEqual(codes(real["P0"]), [])
                self.assertEqual(codes(real["P1"]), ["prereg"])
            with mock.patch("harness.prereg.lock_info", return_value={"short": "abc"}):
                real = {c["stage"]: c for c in fx.owner.get("/api/run-control/stages?ns=real").json["stages"]}
                self.assertEqual(codes(real["P1"]), [])
            mock_ = {c["stage"]: c for c in fx.owner.get("/api/run-control/stages?ns=mock").json["stages"]}
            self.assertTrue(all(not c["guard"]["blocked"] for c in mock_.values()))      # MOCK has no guards

    def test_smoke_not_ok_blocks(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, "real", p0_done=0, p1_done=0)
            write_json_atomic(fx.results / "smoke.json", {"ok": False})
            p0 = next(c for c in fx.owner.get("/api/run-control/stages?ns=real").json["stages"] if c["stage"] == "P0")
            self.assertEqual([r["code"] for r in p0["guard"]["reasons"]], ["smoke"])


class StatusTest(unittest.TestCase):
    def test_idle(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            d = fx.owner.get("/api/run-control/status?ns=mock").json
            self.assertFalse(d["alive"])
            self.assertFalse(d["sleep_prevented"])
            self.assertEqual(d["runner"]["status"], "idle")
            self.assertEqual(len(d["workers"]), 1)
            self.assertEqual(d["queue"], [])
            self.assertIsNone(d["rate_limit"])
            self.assertEqual(d["finished"][0]["run_id"], "p1-0003")           # newest first
            self.assertNotIn(MARK, json.dumps([f for f in d["finished"] if f["stage"] == "P1"]))
            self.assertEqual(next(f for f in d["finished"] if f["stage"] == "P0")["outcome"], MARK)

    def test_reconnects_to_a_live_runner(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            m = seed(fx.results, runner_state=running_state(), workers={
                "1": {"run_id": "p1-0004", "ticket": "X-remove", "cell": "X-remove|V0|S2|W1|mock", "attempt": "fix1",
                      "started_at": iso(datetime.now(timezone.utc) - timedelta(seconds=75)), "turns": 5, "tokens": 12345},
                "2": None})
            d = fx.owner.get("/api/run-control/status?ns=mock").json
            self.assertTrue(d["alive"])
            self.assertEqual(d["runner"]["status"], "running")
            self.assertTrue(d["sleep_prevented"])
            self.assertEqual(len(d["workers"]), 2)
            w1, w2 = d["workers"]
            self.assertEqual((w1["run"]["run_id"], w1["run"]["attempt"], w1["run"]["turns"], w1["run"]["tokens"]),
                             ("p1-0004", "fix1", 5, 12345))
            self.assertIsNone(w2["run"])
            # planned 4, done 1, one in flight → 2 left; the queue never lists the running run
            p1 = [r["run_id"] for r in m["runs"] if r["stage"] == "P1"]
            self.assertEqual([q["run_id"] for q in d["queue"]], p1[4:6])
            self.assertEqual(next(c for c in fx.owner.get("/api/run-control/stages?ns=mock").json["stages"] if c["stage"] == "P1")["status"], "running")

    def test_dead_runner_pid_is_not_running(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, runner_state=running_state(pid=2 ** 22 + 12345), workers={"1": {"run_id": "p1-0004", "ticket": "t", "cell": "c"}})
            d = fx.owner.get("/api/run-control/status?ns=mock").json
            self.assertFalse(d["alive"])
            self.assertEqual(d["runner"]["status"], "stopped")
            self.assertTrue(all(w["run"] is None for w in d["workers"]))
            self.assertFalse(d["sleep_prevented"])

    def test_rate_limit_strip(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            until = iso(datetime.now(timezone.utc) + timedelta(hours=2))
            seed(fx.results, runner_state={"pid": None, "status": "rate_limited", "stage": "P1", "unit": "mock", "workers": 1,
                                           "batch": {"max_runs": 8, "max_minutes": None, "done": 3, "planned": 8},
                                           "rate_limited_until": until})
            rl = fx.owner.get("/api/run-control/status?ns=mock").json["rate_limit"]
            self.assertTrue(rl["limited"])
            self.assertEqual(rl["until"], until)
            self.assertIsNone(rl["scheduled_at"])


class LogTest(unittest.TestCase):
    def test_log_is_read_incrementally_and_sanitized(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            data = fx.tmp / "data"
            (data / "logs").mkdir(parents=True, exist_ok=True)
            log = data / "logs" / "runner-mock-1.log"
            log.write_text("=== spawn\np0-0001  started  X-rename V0·S0·W1  worker 1\n", encoding="utf-8")
            write_json_atomic(data / "runner-launch.json", {"mock": {"pid": 1, "at": "2026-10-11T00:00:00+00:00",
                                                                   "args": ["--stage", "P0"], "log": "logs/runner-mock-1.log"}})
            d = fx.owner.get("/api/run-control/log?ns=mock").json
            self.assertTrue(d["reset"])
            self.assertIn("p0-0001  started", d["text"])
            self.assertEqual(d["offset"], log.stat().st_size)
            self.assertFalse(d["alive"])
            with open(log, "a", encoding="utf-8") as f:
                f.write("  p0-0001 [gen] Read C:\\Users\\someone\\x.ts\n")
            d2 = fx.owner.get(f"/api/run-control/log?ns=mock&offset={d['offset']}").json
            self.assertFalse(d2["reset"])
            self.assertTrue(d2["text"].startswith("  p0-0001 [gen] Read"))
            self.assertNotIn("someone", d2["text"])                          # the core scrubs user paths
            d3 = fx.owner.get("/api/run-control/log?ns=mock&offset=999999").json
            self.assertTrue(d3["reset"])                                    # stale offset: start again
            self.assertEqual(fx.client("v1", "viewer").get("/api/run-control/log?ns=mock").status, 403)

    def test_no_launch_yet(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            d = fx.owner.get("/api/run-control/log?ns=mock").json
            self.assertIsNone(d["log"])
            self.assertEqual(d["text"], "")


class DryRunStartTest(unittest.TestCase):
    def test_dry_run_matches_the_runners_own_dry_run(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, p1_done=3)
            p = fx.owner.post("/api/run-control/dry-run?ns=mock", {"stage": "P1", "batch": 5, "workers": 2}).json
            self.assertEqual(p["args"], ["--stage", "P1", "--ns", "mock", "--unit", "mock", "--workers", "2", "--batch", "5"])
            self.assertEqual((p["count"], p["pending"]), (5, 37))
            self.assertTrue(p["would_start"])
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = runner.main(p["args"] + ["--dry-run"])        # the real argparse: the flags are exactly right
            self.assertEqual(rc, 0)
            lines = buf.getvalue().strip().splitlines()
            self.assertEqual([ln.split()[0] for ln in lines[:-1]], [r["run_id"] for r in p["runs"]])
            self.assertTrue(lines[-1].startswith("5 run(s) would run (37 pending in P1, namespace mock)"))
            self.assertIn("Command: python -m harness.runner --stage P1", p["summary"][-1])

    def test_every_built_command_parses_with_the_runners_argparse(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            for body in ({"stage": "P1", "batch": 3}, {"stage": "P2", "max_minutes": 12.5, "workers": 3},
                         {"calibrate": True}, {"stage": "P4", "batch": 2, "max_minutes": 5}):
                p = fx.owner.post("/api/run-control/dry-run?ns=mock", body).json
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    self.assertEqual(runner.main(p["args"] + ["--dry-run"]), 0, p["args"])

    def test_calibrate_args(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, p0_done=0)
            p = fx.owner.post("/api/run-control/dry-run?ns=mock", {"calibrate": True, "batch": 99}).json
            self.assertEqual(p["args"], ["--calibrate", "--ns", "mock", "--unit", "mock", "--workers", "1"])
            self.assertEqual(p["stage"], "P0")
            self.assertEqual(p["count"], 5)

    def test_validation(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            post = lambda b, ns="mock": fx.owner.post(f"/api/run-control/dry-run?ns={ns}", b)  # noqa: E731
            self.assertEqual(post({"stage": "P3", "batch": 1}).status, 400)
            self.assertEqual(post({"stage": "P1; rm", "batch": 1}).status, 400)
            self.assertEqual(post({"stage": "P1", "batch": 0}).status, 400)
            self.assertEqual(post({"stage": "P1", "batch": 1.5}).status, 400)
            self.assertEqual(post({"stage": "P1", "batch": True}).status, 400)
            self.assertEqual(post({"stage": "P1", "batch": 5000}).status, 400)
            self.assertEqual(post({"stage": "P1", "max_minutes": -3}).status, 400)
            self.assertEqual(post({"stage": "P1", "batch": 1, "workers": 4}).status, 400)
            self.assertEqual(post({"stage": "P1", "batch": 1, "workers": 0}).status, 400)
            self.assertEqual(post({"stage": "P1", "batch": 1, "unit": "--evil"}, "real").status, 400)
            self.assertEqual(post({"stage": "P1"}, "real").status, 400)      # a real batch needs a limit
            self.assertEqual(post({"stage": "P1"}).status, 200)             # mock without a limit runs the stage

    def test_start_launches_the_runner_and_audits(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            with mock.patch.object(runner_ctl, "launch_runner", return_value=4321) as launch:
                r = fx.owner.post("/api/run-control/start?ns=mock", {"stage": "P1", "batch": 6, "workers": 2})
                self.assertEqual(r.status, 200, r.text)
                self.assertEqual(r.json["pid"], 4321)
                ns, args, user = launch.call_args.args
                self.assertEqual(ns, "mock")
                self.assertEqual(args, ["--stage", "P1", "--ns", "mock", "--unit", "mock", "--workers", "2", "--batch", "6"])
                self.assertEqual(user["username"], "owner1")
            self.assertEqual(read_json(fx.app.data_dir / "run-control" / "settings.json")["mock"]["workers"], 2)
            entries = fx.app.audit.query(action="run_control.start")
            self.assertEqual(len(entries), 1)
            self.assertEqual(entries[0]["user"], "owner1")
            self.assertEqual(entries[0]["plugin"], "run-control")
            self.assertEqual(entries[0]["detail"]["args"][:2], ["--stage", "P1"])
            self.assertEqual(entries[0]["detail"]["pid"], 4321)

    def test_every_action_is_audited(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, runner_state=running_state())
            fx.owner.post("/api/run-control/workers?ns=mock", {"workers": 2})
            fx.owner.post("/api/run-control/stop?ns=mock", {})
            seed(fx.results, runner_state={"pid": None, "status": "rate_limited", "stage": "P1", "unit": "mock", "workers": 1,
                                           "batch": {"max_runs": 4, "max_minutes": None, "done": 0, "planned": 4}})
            fx.owner.post("/api/run-control/dry-run?ns=mock", {"stage": "P1", "batch": 1})
            self.assertEqual(fx.owner.post("/api/run-control/resume-at?ns=mock", {"at": "23:15"}).status, 200)
            fx.owner.post("/api/run-control/resume-at?ns=mock", {"cancel": True})
            seen = {e["action"] for e in fx.app.audit.query(action="run_control.")}
            self.assertEqual(seen, {"run_control.workers", "run_control.stop", "run_control.dry_run",
                                    "run_control.resume_at", "run_control.resume_cancel"})

    def test_preview_launches_nothing(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            with mock.patch.object(runner_ctl, "launch_runner") as launch:
                p = fx.owner.post("/api/run-control/start?ns=mock", {"stage": "P1", "batch": 6, "preview": True}).json
                launch.assert_not_called()
            self.assertEqual(p["count"], 6)
            self.assertTrue(p["summary"])

    def test_start_refused_while_a_runner_is_alive_or_nothing_pending(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, runner_state=running_state())
            with mock.patch.object(runner_ctl, "launch_runner") as launch:
                r = fx.owner.post("/api/run-control/start?ns=mock", {"stage": "P1", "batch": 2})
                self.assertEqual(r.status, 409)
                self.assertIn("already running", r.json["error"])
                launch.assert_not_called()
            seed(fx.results, p0_done=5)
            r = fx.owner.post("/api/run-control/start?ns=mock", {"stage": "P0", "batch": 2})
            self.assertEqual(r.status, 409)
            self.assertIn("Nothing pending", r.json["error"])

    def test_stale_control_file_is_removed_before_launch(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            write_json_atomic(paths.control_path("mock"), {"stop_after_current": True})
            with mock.patch.object(runner_ctl, "launch_runner", return_value=1):
                self.assertEqual(fx.owner.post("/api/run-control/start?ns=mock", {"stage": "P1", "batch": 1}).status, 200)
            self.assertFalse(paths.control_path("mock").exists())


class RealNamespaceGuardsTest(unittest.TestCase):
    """Guards live in the API: calling it directly cannot get around them."""

    def body(self, **kw):
        return dict({"stage": "P1", "batch": 2, "confirmed": True}, **kw)

    def test_real_start_needs_smoke_and_lock(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, "real", p0_done=0, p1_done=0)
            with mock.patch.object(runner_ctl, "launch_runner", return_value=7) as launch, \
                    mock.patch("harness.prereg.lock_info", return_value=None):
                r = fx.owner.post("/api/run-control/start?ns=real", self.body())
                self.assertEqual(r.status, 409)
                self.assertIn("smoke", r.json["error"].lower())
                write_json_atomic(fx.results / "smoke.json", {"ok": True})
                r = fx.owner.post("/api/run-control/start?ns=real", self.body())
                self.assertEqual(r.status, 409)
                self.assertIn("Pre-registration lock missing", r.json["error"])
                launch.assert_not_called()
            with mock.patch.object(runner_ctl, "launch_runner", return_value=7) as launch, \
                    mock.patch("harness.prereg.lock_info", return_value={"short": "abc"}), \
                    mock.patch("harness.prereg.verify", return_value=(False, ["changed: PREREGISTRATION.md"])):
                r = fx.owner.post("/api/run-control/start?ns=real", self.body())
                self.assertEqual(r.status, 409)
                self.assertIn("does not match", r.json["error"])
                launch.assert_not_called()
            with mock.patch.object(runner_ctl, "launch_runner", return_value=7) as launch, \
                    mock.patch("harness.prereg.lock_info", return_value={"short": "abc"}), \
                    mock.patch("harness.prereg.verify", return_value=(True, [])):
                r = fx.owner.post("/api/run-control/start?ns=real", self.body())
                self.assertEqual(r.status, 200, r.text)
                self.assertEqual(launch.call_args.args[0], "real")
                self.assertEqual(launch.call_args.args[1], ["--stage", "P1", "--ns", "real", "--workers", "1", "--batch", "2"])

    def test_p0_needs_only_the_smoke_test(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, "real", p0_done=0, p1_done=0)
            with mock.patch.object(runner_ctl, "launch_runner", return_value=7) as launch, \
                    mock.patch("harness.prereg.lock_info", return_value=None):
                r = fx.owner.post("/api/run-control/start?ns=real", {"calibrate": True, "confirmed": True})
                self.assertEqual(r.status, 409)
                write_json_atomic(fx.results / "smoke.json", {"ok": True})
                r = fx.owner.post("/api/run-control/start?ns=real", {"calibrate": True, "confirmed": True})
                self.assertEqual(r.status, 200, r.text)
                self.assertEqual(launch.call_args.args[1], ["--calibrate", "--ns", "real", "--workers", "1"])

    def test_real_actions_need_confirmation(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, "real", p0_done=0, p1_done=0)
            write_json_atomic(fx.results / "smoke.json", {"ok": True})
            with mock.patch.object(runner_ctl, "launch_runner", return_value=7) as launch, \
                    mock.patch("harness.prereg.lock_info", return_value={"short": "abc"}), \
                    mock.patch("harness.prereg.verify", return_value=(True, [])):
                r = fx.owner.post("/api/run-control/start?ns=real", {"stage": "P1", "batch": 2})
                self.assertEqual(r.status, 400)
                self.assertIn("Confirmation", r.json["error"])
                launch.assert_not_called()

    def test_real_dry_run_reports_blocking_without_launching(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, "real", p0_done=0, p1_done=0)
            with mock.patch("harness.prereg.lock_info", return_value=None):
                p = fx.owner.post("/api/run-control/dry-run?ns=real", {"stage": "P1", "batch": 3}).json
            self.assertFalse(p["would_start"])
            self.assertEqual({b["code"] for b in p["blocking"]}, {"smoke", "prereg"})
            self.assertEqual(p["count"], 3)

    def test_real_without_manifest(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            write_json_atomic(fx.results / "smoke.json", {"ok": True})
            p = fx.owner.post("/api/run-control/dry-run?ns=real", {"calibrate": True}).json
            self.assertIn("manifest", {b["code"] for b in p["blocking"]})


class StopWorkersResumeTest(unittest.TestCase):
    def test_stop_writes_control_json_only_when_alive(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            r = fx.owner.post("/api/run-control/stop?ns=mock", {})
            self.assertEqual(r.status, 409)
            self.assertFalse(paths.control_path("mock").exists())
            seed(fx.results, runner_state=running_state())
            r = fx.owner.post("/api/run-control/stop?ns=mock", {})
            self.assertEqual(r.status, 200, r.text)
            self.assertTrue(read_json(paths.control_path("mock"))["stop_after_current"])
            self.assertTrue(fx.owner.get("/api/run-control/status?ns=mock").json["stop_requested"])

    def test_real_stop_needs_confirmation(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, "real", runner_state=running_state())
            self.assertEqual(fx.owner.post("/api/run-control/stop?ns=real", {}).status, 400)
            self.assertFalse(paths.control_path("real").exists())
            self.assertEqual(fx.owner.post("/api/run-control/stop?ns=real", {"confirmed": True}).status, 200)

    def test_workers_setting(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            self.assertEqual(fx.owner.get("/api/run-control/status?ns=mock").json["settings"]["workers"], 1)
            for bad in (0, 4, "x", None, 2.5, True):
                self.assertEqual(fx.owner.post("/api/run-control/workers?ns=mock", {"workers": bad}).status, 400, bad)
            r = fx.owner.post("/api/run-control/workers?ns=mock", {"workers": 3})
            self.assertEqual(r.json["settings"]["workers"], 3)
            self.assertIn("spend it faster", r.json["notice"])
            self.assertEqual(fx.owner.get("/api/run-control/stages?ns=mock").json["settings"]["workers"], 3)
            self.assertEqual(fx.owner.get("/api/run-control/stages?ns=real").json["settings"]["workers"], 1)   # per namespace
            p = fx.owner.post("/api/run-control/dry-run?ns=mock", {"stage": "P1", "batch": 1}).json
            self.assertEqual(p["workers"], 3)

    def test_resume_schedule_and_cancel(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            until = datetime.now(timezone.utc) + timedelta(hours=3)
            seed(fx.results, runner_state={"pid": None, "status": "rate_limited", "stage": "P1", "unit": "mock", "workers": 2,
                                           "batch": {"max_runs": 8, "max_minutes": None, "done": 3, "planned": 8},
                                           "rate_limited_until": iso(until)})
            fx.app.users  # app is up; runner_ctl was configured with this data dir
            pre = fx.owner.post("/api/run-control/resume-at?ns=mock", {"preview": True}).json
            self.assertEqual(datetime.fromisoformat(pre["at"]), until.replace(microsecond=0))
            self.assertEqual(pre["at_local"], until.astimezone().strftime("%H:%M"))
            self.assertEqual(pre["args"], ["--stage", "P1", "--ns", "mock", "--unit", "mock", "--workers", "2", "--batch", "5"])
            self.assertIsNone(runner_ctl.scheduled("mock"))                       # preview schedules nothing
            r = fx.owner.post("/api/run-control/resume-at?ns=mock", {})
            self.assertEqual(r.status, 200, r.text)
            self.assertEqual(runner_ctl.scheduled("mock")["args"], pre["args"])
            rl = fx.owner.get("/api/run-control/status?ns=mock").json["rate_limit"]
            self.assertEqual(datetime.fromisoformat(rl["scheduled_at"]), until.replace(microsecond=0))
            self.assertTrue(fx.owner.post("/api/run-control/resume-at?ns=mock", {"cancel": True}).json["cancelled"])
            self.assertIsNone(runner_ctl.scheduled("mock"))

    def test_resume_time_formats(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, runner_state={"pid": None, "status": "rate_limited", "stage": "P1", "unit": "mock", "workers": 1,
                                           "batch": {"max_runs": 4, "max_minutes": None, "done": 0, "planned": 4}})
            r = fx.owner.post("/api/run-control/resume-at?ns=mock", {"preview": True})
            self.assertEqual(r.status, 400)                                       # no reset time known, none given
            r = fx.owner.post("/api/run-control/resume-at?ns=mock", {"preview": True, "at": "23:15"})
            self.assertEqual(r.status, 200, r.text)
            self.assertEqual(r.json["at_local"], "23:15")
            self.assertGreater(datetime.fromisoformat(r.json["at"].replace("Z", "+00:00")), datetime.now(timezone.utc))
            for bad in ("25:00", "12:61", "tomorrow", 5):
                self.assertEqual(fx.owner.post("/api/run-control/resume-at?ns=mock", {"preview": True, "at": bad}).status, 400, bad)

    def test_resume_blocked_by_guards_in_real(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, "real", p0_done=0, p1_done=0, runner_state={
                "pid": None, "status": "rate_limited", "stage": "P1", "workers": 1,
                "batch": {"max_runs": 4, "max_minutes": None, "done": 0, "planned": 4},
                "rate_limited_until": iso(datetime.now(timezone.utc) + timedelta(hours=1))})
            r = fx.owner.post("/api/run-control/resume-at?ns=real", {"confirmed": True})
            self.assertEqual(r.status, 409)
            self.assertIsNone(runner_ctl.scheduled("real"))


class UnblindTest(unittest.TestCase):
    def test_owner_unblinds_a_complete_stage(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, p1_done=40)
            op = fx.client("op1", "operator")
            self.assertEqual(op.post("/api/run-control/unblind?ns=mock", {"stage": "P1", "confirm": "UNBLIND P1"}).status, 403)
            self.assertEqual(fx.owner.post("/api/run-control/unblind?ns=mock", {"stage": "P1", "confirm": "yes"}).status, 400)
            self.assertEqual(fx.owner.post("/api/run-control/unblind?ns=mock", {"stage": "P0", "confirm": "UNBLIND P0"}).status, 400)
            r = fx.owner.post("/api/run-control/unblind?ns=mock", {"stage": "P1", "confirm": "UNBLIND P1"})
            self.assertEqual(r.status, 200, r.text)
            st = read_json(paths.state_path("mock"))
            self.assertEqual(st["unblinded"]["P1"]["by"], "owner1")
            self.assertFalse(st["unblinded"]["P1"]["forced"])
            self.assertEqual(fx.owner.post("/api/run-control/unblind?ns=mock", {"stage": "P1", "confirm": "UNBLIND P1"}).status, 409)

    def test_incomplete_stage_and_live_runner_refuse(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results, p1_done=39)
            r = fx.owner.post("/api/run-control/unblind?ns=mock", {"stage": "P1", "confirm": "UNBLIND P1"})
            self.assertEqual(r.status, 409)
            self.assertIsNone(read_json(paths.state_path("mock"))["unblinded"].get("P1"))
            seed(fx.results, p1_done=40, runner_state=running_state())
            self.assertEqual(fx.owner.post("/api/run-control/unblind?ns=mock", {"stage": "P1", "confirm": "UNBLIND P1"}).status, 409)


class RolesTest(unittest.TestCase):
    def test_manifest_excludes_viewer_and_presenter(self):
        from console.core.server import PLUGINS_DIR
        m = json.loads((PLUGINS_DIR / "run-control" / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(m["roles"], ["owner", "operator"])
        self.assertNotIn("viewer", m["roles"])
        self.assertNotIn("presenter", m["roles"])

    def test_viewer_and_presenter_get_403_everywhere(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            for who, role in (("vic", "viewer"), ("pat", "presenter")):
                c = fx.client(who, role)
                for path in ("stages", "status"):
                    self.assertEqual(c.get(f"/api/run-control/{path}?ns=mock").status, 403, f"{role} GET {path}")
                for path, body in (("dry-run", {"stage": "P1", "batch": 1}), ("start", {"stage": "P1", "batch": 1}), ("stop", {}),
                                   ("workers", {"workers": 2}), ("resume-at", {}), ("unblind", {"stage": "P1"})):
                    with mock.patch.object(runner_ctl, "launch_runner") as launch:
                        self.assertEqual(c.post(f"/api/run-control/{path}?ns=mock", body).status, 403, f"{role} POST {path}")
                        launch.assert_not_called()
            self.assertFalse(paths.control_path("mock").exists())

    def test_operator_can_run_but_not_unblind(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed(fx.results)
            op = fx.client("op2", "operator")
            self.assertEqual(op.get("/api/run-control/stages?ns=mock").status, 200)
            with mock.patch.object(runner_ctl, "launch_runner", return_value=9):
                self.assertEqual(op.post("/api/run-control/start?ns=mock", {"stage": "P1", "batch": 1}).status, 200)
            self.assertEqual(op.post("/api/run-control/unblind?ns=mock", {"stage": "P1", "confirm": "UNBLIND P1"}).status, 403)


if __name__ == "__main__":
    unittest.main()
