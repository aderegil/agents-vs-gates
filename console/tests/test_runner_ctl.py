"""runner_ctl: stop request, scheduled resume, launch guard, PID checks. Never starts a real runner."""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from console.core import runner_ctl
from console.core.audit import AuditLog
from console.core.plugin_api import ApiError
from harness.jsonio import read_json, write_json_atomic

USER = {"username": "owner1", "role": "owner"}


class RunnerCtlTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root = Path(self.tmp.name)
        self.results = root / "results"
        (self.results / "mock").mkdir(parents=True)
        self.data = root / "data"
        self.data.mkdir()
        self.env = mock.patch.dict(os.environ, {"AVG_RESULTS_ROOT": str(self.results)})
        self.env.start()
        self.saved = dict(runner_ctl._cfg)
        self.audit = AuditLog(self.data / "audit.jsonl")
        runner_ctl.configure(data_dir=self.data, audit=self.audit, python="python-test")

    def tearDown(self):
        runner_ctl._cfg.clear()
        runner_ctl._cfg.update(self.saved)
        self.env.stop()
        self.tmp.cleanup()

    def test_pid_alive(self):
        self.assertTrue(runner_ctl.pid_alive(os.getpid()))  # this test runs under python
        self.assertFalse(runner_ctl.pid_alive(None))
        self.assertFalse(runner_ctl.pid_alive(0))
        self.assertFalse(runner_ctl.pid_alive(0x7FFFFFF0))

    def test_request_stop_writes_control(self):
        runner_ctl.request_stop("mock", USER)
        ctl = read_json(self.results / "mock" / "control.json")
        self.assertTrue(ctl["stop_after_current"])
        self.assertEqual(ctl["by"], "owner1")
        self.assertEqual(self.audit.query()[0]["action"], "runner.stop_requested")
        with self.assertRaises(ApiError):
            runner_ctl.request_stop("prod", USER)

    def test_runner_alive_from_state_pid(self):
        write_json_atomic(self.results / "mock" / "state.json", {"runner": {"pid": os.getpid(), "status": "running"}})
        self.assertTrue(runner_ctl.runner_alive("mock"))
        write_json_atomic(self.results / "mock" / "state.json", {"runner": {"pid": None, "status": "idle"}})
        self.assertFalse(runner_ctl.runner_alive("mock"))

    def test_launch_spawns_detached_and_refuses_when_alive(self):
        with mock.patch.object(runner_ctl, "spawn_detached", return_value=4321) as sp, \
                mock.patch.object(runner_ctl, "pid_alive", side_effect=lambda pid: pid == 4321):
            pid = runner_ctl.launch_runner("mock", ["--unit", "mock", "--stage", "P1", "--batch", "8"], USER)
            self.assertEqual(pid, 4321)
            argv = sp.call_args[0][0]
            self.assertEqual(argv[:5], ["python-test", "-X", "utf8", "-m", "harness.runner"])
            self.assertEqual(argv[5:], ["--unit", "mock", "--stage", "P1", "--batch", "8"])
            self.assertTrue(runner_ctl.runner_alive("mock"))  # trusted from the launch record during the grace period
            with self.assertRaises(ApiError) as cm:
                runner_ctl.launch_runner("mock", ["--unit", "mock"], USER)
            self.assertEqual(cm.exception.status, 409)
        self.assertEqual(self.audit.query(action="runner.launch")[0]["detail"]["pid"], 4321)

    def test_args_validated(self):
        for bad in ("--stage P1", [1, 2], [""], ["x"] * 41):
            with self.assertRaises(ApiError):
                runner_ctl.launch_runner("mock", bad, USER)

    def test_schedule_and_tick(self):
        write_json_atomic(self.results / "mock" / "state.json", {"runner": {"pid": None, "status": "rate_limited"}, "resume_at": None})
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        e = runner_ctl.schedule_resume("mock", future, ["--unit", "mock", "--stage", "P1"], USER)
        self.assertEqual(runner_ctl.scheduled("mock")["args"], ["--unit", "mock", "--stage", "P1"])
        self.assertEqual(read_json(self.results / "mock" / "state.json")["resume_at"], e["at"])
        with mock.patch.object(runner_ctl, "launch_runner", return_value=99) as lr:
            self.assertEqual(runner_ctl.scheduler_tick(), [])
            lr.assert_not_called()
            later = datetime.now(timezone.utc) + timedelta(hours=2)
            with mock.patch.object(runner_ctl, "runner_alive", return_value=False):
                done = runner_ctl.scheduler_tick(now=later)
            self.assertEqual(done, [{"ns": "mock", "pid": 99}])
            lr.assert_called_once()
            self.assertEqual(lr.call_args[0][:2], ("mock", ["--unit", "mock", "--stage", "P1"]))
        self.assertIsNone(runner_ctl.scheduled("mock"))
        self.assertIsNone(read_json(self.results / "mock" / "state.json")["resume_at"])

    def test_schedule_validation_and_cancel(self):
        with self.assertRaises(ApiError):
            runner_ctl.schedule_resume("mock", "tomorrow-ish", [], USER)
        with self.assertRaises(ApiError):
            runner_ctl.schedule_resume("mock", (datetime.now(timezone.utc) + timedelta(days=9)).isoformat(), [], USER)
        runner_ctl.schedule_resume("mock", (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(), [], USER)
        self.assertTrue(runner_ctl.cancel_resume("mock", USER))
        self.assertFalse(runner_ctl.cancel_resume("mock", USER))

    def test_status_reports_dead_runner_as_stopped(self):
        write_json_atomic(self.results / "mock" / "state.json",
                          {"runner": {"pid": 999999, "status": "running", "batch": {"done": 3, "planned": 8}}})
        with mock.patch.object(runner_ctl, "pid_alive", return_value=False):
            s = runner_ctl.status("mock")
        self.assertEqual((s["status"], s["alive"], s["done"], s["planned"]), ("stopped", False, 3, 8))

    def test_spawn_detached_runs_and_logs(self):
        import sys
        import time
        pid = runner_ctl.spawn_detached([sys.executable, "-c", "print('hello from child')"], "unit-test", data_dir=self.data)
        self.assertGreater(pid, 0)
        log = self.data / "logs" / "unit-test.log"
        for _ in range(50):
            if "hello from child" in log.read_text(encoding="utf-8", errors="replace"):
                break
            time.sleep(0.1)
        self.assertIn("hello from child", log.read_text(encoding="utf-8", errors="replace"))
        for _ in range(100):  # let the child exit so the temp dir can be removed
            if not runner_ctl.pid_alive(pid):
                break
            time.sleep(0.1)
        with self.assertRaises(ValueError):
            runner_ctl.spawn_detached("python -c 1", "x", data_dir=self.data)


if __name__ == "__main__":
    unittest.main()
