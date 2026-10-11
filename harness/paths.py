"""Canonical filesystem layout shared by every package (WP0 contract; see docs/contracts/README.md).

Overrides (used by tests and `python -m console --check`):
  AVG_ROOT          parent of worker dirs (default C:\\avg)
  AVG_RESULTS_ROOT   results root (default <repo>/results)
"""
from __future__ import annotations

import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NAMESPACES = ("real", "mock")


def avg_root() -> Path:
    return Path(os.environ.get("AVG_ROOT", r"C:\avg"))


def results_root() -> Path:
    return Path(os.environ.get("AVG_RESULTS_ROOT", str(REPO / "results")))


def ns_dir(ns: str) -> Path:
    if ns not in NAMESPACES:
        raise ValueError(f"unknown namespace {ns!r}")
    return results_root() / ns


def runs_dir(ns: str) -> Path:
    return ns_dir(ns) / "runs"


def run_dir(ns: str, run_id: str) -> Path:
    return runs_dir(ns) / run_id


def state_path(ns: str) -> Path:
    return ns_dir(ns) / "state.json"


def manifest_path(ns: str) -> Path:
    return ns_dir(ns) / "manifest.json"


def runner_log_path(ns: str) -> Path:
    return ns_dir(ns) / "runner.log.jsonl"


def control_path(ns: str) -> Path:
    return ns_dir(ns) / "control.json"


def worker_dir(ns: str, k: int) -> Path:
    """Worker k: own node_modules + r\\ (the run in progress). Real: w<k>; mock: wm<k>; selftest: wst."""
    prefix = {"real": "w", "mock": "wm", "selftest": "wst"}[ns]
    return avg_root() / (prefix if ns == "selftest" else f"{prefix}{k}")


def workspace_dir(ns: str, k: int) -> Path:
    return worker_dir(ns, k) / "r"


def cfg_dir(ns: str, k: int) -> Path:
    prefix = {"real": "w", "mock": "wm", "selftest": "wst"}[ns]
    return avg_root() / "cfg" / (prefix if ns == "selftest" else f"{prefix}{k}")


def env_file() -> Path:
    return avg_root() / ".env"


SCENARIO = REPO / "scenario"
REPOS = SCENARIO / "repos"
SOLUTIONS = SCENARIO / "solutions"
TASKS = SCENARIO / "tasks"
CONTEXT = SCENARIO / "context"
NODE_MODULES = REPO / "node_modules"
EMPTY_GITCONFIG = REPO / "harness" / "empty.gitconfig"
UNITS = REPO / "harness" / "units.json"
CANARIES = REPO / "harness" / "canaries.json"
PREREG_LOCK = REPO / "PREREGISTRATION.lock"
TRACE_SCHEMA = REPO / "trace" / "schema" / "simulation-log-event-2.1.0.json"
CONTRACTS = REPO / "docs" / "contracts"


def tool(name: str) -> list[str]:
    """argv prefix to run a pinned Node tool from the repo's node_modules (never via cmd.exe)."""
    import shutil
    node = shutil.which("node") or "node"
    entry = {
        "tsc": NODE_MODULES / "typescript" / "bin" / "tsc",
        "depcruise": NODE_MODULES / "dependency-cruiser" / "bin" / "dependency-cruise.mjs",
    }[name]
    return [node, str(entry)]


def git_env(extra: dict | None = None) -> dict:
    """Environment for every git call made by the harness or CI (spec 2): no global/system config."""
    env = dict(os.environ)
    env["GIT_CONFIG_GLOBAL"] = str(EMPTY_GITCONFIG)
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    if extra:
        env.update(extra)
    return env


GIT_INLINE = ["-c", "core.autocrlf=false", "-c", "core.longpaths=true",
              "-c", "user.email=harness@agents-vs-gates.local", "-c", "user.name=agents-vs-gates harness",
              "-c", "commit.gpgsign=false"]
