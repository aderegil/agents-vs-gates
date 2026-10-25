"""Pre-registration errata (harness.prereg, 2026-10-25): a corrected frozen file verifies only through its erratum, and
only when the change is exactly the documented line."""
from __future__ import annotations

import hashlib
import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from harness import paths, prereg

FILES = ["PREREGISTRATION.md", "PREREGISTRATION.lock"]


class Erratum(unittest.TestCase):
    """A temp repo with a lock over one file, its corrected version and the erratum (the real erratum's mechanics)."""

    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="avg-erratum-"))
        orig = b"# Plan\n\nA small experiment for the talk *X* (Some Event, 2026).\n\nThe plan.\n"
        self.orig = orig
        lines = orig.splitlines(keepends=True)
        after = "A small experiment for the talk *X*."
        new = b"".join(lines[:2] + [(after + "\n").encode()] + lines[3:])
        (self.repo / "PLAN.md").write_bytes(new)
        sha = lambda b: hashlib.sha256(b).hexdigest()
        (self.repo / prereg.LOCK_NAME).write_text(json.dumps({"files": {"PLAN.md": sha(orig)}}), encoding="utf-8")
        rec = {"erratum": 1, "file": "PLAN.md", "line": 3, "after": after, "original_sha256": sha(orig),
               "new_sha256": sha(new), "original_line_sha256": [sha(ln) for ln in lines]}
        (self.repo / "PREREGISTRATION-ERRATUM-1.md").write_text(
            "# Erratum 1\n\n```json\n" + json.dumps(rec) + "\n```\n", encoding="utf-8")
        self._compute = prereg.compute
        prereg.compute = lambda repo: {"PLAN.md": prereg._sha(Path(repo) / "PLAN.md")}

    def tearDown(self):
        prereg.compute = self._compute
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_the_documented_change_verifies_and_says_so(self):
        ok, problems = prereg.verify(self.repo)
        self.assertTrue(ok, problems)
        self.assertEqual(prereg.verify_notes(self.repo),
                         ["verified with erratum 1 (PLAN.md, line 3; PREREGISTRATION-ERRATUM-1.md)"])

    def test_another_line_changed_fails(self):
        p = self.repo / "PLAN.md"
        p.write_bytes(p.read_bytes().replace(b"The plan.", b"The new plan."))
        ok, problems = prereg.verify(self.repo)
        self.assertFalse(ok)
        self.assertEqual(problems, ["changed: PLAN.md"])

    def test_a_different_text_on_the_documented_line_fails(self):
        p = self.repo / "PLAN.md"
        p.write_bytes(p.read_bytes().replace(b"*X*.", b"*Y*."))
        self.assertFalse(prereg.verify(self.repo)[0])

    def test_an_erratum_for_another_original_fails(self):
        lock = self.repo / prereg.LOCK_NAME
        lock.write_text(json.dumps({"files": {"PLAN.md": "0" * 64}}), encoding="utf-8")
        self.assertFalse(prereg.verify(self.repo)[0])

    def test_without_the_erratum_the_change_fails(self):
        (self.repo / "PREREGISTRATION-ERRATUM-1.md").unlink()
        self.assertFalse(prereg.verify(self.repo)[0])

    def test_the_original_still_verifies_without_a_note(self):
        (self.repo / "PLAN.md").write_bytes(self.orig)
        self.assertTrue(prereg.verify(self.repo)[0])
        self.assertEqual(prereg.verify_notes(self.repo), [])


class RealRepo(unittest.TestCase):
    def test_the_repo_verifies_with_erratum_1(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = prereg.main(["--verify"])
        self.assertEqual(code, 0, out.getvalue())
        self.assertIn("verified with erratum 1", out.getvalue())
        text = (paths.REPO / "PREREGISTRATION-ERRATUM-1.md").read_text(encoding="utf-8")
        self.assertNotRegex(text.lower(), "the employer|the talk")


if __name__ == "__main__":
    unittest.main()
