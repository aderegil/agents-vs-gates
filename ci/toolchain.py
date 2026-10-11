"""Node toolchain helpers shared by CI, the oracle, ticket_done and the mutation test.

Pinned tools come from the repo's node_modules via `harness.paths.tool()`. Every subprocess gets an argv list (never a
shell) and a timeout that kills the whole process tree.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from harness import paths

CI_DIR = Path(__file__).resolve().parent
NETSTUB = CI_DIR / "netstub.mjs"
CHECKER = CI_DIR / "verify-contracts.mjs"
TYPES_ROOT = paths.NODE_MODULES / "@types"


def node() -> str:
    return shutil.which("node") or "node"


def npm() -> str:
    return shutil.which("npm") or "npm"


def tool(name: str) -> list[str]:
    """`harness.paths.tool(name)`, falling back to the package's declared bin when the pinned entry is missing."""
    argv = paths.tool(name)
    if Path(argv[-1]).exists():
        return argv
    pkg = {"tsc": "typescript", "depcruise": "dependency-cruiser"}[name]
    meta = json.loads((paths.NODE_MODULES / pkg / "package.json").read_text(encoding="utf-8"))
    bins = meta.get("bin") or {}
    rel = bins.get(name) if isinstance(bins, dict) else bins
    return [node(), str(paths.NODE_MODULES / pkg / rel)]


def import_flag(module: Path) -> str:
    """`--import=<file URL>` (a bare Windows path would be read as a URL with scheme `c:`)."""
    return "--import=" + Path(module).resolve().as_uri()


def netstub_flag() -> str:
    return import_flag(NETSTUB)


@dataclass
class ProcResult:
    code: int | None          # None = timed out
    out: str
    err: str
    duration_ms: int

    @property
    def timed_out(self) -> bool:
        return self.code is None

    @property
    def text(self) -> str:
        return (self.out + ("\n" if self.out and self.err else "") + self.err).strip("\n")


def _kill_tree(p: subprocess.Popen) -> None:
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
    else:
        p.kill()


def run(argv: list[str], cwd: Path | str, *, env: dict | None = None, timeout: float = 300,
        input_text: str | None = None) -> ProcResult:
    t0 = time.monotonic()
    p = subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=subprocess.PIPE if input_text is not None else
                         subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         encoding="utf-8", errors="replace")
    try:
        out, err = p.communicate(input=input_text, timeout=timeout)
        code = p.returncode
    except subprocess.TimeoutExpired:
        _kill_tree(p)
        out, err = p.communicate()
        code = None
    return ProcResult(code, out or "", err or "", int((time.monotonic() - t0) * 1000))


def base_env(**extra: str) -> dict:
    env = dict(os.environ)
    for k in list(env):
        if k.upper() in ("NODE_OPTIONS", "NODE_PATH"):
            env.pop(k)
    env["NO_COLOR"] = "1"
    env["FORCE_COLOR"] = "0"
    env["npm_config_update_notifier"] = "false"
    env["npm_config_fund"] = "false"
    env["npm_config_audit"] = "false"
    env.update(extra)
    return env


def has_types_above(d: Path) -> bool:
    for p in [d, *d.parents]:
        if (p / "node_modules" / "@types" / "node").exists():
            return True
    return False


def tsc_emit(project_dir: Path, out_dir: str, *, timeout: float = 300, force_type_roots: bool = False) -> ProcResult:
    """Type-check and emit (tsc emits even with type errors). `out_dir` is relative to project_dir or absolute."""
    argv = tool("tsc") + ["-p", "tsconfig.json", "--outDir", out_dir, "--noEmit", "false", "--noEmitOnError", "false",
                          "--pretty", "false"]
    if force_type_roots or not has_types_above(project_dir):
        argv += ["--typeRoots", str(TYPES_ROOT)]
    return run(argv, project_dir, env=base_env(), timeout=timeout)


def find_entry(build_dir: Path, name: str) -> Path | None:
    """Locate the compiled entry (e.g. main.js / index.js) under build_dir: src/<name> first, then <name>."""
    for cand in (build_dir / "src" / name, build_dir / name):
        if cand.is_file():
            return cand
    hits = sorted(build_dir.rglob(name), key=lambda p: len(p.parts)) if build_dir.exists() else []
    hits = [h for h in hits if "test" not in h.relative_to(build_dir).parts and "node_modules" not in h.parts]
    return hits[0] if hits else None


def rmtree(p: Path) -> None:
    def onexc(func, path, _exc):
        try:
            os.chmod(path, 0o700)
            func(path)
        except OSError:
            pass
    for i in range(6):
        if not Path(p).exists():
            return
        try:
            shutil.rmtree(p, onexc=onexc)
        except OSError:
            time.sleep(0.2 * (i + 1))
