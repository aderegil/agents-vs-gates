"""Read-only access to the frozen scenario texts (WP1 writes them under scenario/)."""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

from harness import paths

TICKETS = ("X-rename", "X-remove", "X-api", "X-dep", "X-units", "X-add")
PARAPHRASED = ("X-rename", "X-remove", "X-api")
CONSUMERS = ("billing-service", "analytics-ingest", "web-storefront")
V2_LINE = ("You are working on orders-service. The other folders are other teams' repositories, "
           "checked out read-only for reference.")
CONTEXT_NAMES = {"claude_code": "CLAUDE.md", "mock": "CLAUDE.md", "codex": "AGENTS.md", "gemini": "GEMINI.md"}


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def ticket_file(ticket: str, wording: str = "W1", paraphrase: str | None = None) -> Path:
    if wording == "W2":
        return paths.TASKS / f"{ticket}.W2.md"
    if paraphrase:
        return paths.TASKS / f"{ticket}.{paraphrase}.md"
    return paths.TASKS / f"{ticket}.md"


def ticket_text(ticket: str, wording: str = "W1", paraphrase: str | None = None) -> str:
    """The prompt = the ticket text as is, no wrapper (spec 6.1). Leading/trailing whitespace trimmed."""
    return _read(ticket_file(ticket, wording, paraphrase)).strip()


def paraphrases_ready(ticket: str) -> bool:
    files = [paths.TASKS / f"{ticket}.p{k}.md" for k in range(1, 6)]
    return all(f.exists() and "TODO(human)" not in _read(f) for f in files)


def context_text(S: str) -> str:
    return _read(paths.CONTEXT / "orders-service" / f"{S}.md")


def context_name(adapter: str) -> str:
    return CONTEXT_NAMES[adapter]


@lru_cache(maxsize=1)
def solutions_index() -> dict:
    p = paths.SOLUTIONS / "index.json"
    return json.loads(_read(p)) if p.exists() else {}


def solution(key: str) -> dict:
    idx = solutions_index()
    if key not in idx:
        raise KeyError(f"solution {key!r} not in scenario/solutions/index.json")
    ent = dict(idx[key])
    ent["path"] = paths.SOLUTIONS / ent.get("file", f"{key}.patch")
    return ent


def scenario_hash() -> str:
    """sha256 over scenario/repos, scenario/context and scenario/tasks (paths + bytes, sorted)."""
    h = hashlib.sha256()
    for base in (paths.REPOS, paths.CONTEXT, paths.TASKS):
        if not base.exists():
            continue
        for f in sorted(p for p in base.rglob("*") if p.is_file() and "node_modules" not in p.parts
                        and "dist" not in p.parts):
            h.update(f.relative_to(paths.SCENARIO).as_posix().encode())
            h.update(b"\0")
            h.update(f.read_bytes())
    return "sha256:" + h.hexdigest()
