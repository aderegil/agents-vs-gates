"""M0 environment check and worker setup (spec 2, 4 M0, 10.2).

  python -m harness.doctor                      check everything, print OK/FAIL lines
  python -m harness.doctor --json               same, machine-readable (used by the console Readiness plugin)
  python -m harness.doctor --setup-workers 3    npm ci in C:\\avg\\w1..w3 (real); add --ns mock|selftest for wm<k> / wst
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from harness import paths

CONTEXT_NAMES = ("CLAUDE.md", "AGENTS.md", "GEMINI.md", ".claude", ".codex", ".agents", ".agent")   # .agents/.agent: agy workspace rules


def _run(argv: list[str], cwd: Path | None = None, timeout: int = 60) -> tuple[int, str]:
    try:
        p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return 127, str(e)


def _version(name: str, args=("--version",)) -> tuple[bool, str]:
    exe = shutil.which(name)
    if not exe:
        return False, "not found on PATH"
    rc, out = _run([exe, *args])
    return rc == 0, out.splitlines()[0] if out else f"exit {rc}"


def codex_native_entry() -> str | None:
    """The native codex.exe the npm shim points to (never go through cmd.exe, spec 10.9)."""
    shim = shutil.which("codex")
    if not shim:
        return None
    base = Path(shim).parent / "node_modules" / "@openai" / "codex"
    for p in base.rglob("codex.exe"):
        if p.parent.name == "bin":
            return str(p)
    js = base / "bin" / "codex.js"
    return str(js) if js.exists() else None


def sanitize(text: str) -> str:
    return re.sub(r"(?i)C:\\Users\\[^\\\s\"']+", "~", text)


def ancestors_clean(probe: Path) -> tuple[bool, list[str]]:
    hits = []
    for parent in probe.parents:
        for name in CONTEXT_NAMES:
            if (parent / name).exists():
                hits.append(str(parent / name))
    return not hits, hits


def leaky_config() -> dict:
    home = Path.home() / ".claude"
    out = {
        "managed_settings": [p for p in (r"C:\Program Files\ClaudeCode\managed-settings.json",
                                         r"C:\ProgramData\ClaudeCode\managed-settings.json") if Path(p).exists()],
        "user_claude_dir": {n: (home / n).exists() for n in ("settings.json", "remote-settings-consent.json",
                                                             "policy-limits.json", "hook-pretool.ps1", "skills", "plugins")},
    }
    try:
        s = json.loads((home / "settings.json").read_text(encoding="utf-8"))
        out["user_settings_keys"] = sorted(s.keys())
        out["user_hooks"] = sorted((s.get("hooks") or {}).keys())
    except (OSError, ValueError):
        pass
    return out


def worker_ready(ns: str, k: int) -> bool:
    w = paths.worker_dir(ns, k)
    return (w / "node_modules" / "typescript" / "package.json").exists() and \
           (w / "node_modules" / "dependency-cruiser" / "package.json").exists()


def setup_worker(ns: str, k: int) -> tuple[bool, str]:
    w = paths.worker_dir(ns, k)
    w.mkdir(parents=True, exist_ok=True)
    (w / "r").mkdir(exist_ok=True)
    for f in ("package.json", "package-lock.json"):
        shutil.copyfile(paths.REPO / f, w / f)
    npm = shutil.which("npm")
    if not npm:
        return False, "npm not found"
    rc, out = _run([npm, "ci", "--no-audit", "--no-fund"], cwd=w, timeout=600)
    paths.cfg_dir(ns, k).mkdir(parents=True, exist_ok=True)
    return rc == 0, out.splitlines()[-1] if out else ""


def checks(workers: int = 2) -> list[dict]:
    res = []

    def add(name, ok, detail="", required=True):
        res.append({"name": name, "ok": bool(ok), "detail": sanitize(str(detail)), "required": required})

    for tool in ("node", "npm", "git"):
        ok, v = _version(tool)
        add(tool, ok, v)
    in_venv = Path(sys.executable).resolve().is_relative_to((paths.REPO / ".venv").resolve())
    add("python (repo venv)", in_venv and sys.version_info[:2] >= (3, 13), f"{sys.version.split()[0]} {sys.executable}")
    try:
        import jsonschema  # noqa: F401
        add("jsonschema", True, "importable")
    except ImportError:
        add("jsonschema", False, "pip install jsonschema in .venv")
    ok, v = _version("claude")
    add("claude --version", ok, v)
    ok, v = _version("codex")
    add("codex --version", ok, v)
    entry = codex_native_entry()
    add("codex native entry", bool(entry), entry or "not found", required=False)
    ok, v = _version("agy")
    add("agy --version (addendum 1, unit agy-flash)", ok, v, required=False)
    for tool, rel in (("typescript", "typescript/package.json"), ("dependency-cruiser", "dependency-cruiser/package.json")):
        p = paths.NODE_MODULES / rel
        ver = json.loads(p.read_text(encoding="utf-8"))["version"] if p.exists() else None
        add(f"{tool} (repo node_modules)", ver in ("6.0.3", "18.5.0"), ver or "missing")
    add("package-lock.json", (paths.REPO / "package-lock.json").exists(), "versioned lockfile")
    probe = paths.workspace_dir("real", 1)
    ok, hits = ancestors_clean(probe)
    add(f"no context files above {probe}", ok, ", ".join(hits) or "CLAUDE.md/AGENTS.md/GEMINI.md/.claude/.codex/.agents/.agent absent in ancestors")
    g = paths.EMPTY_GITCONFIG
    add("GIT_CONFIG_GLOBAL file empty", g.exists() and g.stat().st_size == 0, str(g.relative_to(paths.REPO)))
    for k in range(1, workers + 1):
        add(f"worker w{k} node_modules", worker_ready("real", k), str(paths.worker_dir("real", k)))
    env = paths.env_file()
    has_token = False
    if env.exists():
        has_token = any(l.strip().startswith("CLAUDE_CODE_OAUTH_TOKEN=") and len(l.strip()) > 24
                        for l in env.read_text(encoding="utf-8").splitlines())
    add("C:\\avg\\.env has CLAUDE_CODE_OAUTH_TOKEN", has_token, "present" if has_token else "missing (needed only for real runs)", required=False)
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m harness.doctor")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--workers", type=int, default=2, help="how many real workers must be ready")
    ap.add_argument("--setup-workers", type=int, metavar="N")
    ap.add_argument("--ns", default="real", choices=["real", "mock", "selftest"])
    a = ap.parse_args(argv)
    if a.setup_workers:
        ks = [1] if a.ns == "selftest" else range(1, a.setup_workers + 1)
        ok_all = True
        for k in ks:
            ok, msg = setup_worker(a.ns, k)
            ok_all &= ok
            print(f"{'OK  ' if ok else 'FAIL'} setup {paths.worker_dir(a.ns, k)}: {msg}")
        return 0 if ok_all else 1
    res = checks(a.workers)
    overall = all(r["ok"] for r in res if r["required"])
    if a.json:
        print(json.dumps({"ok": overall, "checks": res, "leaky_config": leaky_config()}, indent=2))
    else:
        for r in res:
            tag = "OK  " if r["ok"] else ("FAIL" if r["required"] else "WARN")
            print(f"{tag} {r['name']}: {r['detail']}")
        print("DOCTOR OK" if overall else "DOCTOR FAILED")
    return 0 if overall else 1


if __name__ == "__main__":
    sys.exit(main())
