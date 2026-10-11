"""The RQ6 epic's story drafts (scenario/tasks/S-*.md) -> structured stories.

A story file is a markdown draft with a header block (`Epic:`, `Repo:`, `Team:`, `Depends on:`, `Risk:`), a story
paragraph and an `Acceptance criteria:` bullet list. The texts are drafts for Alfredo; this module only parses them.
"""
from __future__ import annotations

import re
from pathlib import Path

from harness import paths

EPIC_ID = "EPIC-RQ6"
EPIC_TITLE = "Multi-currency checkout"
TITLE_RE = re.compile(r"^#\s+(S-\d+)\s+·\s+(.+?)\s*$", re.M)
FIELD_RE = re.compile(r"^(Epic|Repo|Team|Depends on|Risk):\s*(.+?)\s*$", re.M)


def parse_story(text: str) -> dict:
    m = TITLE_RE.search(text)
    if not m:
        raise ValueError("story has no '# S-n · Title' line")
    fields = {k: v for k, v in FIELD_RE.findall(text)}
    for k in ("Repo", "Team", "Risk"):
        if k not in fields:
            raise ValueError(f"story {m.group(1)} lacks '{k}:'")
    body = text[m.end():]
    ac_at = body.find("Acceptance criteria:")
    criteria: list[str] = []
    if ac_at >= 0:
        cur = None
        for line in body[ac_at:].splitlines()[1:]:
            if line.startswith("- "):
                cur = line[2:].strip()
                criteria.append(cur)
            elif line.startswith("  ") and criteria:
                criteria[-1] += " " + line.strip()
            elif line.strip():
                break
    paras = [p.strip() for p in re.split(r"\n\s*\n", body[:ac_at] if ac_at >= 0 else body) if p.strip()]
    narrative = next((" ".join(p.split()) for p in paras if p.startswith("As ")), "")
    deps = fields.get("Depends on", "none")
    return {
        "id": m.group(1),
        "title": m.group(2),
        "repo": fields["Repo"],
        "team": fields["Team"],
        "risk": fields["Risk"].lower(),
        "depends_on": [] if deps.lower() == "none" else [d.strip() for d in deps.split(",") if d.strip()],
        "narrative": narrative,
        "acceptance_criteria": criteria,
        "draft": "DRAFT" in text.split("\n", 1)[0],
    }


def load_stories(tasks_dir: Path | None = None) -> list[dict]:
    d = Path(tasks_dir or paths.TASKS)
    files = sorted(d.glob("S-*.md"), key=lambda p: int(re.sub(r"\D", "", p.stem) or 0))
    if not files:
        raise FileNotFoundError(f"no S-*.md story drafts in {d}")
    return [parse_story(f.read_text(encoding="utf-8")) for f in files]
