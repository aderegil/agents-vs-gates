"""harness.proc: stdin feeding, line streaming with timestamps, wall-clock kill of a process tree."""
import os
import sys
import time
import unittest

from harness import proc

PY = sys.executable
PING = ["ping", "-n", "60", "127.0.0.1"] if sys.platform == "win32" else ["sleep", "60"]  # starts fast, prints, sleeps


class Proc(unittest.TestCase):
    def test_stdin_and_lines(self):
        code = "import sys\nfor l in sys.stdin.read().splitlines(): print('got:' + l, flush=True)\nsys.stderr.write('E')"
        got = []
        r = proc.run_streaming([PY, "-c", code], cwd=os.getcwd(), env=dict(os.environ), stdin_text="a\nb ünï\n",
                               wall_clock_s=20, on_line=lambda l, ts: got.append((l, ts)))
        self.assertEqual([l for l, _ in got], ["got:a", "got:b ünï"])
        self.assertTrue(all(ts.endswith("Z") for _, ts in got))
        self.assertEqual(r["rc"], 0)
        self.assertFalse(r["timed_out"])
        self.assertEqual(r["stderr"], "E")

    def test_timeout_kills_tree(self):
        # parent spawns a sleeping grandchild that inherits stdout; both must die
        code = ("import subprocess, sys, time\n"
                f"subprocess.Popen([{PY!r}, '-c', 'import time; time.sleep(60)'])\n"
                "print('started', flush=True)\ntime.sleep(60)")
        t0 = time.monotonic()
        r = proc.run_streaming([PY, "-c", code], cwd=os.getcwd(), env=dict(os.environ), stdin_text="",
                               wall_clock_s=1.5, on_line=lambda l, ts: None)
        self.assertTrue(r["timed_out"])
        self.assertLess(time.monotonic() - t0, 10)

    def test_on_line_kill(self):
        code = "import time\nprint('x', flush=True)\ntime.sleep(60)"
        t0 = time.monotonic()
        r = proc.run_streaming([PY, "-c", code], cwd=os.getcwd(), env=dict(os.environ), stdin_text="",
                               wall_clock_s=30, on_line=lambda l, ts: "kill")
        self.assertTrue(r["killed"])
        self.assertLess(time.monotonic() - t0, 10)


if __name__ == "__main__":
    unittest.main()
