"""Runner output lines for the console's Runner output panel (harness.runner.activity_line)."""
import unittest

from harness.runner import activity_line


class Activity(unittest.TestCase):
    def test_tool_calls_drop_the_workspace_prefix(self):
        ev = {"kind": "tool_call", "session": "gen", "name": "Read", "input": {"file_path": r"C:\avg\w1\r\src\core\events.ts"}}
        self.assertEqual(activity_line("p0-0001", ev), r"  p0-0001 [gen] Read src\core\events.ts")
        ev = {"kind": "tool_call", "session": "gen", "name": "Grep", "input": {"pattern": "totalCents", "path": "C:/avg/wm2/r/src"}}
        self.assertEqual(activity_line("p0-0001", ev), "  p0-0001 [gen] Grep totalCents")
        ev = {"kind": "tool_call", "session": "fix1", "name": "Bash", "input": {"command": "npm test"}}
        self.assertEqual(activity_line("p0-0001", ev), "  p0-0001 [fix1] Bash npm test")

    def test_text_is_one_line_and_short(self):
        line = activity_line("r", {"kind": "text", "session": "gen", "text": "I will look\n\n at it. " + "x" * 400})
        self.assertNotIn("\n", line)
        self.assertTrue(line.startswith("  r [gen] says: I will look at it."))
        self.assertLessEqual(len(line), 2 + len("r [gen] ") + 160)

    def test_only_failed_results_are_printed(self):
        self.assertEqual(activity_line("r", {"kind": "tool_result", "session": "gen", "status": "denied"}), "  r [gen]   -> denied")
        self.assertIsNone(activity_line("r", {"kind": "tool_result", "session": "gen", "status": "success"}))
        self.assertIsNone(activity_line("r", {"kind": "final", "session": "gen"}))


if __name__ == "__main__":
    unittest.main()
