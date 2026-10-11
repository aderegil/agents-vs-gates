"""SSE formatting, the bus, and the watcher that turns state.json / runner.log.jsonl into events (blinding included)."""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from console.core.events import EventBus, Watcher, finished_payload, sse_comment, sse_format
from harness.jsonio import append_jsonl, write_json_atomic


def state(**over):
    s = {"schema": "state/1", "namespace": "mock", "runs": {"p1-0001": {"status": "done"}, "p1-0002": {"status": "pending"}},
         "runner": {"pid": None, "status": "running", "stage": "P1", "batch": {"done": 1, "planned": 8}},
         "workers": {"1": {"run_id": "p1-0002", "ticket": "X-rename", "cell": "c"}}, "unblinded": {}, "usage": {},
         "updated_at": "2026-10-11T09:00:00Z"}
    s.update(over)
    return s


class SseTest(unittest.TestCase):
    def test_frame(self):
        b = sse_format("runner.progress", {"ns": "mock", "x": "línea\nnueva"}, 7)
        self.assertEqual(b, 'id: 7\nevent: runner.progress\ndata: {"ns":"mock","x":"línea\\nnueva"}\n\n'.encode("utf-8"))
        self.assertEqual(sse_comment(), b": keep-alive\n\n")

    def test_frame_is_sanitized(self):
        self.assertNotIn(b"Users", sse_format("t", {"p": "C:\\Users\\bob\\x"}))

    def test_bus_roles_and_ns(self):
        bus = EventBus()
        owner, viewer = bus.subscribe("owner"), bus.subscribe("viewer")
        bus.publish("audit.new", {"a": 1}, roles=("owner",))
        bus.publish("runner.stopped", {}, ns="mock")
        self.assertEqual(owner.q.qsize(), 2)
        self.assertEqual(viewer.q.qsize(), 1)
        _, topic, data = viewer.q.get_nowait()
        self.assertEqual((topic, data["ns"]), ("runner.stopped", "mock"))
        bus.unsubscribe(viewer)
        bus.publish("x", {})
        self.assertEqual(viewer.q.qsize(), 0)


class WatcherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {"AVG_RESULTS_ROOT": str(self.root)})
        self.env.start()
        self.ns = self.root / "mock"
        self.ns.mkdir()
        self.bus = EventBus()
        self.sub = self.bus.subscribe("owner")
        self.w = Watcher(self.bus)

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def drain(self):
        out = []
        while not self.sub.q.empty():
            out.append(self.sub.q.get_nowait()[1:])
        return out

    def record(self, run_id, stage, outcome="fixed_code"):
        d = self.ns / "runs" / run_id
        d.mkdir(parents=True, exist_ok=True)
        write_json_atomic(d / "record.json", {"run_id": run_id, "stage": stage, "outcome": outcome})

    def test_progress_published_on_change_only(self):
        write_json_atomic(self.ns / "state.json", state())
        self.w.tick()
        ev = self.drain()
        self.assertEqual(ev[0][0], "runner.progress")
        data = ev[0][1]
        self.assertEqual((data["ns"], data["counts"]["done"], data["counts"]["total"]), ("mock", 1, 2))
        self.assertEqual(data["workers"]["1"]["run_id"], "p1-0002")
        self.w.tick()
        self.assertEqual(self.drain(), [])  # unchanged
        self.w.last_progress_at.clear()
        write_json_atomic(self.ns / "state.json", state(updated_at="2026-10-11T09:00:05Z"))
        self.w.tick()
        self.assertEqual([t for t, _ in self.drain()], ["runner.progress"])

    def test_log_events_and_blinding(self):
        write_json_atomic(self.ns / "state.json", state())
        log = self.ns / "runner.log.jsonl"
        append_jsonl(log, {"ts": "t0", "event": "run_finished", "run_id": "p1-0000", "turns": 1})  # history: not replayed
        self.w.tick()
        self.drain()
        self.record("p1-0001", "P1", "fixed_code")
        self.record("p0-0001", "P0", "passed_first_ci")
        append_jsonl(log, {"ts": "t1", "event": "run_started", "run_id": "p1-0002", "worker": 1, "ticket": "X-rename", "cell": "c"})
        append_jsonl(log, {"ts": "t2", "event": "run_finished", "run_id": "p1-0001", "turns": 5, "duration_ms": 1000, "tokens": 9})
        append_jsonl(log, {"ts": "t3", "event": "run_finished", "run_id": "p0-0001", "turns": 2, "duration_ms": 10, "tokens": 1})
        append_jsonl(log, {"ts": "t4", "event": "rate_limited", "until": "2026-10-11T14:05:00Z"})
        append_jsonl(log, {"ts": "t5", "event": "stopped", "reason": "batch done"})
        self.w.tick()
        events = [(t, d) for t, d in self.drain() if t != "runner.progress"]
        self.assertNotIn("p1-0000", json.dumps(events))  # history before the watcher started is not replayed
        finished = [d for t, d in events if t == "runner.run_finished"]
        p1 = next(d for d in finished if d["run_id"] == "p1-0001")
        p0 = next(d for d in finished if d["run_id"] == "p0-0001")
        self.assertNotIn("outcome", p1)                      # P1 blinded
        self.assertEqual(p0["outcome"], "passed_first_ci")    # P0 always visible
        self.assertEqual(p1["turns"], 5)
        self.assertIn(("runner.rate_limited"), [t for t, _ in events])
        self.assertEqual(next(d for t, d in events if t == "runner.rate_limited")["until"], "2026-10-11T14:05:00Z")
        self.assertIn("runner.stopped", [t for t, _ in events])
        started = next(d for t, d in events if t == "runner.run_started")
        self.assertEqual((started["run_id"], started["worker"], started["ticket"]), ("p1-0002", 1, "X-rename"))

    def test_unblinded_stage_carries_outcome(self):
        st = state(unblinded={"P1": {"at": "x", "forced": False}})
        self.record("p1-0001", "P1", "still_failing")
        self.assertEqual(finished_payload("mock", {"run_id": "p1-0001"}, st)["outcome"], "still_failing")
        self.assertNotIn("outcome", finished_payload("mock", {"run_id": "p1-0001"}, state()))

    def test_partial_line_waits(self):
        write_json_atomic(self.ns / "state.json", state())
        log = self.ns / "runner.log.jsonl"
        log.write_text("", encoding="utf-8")
        self.w.tick()
        self.drain()
        with open(log, "a", encoding="utf-8") as f:
            f.write('{"event": "stopped"')
        self.w.tick()
        self.assertEqual([t for t, _ in self.drain() if t != "runner.progress"], [])
        with open(log, "a", encoding="utf-8") as f:
            f.write("}\n")
        self.w.tick()
        self.assertEqual([t for t, _ in self.drain() if t != "runner.progress"], ["runner.stopped"])


class SseEndpointTest(unittest.TestCase):
    def test_stream_delivers_events(self):
        from console.tests.helpers import ConsoleFixture
        import http.client
        with ConsoleFixture() as fx:
            conn = http.client.HTTPConnection("127.0.0.1", fx.port, timeout=10)
            conn.request("GET", "/api/events", headers={"Host": f"127.0.0.1:{fx.port}",
                                                        "Cookie": "; ".join(f"{k}={v}" for k, v in fx.owner.jar.items())})
            r = conn.getresponse()
            self.assertEqual(r.status, 200)
            self.assertTrue(r.getheader("Content-Type").startswith("text/event-stream"))
            buf = b""
            deadline = time.time() + 5
            while b": connected" not in buf and time.time() < deadline:
                buf += r.read1(1024)
            fx.app.bus.publish("runner.stopped", {"reason": "test"}, ns="mock")
            while b"runner.stopped" not in buf and time.time() < deadline:
                buf += r.read1(1024)
            conn.close()
            self.assertIn(b"event: runner.stopped\ndata: {", buf)
            self.assertIn(b'"ns":"mock"', buf)


if __name__ == "__main__":
    unittest.main()
