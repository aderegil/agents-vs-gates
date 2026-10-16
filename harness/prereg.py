"""Pre-registration freeze and verification (spec 15).

  python -m harness.prereg --freeze [--repo DIR]    write PREREGISTRATION.lock + commit "Freeze pre-registration"
  python -m harness.prereg --verify [--repo DIR] [--json]   OK, or the list of differences (exit 1)

Frozen set (SHA-256 per file): PREREGISTRATION.md, scenario/tasks/X-*.md (M1 tickets; the M2 story drafts S-* are not frozen), scenario/context/orders-service/*.md,
harness/texts/*, analysis/RUBRIC.md, results/real/manifest.json, harness/units.json, every file under ci/.
Freezing is Alfredo's step (after P0 and fixing units.json); builders only test it on a temp copy (--repo).

Addendum 1 (P7, P8; PREREGISTRATION-ADDENDUM-1.md). The original lock is never edited or re-frozen:
  python -m harness.prereg --freeze-addendum 1 [--repo DIR]   write PREREGISTRATION-ADDENDUM-1.lock + commit
  python -m harness.prereg --verify-addendum 1 [--repo DIR] [--json]
The addendum lock holds the UTC time, the SHA-256 of the addendum and of the files P7/P8 add (ADDENDUM_FILES), and the
aggregate hash of the original lock it extends. Freezing it requires the original lock to verify; verifying it checks
both. Freezing the addendum is Alfredo's step (🔒).
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


# ---------------------------------------------------------------- addendum ---------------------------------------

ADDENDUM_FILES = {1: ("PREREGISTRATION-ADDENDUM-1.md", "harness/units-ext.json", "harness/adapters/agy.py",
                      "results/real/manifest-ext1.json")}


def addendum_lock_name(n: int) -> str:
    return f"PREREGISTRATION-ADDENDUM-{n}.lock"


def addendum_lock_path(n: int, repo: Path | None = None) -> Path:
    return Path(repo or paths.REPO) / addendum_lock_name(n)


def _addendum_file(repo: Path, rel: str) -> Path:
    if rel.startswith("results/real/") and repo.resolve() == paths.REPO.resolve():
        return paths.ns_dir("real") / rel[len("results/real/"):]     # honours AVG_RESULTS_ROOT, like _manifest
    return repo / rel


def addendum_files(n: int, repo: Path) -> dict[str, Path]:
    if n not in ADDENDUM_FILES:
        raise ValueError(f"unknown addendum {n}")
    return {rel: _addendum_file(repo, rel) for rel in ADDENDUM_FILES[n]}


def _aggregate(files: dict) -> str:
    return hashlib.sha256("".join(f"{k}\0{v}\n" for k, v in sorted(files.items())).encode()).hexdigest()


def freeze_addendum(n: int, repo: Path | None = None, *, commit: bool = True) -> dict:
    repo = Path(repo or paths.REPO)
    lock = addendum_lock_path(n, repo)
    if lock.exists():
        raise RuntimeError(f"{lock} already exists; addendum {n} is frozen")
    ok, problems = verify(repo)
    if not ok:
        raise RuntimeError("the original pre-registration lock does not verify: " + "; ".join(problems[:5]))
    files = {rel: _sha(p) for rel, p in addendum_files(n, repo).items()}
    missing = [k for k, v in files.items() if v is None]
    if missing:
        raise RuntimeError("cannot freeze the addendum, missing: " + ", ".join(missing))
    original = json.loads((repo / LOCK_NAME).read_text(encoding="utf-8"))
    data = {"schema": "prereg-addendum-lock/1", "addendum": n,
            "frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "extends": {"lock": LOCK_NAME, "aggregate_sha256": original.get("aggregate_sha256"),
                        "lock_file_sha256": _sha(repo / LOCK_NAME)},
            "aggregate_sha256": _aggregate(files), "files": dict(sorted(files.items()))}
    lock.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8", newline="\n")
    if commit:
        from harness import gitutil
        gitutil.git(repo, "add", lock.name)
        for rel, p in addendum_files(n, repo).items():
            if p.is_relative_to(repo):
                gitutil.git(repo, "add", "-f", p.relative_to(repo).as_posix())   # results/ is gitignored
        gitutil.git(repo, "commit", "-q", "-m", f"Freeze pre-registration addendum {n}")
    return data


def verify_addendum(n: int, repo: Path | None = None) -> tuple[bool, list[str]]:
    """Both locks: the original (verify) and addendum n (its files and the original aggregate it extends)."""
    repo = Path(repo or paths.REPO)
    ok, problems = verify(repo)
    problems = [f"original: {p}" for p in problems]
    lock = addendum_lock_path(n, repo)
    if not lock.exists():
        return False, problems + [f"{lock.name} missing (addendum {n} not frozen)"]
    try:
        data = json.loads(lock.read_text(encoding="utf-8"))
    except ValueError:
        return False, problems + [f"{lock.name} unreadable"]
    try:
        original = json.loads((repo / LOCK_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        original = {}
    ext = data.get("extends") or {}
    if ext.get("aggregate_sha256") != original.get("aggregate_sha256") or             ext.get("lock_file_sha256") not in (None, _sha(repo / LOCK_NAME)):
        problems.append(f"{lock.name} extends a different {LOCK_NAME}")
    have = {rel: _sha(p) for rel, p in addendum_files(n, repo).items()}
    for rel, sha in sorted((data.get("files") or {}).items()):
        if have.get(rel) is None:
            problems.append(f"addendum {n}: missing: {rel}")
        elif have[rel] != sha:
            problems.append(f"addendum {n}: changed: {rel}")
    for rel in sorted(set(have) - set(data.get("files") or {})):
        problems.append(f"addendum {n}: new (not frozen): {rel}")
    return not problems, problems


def addendum_info(n: int, repo: Path | None = None) -> dict | None:
    lock = addendum_lock_path(n, repo)
    if not lock.exists():
        return None
    data = json.loads(lock.read_text(encoding="utf-8"))
    return {"frozen_at": data.get("frozen_at"), "aggregate_sha256": data.get("aggregate_sha256"),
            "short": (data.get("aggregate_sha256") or "")[:12]}


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
    g.add_argument("--freeze-addendum", type=int, metavar="N")
    g.add_argument("--verify-addendum", type=int, metavar="N")
    ap.add_argument("--repo", help="operate on another checkout (tests use a temp copy)")
    ap.add_argument("--no-commit", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    repo = Path(a.repo) if a.repo else paths.REPO
    if a.freeze_addendum is not None:
        try:
            data = freeze_addendum(a.freeze_addendum, repo, commit=not a.no_commit)
        except (RuntimeError, ValueError) as e:
            print(str(e), file=sys.stderr)
            return 2
        print(f"FROZEN addendum {a.freeze_addendum} {data['frozen_at']} {data['aggregate_sha256'][:12]} "
              f"({len(data['files'])} files; extends {data['extends']['aggregate_sha256'][:12]})")
        return 0
    if a.verify_addendum is not None:
        ok, problems = verify_addendum(a.verify_addendum, repo)
        if a.json:
            print(json.dumps({"ok": ok, "problems": problems, "lock": lock_info(repo),
                              "addendum": addendum_info(a.verify_addendum, repo)}, indent=2))
        else:
            print("OK" if ok else "\n".join(problems))
        return 0 if ok else 1
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
