"""End-to-end with the real WP1 CI/oracle (Node). Slow: run with AVG_SLOW=1."""
import io
import os
import unittest
from contextlib import redirect_stdout

from harness import cycle, selftest


@unittest.skipUnless(os.environ.get("AVG_SLOW") == "1", "slow end-to-end test; set AVG_SLOW=1")
class SelftestSlow(unittest.TestCase):
    def setUp(self):
        missing = cycle.wp1_missing()
        if missing:
            self.skipTest("WP1 pieces missing: " + ", ".join(missing))

    def test_truth_table(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = selftest.main(["--truth-table"])
        self.assertEqual(code, 0, buf.getvalue())
        self.assertIn("TRUTH TABLE 29/29 OK", buf.getvalue())

    def test_quick_selftest(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = selftest.main(["--quick"])
        self.assertEqual(code, 0, buf.getvalue())


if __name__ == "__main__":
    unittest.main()
