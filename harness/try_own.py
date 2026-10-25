"""Try it on your own repo, rules and tickets (harness.try_rules --repo …; docs/USING.md, "Your repo, your rules, your
tickets"). Coordinator's order 2026-10-24, scope agreed the same day.

What runs:
  - the agent works on a clean copy of your repo folder (no .git, no history, no remotes), with your rules file as its
    context file; nothing else is in its workspace;
  - your CI is one command (--ci) run in that copy: exit 0 passes, anything else fails, and its output (the tail, as
    the experiment's CI feedback) goes back to the agent for up to 3 repairs;
  - "the other teams" are tests you bring (--their-tests <folder>, one subfolder per team, and --their-cmd): they run
    outside the workspace, on a copy of the result (first attempt and final), with SERVICE_DIR pointing at it; the
    agent never sees them;
  - optionally --accept-cmd says whether the ticket is done (exit 0; run from the folder the try starts in, with
    SERVICE_DIR and TICKET set) and --setup-cmd runs once in each fresh copy.

What does not: the scenario's ARCH-1..8, contracts and consumer repos (your CI is yours), several repos in the
agent's workspace (V1/V2), installing dependencies for you, git URLs, and any comparison with the experiment.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from harness import gitutil, paths

CMD_TIMEOUT_S = 900
FEEDBACK_LIMIT = 6000
MAX_TICKET_BYTES = 64 * 1024
COPY_SKIP = {".git", ".hg", ".svn", "__pycache__", ".venv", ".DS_Store"}
SECRET_ENV = re.compile(r"(TOKEN|SECRET|API_KEY|PASSWORD|OAUTH|CREDENTIAL)", re.I)
CHECK_ID = "your-ci"


class OwnRefused(Exception):
    pass


@dataclass
class OwnTicket:
    id: str
    path: Path
    text: str


@dataclass
class OwnProject:
    repo: Path
    ci_cmd: str | None
    their_tests: Path | None
    their_cmd: str | None
    accept_cmd: str | None = None
    setup_cmd: str | None = None
    tickets: dict[str, OwnTicket] = field(default_factory=dict)
    launch_dir: Path = field(default_factory=Path.cwd)

    def describe(self) -> dict:
        return {"repo": str(self.repo), "ci_cmd": self.ci_cmd, "their_tests": str(self.their_tests) if self.their_tests
                else None, "their_cmd": self.their_cmd, "accept_cmd": self.accept_cmd, "setup_cmd": self.setup_cmd,
                "teams": teams(self.their_tests) if self.their_tests else []}


# ---------------------------------------------------------------- inputs -----------------------------------------

def _overlap(a: Path, b: Path) -> bool:
    a, b = a.resolve(), b.resolve()
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


def forbidden_roots() -> dict[str, Path]:
    """Folders a user repo or their tests must never be in, or contain: the experiment's data and inputs."""
    out = {f"results/{ns}": paths.ns_dir(ns) for ns in paths.NAMESPACES}
    out.update({"scenario/": paths.SCENARIO, "oracle/": paths.REPO / "oracle", "ci/": paths.REPO / "ci",
                "harness/": paths.REPO / "harness"})
    return out


def check_folder(flag: str, p: Path) -> Path:
    p = Path(p)
    if not p.is_dir():
        raise OwnRefused(f"{flag} {p}: no such folder")
    for label, root in forbidden_roots().items():
        if _overlap(p, root):
            raise OwnRefused(f"{flag} {p}: overlaps the experiment's {label}; use a folder of your own")
    # the experiment's repo itself (the examples/ folder inside it is fine)
    if p.resolve() == paths.REPO.resolve() or paths.REPO.resolve().is_relative_to(p.resolve()):
        raise OwnRefused(f"{flag} {p}: is (or contains) the experiment's repo")
    return p.resolve()


