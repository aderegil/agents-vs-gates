"""Pre-registration freeze and verification (spec 15).

  python -m harness.prereg --freeze [--repo DIR]    write PREREGISTRATION.lock + commit "Freeze pre-registration"
  python -m harness.prereg --verify [--repo DIR] [--json]   OK, or the list of differences (exit 1)

Frozen set (SHA-256 per file): PREREGISTRATION.md, scenario/tasks/X-*.md (M1 tickets; the M2 story drafts S-* are not frozen), scenario/context/orders-service/*.md,
harness/texts/*, analysis/RUBRIC.md, results/real/manifest.json, harness/units.json, every file under ci/.
Freezing is Alfredo's step (after P0 and fixing units.json); builders only test it on a temp copy (--repo).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from harness import paths

LOCK_NAME = "PREREGISTRATION.lock"
GLOBS = ("PREREGISTRATION.md", "scenario/tasks/X-*.md", "scenario/context/orders-service/*.md", "harness/texts/*",
         "analysis/RUBRIC.md", "harness/units.json", "ci/**/*")
SKIP_PARTS = {"__pycache__", "node_modules", ".ci-build"}


def _manifest(repo: Path) -> Path:
    if repo.resolve() == paths.REPO.resolve():
        return paths.manifest_path("real")
    return repo / "results" / "real" / "manifest.json"


def frozen_files(repo: Path) -> dict[str, Path]:
    out = {}
    for g in GLOBS:
        for p in sorted(repo.glob(g)):
            if p.is_file() and not (SKIP_PARTS & set(p.relative_to(repo).parts)) and p.suffix != ".pyc":
                out[p.relative_to(repo).as_posix()] = p
    m = _manifest(repo)
    out["results/real/manifest.json"] = m
    return out


def _sha(p: Path) -> str | None:
    try:
        return hashlib.sha256(p.read_bytes()).hexdigest()
    except OSError:
        return None


def compute(repo: Path) -> dict[str, str | None]:
    return {rel: _sha(p) for rel, p in frozen_files(repo).items()}


def freeze(repo: Path | None = None, *, commit: bool = True) -> dict:
    repo = Path(repo or paths.REPO)
    lock = repo / LOCK_NAME
    if lock.exists():
        raise RuntimeError(f"{lock} already exists; the pre-registration is frozen")
    files = compute(repo)
    missing = [k for k, v in files.items() if v is None]
    if missing:
        raise RuntimeError("cannot freeze, missing: " + ", ".join(missing))
    agg = hashlib.sha256("".join(f"{k}\0{v}\n" for k, v in sorted(files.items())).encode()).hexdigest()
    data = {"schema": "prereg-lock/1", "frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "aggregate_sha256": agg, "files": dict(sorted(files.items()))}
    lock.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8", newline="\n")
    if commit:
        from harness import gitutil
        gitutil.git(repo, "add", LOCK_NAME)
        man = _manifest(repo)
        if man.exists() and man.is_relative_to(repo):
            gitutil.git(repo, "add", "-f", man.relative_to(repo).as_posix())   # results/ is gitignored
        gitutil.git(repo, "commit", "-q", "-m", "Freeze pre-registration")
    return data


def verify(repo: Path | None = None) -> tuple[bool, list[str]]:
    repo = Path(repo or paths.REPO)
    lock = repo / LOCK_NAME
    if not lock.exists():
        return False, [f"{LOCK_NAME} missing (not frozen)"]
    try:
        data = json.loads(lock.read_text(encoding="utf-8"))
    except ValueError:
        return False, [f"{LOCK_NAME} unreadable"]
    want, have = data.get("files", {}), compute(repo)
    problems = []
    for rel, sha in sorted(want.items()):
        if have.get(rel) is None:
            problems.append(f"missing: {rel}")
        elif have[rel] != sha:
            problems.append(f"changed: {rel}")
    for rel in sorted(set(have) - set(want)):
        problems.append(f"new (not frozen): {rel}")
    return not problems, problems


def lock_info(repo: Path | None = None) -> dict | None:
    lock = Path(repo or paths.REPO) / LOCK_NAME
    if not lock.exists():
        return None
    data = json.loads(lock.read_text(encoding="utf-8"))
    return {"frozen_at": data.get("frozen_at"), "aggregate_sha256": data.get("aggregate_sha256"),
            "short": (data.get("aggregate_sha256") or "")[:12]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m harness.prereg")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--freeze", action="store_true")
    g.add_argument("--verify", action="store_true")
    ap.add_argument("--repo", help="operate on another checkout (tests use a temp copy)")
    ap.add_argument("--no-commit", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    repo = Path(a.repo) if a.repo else paths.REPO
    if a.freeze:
        try:
            data = freeze(repo, commit=not a.no_commit)
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return 2
        print(f"FROZEN {data['frozen_at']} {data['aggregate_sha256'][:12]} ({len(data['files'])} files)")
        return 0
    ok, problems = verify(repo)
    if a.json:
        print(json.dumps({"ok": ok, "problems": problems, "lock": lock_info(repo)}, indent=2))
    else:
        print("OK" if ok else "\n".join(problems))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
