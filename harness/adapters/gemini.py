"""Gemini CLI adapter: stub (spec 2: Gemini CLI is not installed). Context file name would be GEMINI.md."""
from __future__ import annotations

CALLS = 0
MESSAGE = "Gemini CLI adapter is a stub: Gemini CLI is not installed (spec §2); build it when it is"


def run_session(ws, prompt, *, resume=None, unit, limits, on_event=None):
    raise NotImplementedError(MESSAGE)