def safe_id(stem: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-")[:40]
    return s or "ticket"


def load_ticket_file(p: Path) -> OwnTicket:
    raw = p.read_bytes()
    if len(raw) > MAX_TICKET_BYTES:
        raise OwnRefused(f"--tickets {p}: {len(raw):,} bytes; one ticket is at most {MAX_TICKET_BYTES:,}")
    try:
        text = raw.decode("utf-8-sig").replace("\r\n", "\n").strip()
    except UnicodeDecodeError:
        raise OwnRefused(f"--tickets {p}: not UTF-8 text") from None
    if not text:
        raise OwnRefused(f"--tickets {p}: the file is empty")
    return OwnTicket(id=safe_id(p.stem), path=p.resolve(), text=text + "\n")


def teams(their_tests: Path) -> list[str]:
    subs = sorted(d.name for d in their_tests.iterdir() if d.is_dir() and d.name not in COPY_SKIP)
    return subs or [their_tests.name]


def make_project(a) -> OwnProject:
    repo = check_folder("--repo", Path(a.repo))
    their = check_folder("--their-tests", Path(a.their_tests)) if a.their_tests else None
    if their and _overlap(their, repo):
        raise OwnRefused("--their-tests must be outside --repo: the agent would see the other teams' tests")
    if bool(a.their_tests) != bool(a.their_cmd):
        raise OwnRefused("--their-tests and --their-cmd go together (the folder and the command that runs it)")
    return OwnProject(repo=repo, ci_cmd=a.ci, their_tests=their, their_cmd=a.their_cmd, accept_cmd=a.accept_cmd,
                      setup_cmd=a.setup_cmd)


# ---------------------------------------------------------------- commands ---------------------------------------

def _env(extra: dict | None = None) -> dict:
    env = {k: v for k, v in os.environ.items() if not SECRET_ENV.search(k)}
    env.update(extra or {})
    return env


def run_cmd(cmd: str, cwd: Path, extra_env: dict | None = None, timeout: int = CMD_TIMEOUT_S) -> dict:
    t0 = time.monotonic()
    try:
        r = subprocess.run(cmd, cwd=str(cwd), shell=True, env=_env(extra_env), capture_output=True, timeout=timeout)
        out = (r.stdout or b"").decode("utf-8", "replace") + (r.stderr or b"").decode("utf-8", "replace")
        code = r.returncode
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b"") + (e.stderr or b"")).decode("utf-8", "replace") + f"\n(timed out after {timeout}s)"
        code = -1
    return {"code": code, "output": out, "ms": int((time.monotonic() - t0) * 1000)}


def _tail(text: str, limit: int) -> str:
    text = text.strip("\n")
    if len(text) <= limit:
        return text
    marker = "… (truncated)\n"
    return marker + text[-(limit - len(marker)):]


# ---------------------------------------------------------------- workspace --------------------------------------

def _copy_tree(src: Path, dst: Path) -> None:
    shutil.copytree(src, dst, ignore=lambda d, names: [n for n in names if n in COPY_SKIP], dirs_exist_ok=True)


def materialize_own(project: OwnProject, *, ns: str, worker: int, unit: str, ticket: str, units: dict,
                    context_text: str):
    """The agent's workspace: a clean copy of the user's repo, the rules file as its context file, a `base` commit."""
    from harness.workspace import Workspace, wipe
    from harness import scenario_io
    adapter = units[unit]["adapter"]
    wdir, root, cfg = paths.worker_dir(ns, worker), paths.workspace_dir(ns, worker), paths.cfg_dir(ns, worker)
    for d in (wdir, cfg):
        d.mkdir(parents=True, exist_ok=True)
    wipe(root)
    wipe(cfg)
    for p in wdir.glob("snap-*"):
        gitutil.rmtree(p)
    ctx_name = units[unit].get("context_file") or scenario_io.context_name(adapter)
    root.mkdir(parents=True, exist_ok=True)
    _copy_tree(project.repo, root)
    (root / ctx_name).write_text(context_text, encoding="utf-8", newline="\n")
    ws = Workspace(ns=ns, worker=worker, unit=unit, adapter=adapter, ticket=ticket, V="V0", S="custom", root=root,
                   cfg=cfg, worker_dir=wdir, context_file=ctx_name, service_prefix="")
    if project.setup_cmd:
        r = run_cmd(project.setup_cmd, root)
        ws.notes.append(f"setup-cmd exit {r['code']}")
        if r["code"] != 0:
            raise OwnRefused(f"--setup-cmd failed in the fresh copy (exit {r['code']}):\n{_tail(r['output'], 2000)}")
    gitutil.init_commit(root, "base")
    return ws


