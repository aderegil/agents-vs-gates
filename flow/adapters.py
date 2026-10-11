"""Role adapters for the flow. Only the mock exists; the real adapter is a marked, unimplemented hook.

# --------------------------------------------------------------------------------------------------------------
# REAL ADAPTER HOOK — NOT IMPLEMENTED. Running a role on a real model (`claude -p` with flow/prompts/<role>.md, its
# tools and its allowed paths; the review agent on a different unit such as `codex exec`) is an experiment run and
# needs Alfredo's explicit authorization (spec 0.1, 10.8, 16.2). This hook raises before doing anything: it builds
# no command line, spawns no process and opens no network connection.
# --------------------------------------------------------------------------------------------------------------
"""
from __future__ import annotations

REAL_ADAPTER_MESSAGE = ("the real role adapter is not implemented: M2b runs only with --mock (zero model calls). "
                        "A real adapter needs Alfredo's explicit authorization (spec 0.1, 16.2).")


class RealRoleAdapter:
    """Placeholder for one role played by a real model. Every entry point raises NotImplementedError."""

    def __init__(self, role: str, unit: str | None = None):
        self.role = role
        self.unit = unit

    def run(self, *args, **kwargs):
        raise NotImplementedError(REAL_ADAPTER_MESSAGE)


def real_agents(*args, **kwargs):
    """Would return the real counterpart of flow.mock_agents.MockAgents. Raises without calling anything."""
    raise NotImplementedError(REAL_ADAPTER_MESSAGE)
