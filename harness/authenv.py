"""Clean child-process environment and the OAuth token (spec 10.3). The token is read from C:\\avg\\.env only
into a child env; it is never logged, recorded or returned by any API."""
from __future__ import annotations

import os

from harness import paths

TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN"


def oauth_token() -> str | None:
    try:
        text = paths.env_file().read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith(TOKEN_VAR + "="):
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            return val or None
    return None


def clean_env(extra: dict | None = None) -> dict:
    """os.environ minus CLAUDE_CODE*, CLAUDECODE, ANTHROPIC_*, CODEX_* (spec 10.3), plus `extra`."""
    env = {k: v for k, v in os.environ.items()
           if not (k.upper().startswith(("CLAUDE_CODE", "ANTHROPIC_", "CODEX_")) or k.upper() == "CLAUDECODE"
                   or k.upper() == "CLAUDE_CONFIG_DIR")}
    if extra:
        env.update(extra)
    return env