# ---------------------------------------------------------------- pipeline ---------------------------------------

class OwnPipeline:
    """The experiment's three gates, the user's way: their CI command, their other teams' tests, their acceptance."""

    def __init__(self, project: OwnProject):
        self.p = project

    def run_ci(self, ws_root: Path, V: str, run_id: str) -> dict:
        if not self.p.ci_cmd:
            return {"ok": True, "checks": [], "feedback_text": "", "note": "no CI (--ci not given): nothing gates the PR"}
        r = run_cmd(self.p.ci_cmd, Path(ws_root))
        ok = r["code"] == 0
        out = _tail(r["output"], FEEDBACK_LIMIT)
        status = "pass" if ok else "fail"
        head = f"{CHECK_ID} {'PASS' if ok else 'FAIL'}: `{self.p.ci_cmd}` exited {r['code']}"
        return {"ok": ok, "checks": [{"id": CHECK_ID, "rule": self.p.ci_cmd, "category": "test", "status": status,
                                      "duration_ms": r["ms"], "output": head + ("\n" + out if out else "")}],
                "feedback_text": "" if ok else _tail(head + "\n" + out, FEEDBACK_LIMIT)}

    def run_oracle(self, service_dir: Path) -> dict:
        if not self.p.their_tests:
            return {"ok": True, "consumers": {}, "note": "no other teams' tests (--their-tests not given)"}
        service_dir = Path(service_dir)
        work = service_dir.parent / f"{service_dir.name}-their-tests"
        if work.exists():
            gitutil.rmtree(work)
        _copy_tree(self.p.their_tests, work)
        subs = [d for d in sorted(work.iterdir()) if d.is_dir() and d.name not in COPY_SKIP]
        targets = subs or [work]
        consumers = {}
        for d in targets:
            name = d.name if subs else self.p.their_tests.name
            r = run_cmd(self.p.their_cmd, d, {"SERVICE_DIR": str(service_dir)})
            ok = r["code"] == 0
            consumers[name] = {"ok": ok, "status": "pass" if ok else "fail",
                               "message": "ok" if ok else _tail(r["output"], 400), "tests": f"exit {r['code']}"}
        gitutil.rmtree(work)
        return {"ok": all(v["ok"] for v in consumers.values()), "consumers": consumers}

    def check_ticket(self, service_dir: Path, ticket: str) -> dict:
        base = {"ticket": ticket, "captured": {}, "arch9_signal": False, "arch9_fields": []}
        if not self.p.accept_cmd:
            return {**base, "ticket_done": None, "detail": "not evaluated (no --accept-cmd)"}
        # from the folder the try was started in (relative paths work), like the other teams' tests: SERVICE_DIR is
        # the copy of the result, TICKET the ticket's id (its file name without the extension)
        r = run_cmd(self.p.accept_cmd, self.p.launch_dir, {"SERVICE_DIR": str(Path(service_dir)), "TICKET": ticket})
        return {**base, "ticket_done": "done" if r["code"] == 0 else "not_done",
                "detail": f"--accept-cmd exit {r['code']}"}


# ---------------------------------------------------------------- mock -------------------------------------------

def load_mock_scripts(path: str | None) -> dict:
    """--mock-script my-mock.json: {"<ticket id>": {"gen": "<patch file>", "repairs": ["<patch file>", …]}}. Patch
    paths are relative to the JSON file. A ticket with no entry makes no change (the mock never edits on its own)."""
    if not path:
        return {}
    p = Path(path)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise OwnRefused(f"--mock-script {path}: {e}") from None
    out = {}
    for tid, s in data.items():
        if tid.startswith("_"):
            continue
        fix = lambda v: None if v is None else "file:" + str((p.parent / v).resolve())
        out[tid] = {**s, "gen": fix(s.get("gen")), "repairs": [fix(v) for v in s.get("repairs") or []]}
    return out
