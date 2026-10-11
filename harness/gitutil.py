"""git without the user's global/system config (spec 2), always with an argv list."""
from __future__ import annotations

import subprocess
from pathlib import Path

from harness import paths


class GitError(RuntimeError):
    pass


def git(repo: Path, *args: str, check: bool = True, input_text: str | None = None) -> str:
    p = subprocess.run(["git", *paths.GIT_INLINE, *args], cwd=str(repo), env=paths.git_env(),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", input=input_text)
    if check and p.returncode != 0:
        raise GitError(f"git {' '.join(args)} (in {repo}) exit {p.returncode}: {p.stderr.strip()[:2000]}")
    return p.stdout


def git_bytes(repo: Path, *args: str) -> bytes:
    p = subprocess.run(["git", *paths.GIT_INLINE, *args], cwd=str(repo), env=paths.git_env(), capture_output=True)
    if p.returncode != 0:
        raise GitError(f"git {' '.join(args)} exit {p.returncode}: {p.stderr.decode('utf-8', 'replace')[:2000]}")
    return p.stdout


def init_commit(repo: Path, tag: str = "base") -> None:
    git(repo, "init", "-q", "-b", "main")
    commit_all(repo, tag)


def commit_all(repo: Path, tag: str) -> None:
    """Stage everything, commit (allow empty) with message = tag, and tag it."""
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "--allow-empty", "--no-verify", "-m", tag)
    git(repo, "tag", "-f", tag)


def show(repo: Path, ref: str, path: str) -> str | None:
    p = subprocess.run(["git", *paths.GIT_INLINE, "show", f"{ref}:{path}"], cwd=str(repo), env=paths.git_env(),
                       capture_output=True)
    if p.returncode != 0:
        return None
    return p.stdout.decode("utf-8", "replace")


def read_many(repo: Path, specs: list[str]) -> dict[str, str | None]:
    """Contents of many "<ref>:<path>" blobs with one `git cat-file --batch` process (None if missing)."""
    specs = list(dict.fromkeys(specs))
    if not specs:
        return {}
    p = subprocess.run(["git", *paths.GIT_INLINE, "cat-file", "--batch"], cwd=str(repo), env=paths.git_env(),
                       input=("\n".join(specs) + "\n").encode("utf-8"), capture_output=True)
    data, out, pos = p.stdout, {}, 0
    for spec in specs:
        nl = data.index(b"\n", pos)
        header = data[pos:nl].decode("utf-8", "replace")
        pos = nl + 1
        if header.endswith(" missing") or header.endswith(" ambiguous"):
            out[spec] = None
            continue
        size = int(header.rsplit(" ", 1)[1])
        out[spec] = data[pos:pos + size].decode("utf-8", "replace")
        pos += size + 1
    return out


def ls_tree(repo: Path, ref: str) -> list[str]:
    return [l for l in git(repo, "ls-tree", "-r", "--name-only", ref).splitlines() if l]


def name_status(repo: Path, a: str, b: str) -> list[tuple[str, str, str | None]]:
    """[(status, path, old_path)] with renames split into (R, new, old)."""
    out = []
    for line in git(repo, "diff", "--name-status", "-M", a, b).splitlines():
        parts = line.split("\t")
        st = parts[0][0]
        if st in "RC" and len(parts) == 3:
            out.append((st, parts[2], parts[1]))
        elif len(parts) >= 2:
            out.append((st, parts[1], None))
    return out


def diff(repo: Path, a: str, b: str) -> str:
    return git(repo, "diff", "--no-color", "--no-ext-diff", a, b)


def numstat(repo: Path, a: str, b: str) -> dict:
    files = added = removed = 0
    for line in git(repo, "diff", "--numstat", a, b).splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        files += 1
        added += int(parts[0]) if parts[0].isdigit() else 0
        removed += int(parts[1]) if parts[1].isdigit() else 0
    return {"files_changed": files, "lines_added": added, "lines_removed": removed}


def archive_to(repo: Path, ref: str, dest: Path) -> Path:
    """`git archive <ref>` extracted into dest (wiped first), outside the workspace."""
    import io
    import shutil
    import tarfile
    if dest.exists():
        shutil.rmtree(dest, onexc=_force_remove)
    dest.mkdir(parents=True)
    data = git_bytes(repo, "archive", "--format=tar", ref)
    with tarfile.open(fileobj=io.BytesIO(data)) as tf:
        tf.extractall(dest, filter="data")
    return dest


def bundle(repo: Path, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    git(repo, "bundle", "create", str(out), "--all")


def _force_remove(func, path, _exc):
    import os
    import stat
    os.chmod(path, stat.S_IWRITE)
    func(path)


def rmtree(p: Path) -> None:
    import shutil
    if p.exists():
        shutil.rmtree(p, onexc=_force_remove)
