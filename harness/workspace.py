"""Materialize one run's workspace (spec 10.2, 5.7, 5.8).

    ws = materialize(ns, worker, unit, ticket, V, S)    # ns: "real" | "mock" | "selftest" (worker-dir family)

Wipes <worker>\\r and the worker's cfg dir, copies the repos the visibility condition allows (never
`architecture/`, `oracle/`, `solutions/`), writes the S context file named for the unit's CLI, adds the V1 extras,
strips canaries from legitimately copied consumer material, then `git init` + commit/tag `base`.
"""
from __future__ import annotations

import json
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

from harness import gitutil, paths, scenario_io

COPY_IGNORE = shutil.ignore_patterns("node_modules", "dist", ".ci-build", ".git")
V1_CONTRACTS = ("billing-service__OrderPlaced.json", "analytics-ingest__OrderPlaced.json",
                "analytics-ingest__OrderCancelled.json")
CHECKER_CANDIDATES = ("ci/verify-contracts.mjs", "ci/checks/verify-contracts.mjs", "ci/contracts/verify-contracts.mjs",
                      "ci/verify-consumer-contracts.mjs", "ci/checks/verify-consumer-contracts.mjs")
TEXT_SUFFIXES = {".ts", ".js", ".mjs", ".cjs", ".md", ".json", ".yaml", ".yml", ".txt"}


@dataclass
class Workspace:
    ns: str
    worker: int
    unit: str
    adapter: str
    ticket: str | None
    V: str
    S: str
    root: Path
    cfg: Path
    worker_dir: Path
    context_file: str
    service_prefix: str = ""
    notes: list = field(default_factory=list)
    mock_script: dict | None = None      # mock adapter only: overrides the harness/mock_scripts.json lookup

    @property
    def service_dir(self) -> Path:
        return self.root / self.service_prefix.rstrip("/") if self.service_prefix else self.root

    def snap_dir(self, ref: str) -> Path:
        return self.worker_dir / f"snap-{ref}"

    def commit(self, ref: str) -> None:
        return gitutil.commit_all(self.root, ref)

    def diff(self, a: str, b: str) -> str:
        return gitutil.diff(self.root, a, b)

    def archive(self, ref: str) -> Path:
        """`git archive ref` into <worker>\\snap-<ref>; returns the orders-service dir inside it."""
        dest = gitutil.archive_to(self.root, ref, self.snap_dir(ref))
        return dest / self.service_prefix.rstrip("/") if self.service_prefix else dest

    def bundle(self, out: Path) -> None:
        gitutil.bundle(self.root, out)

    def clean(self) -> None:
        wipe(self.root)
        for p in self.worker_dir.glob("snap-*"):
            gitutil.rmtree(p)


def wipe(d: Path) -> None:
    """Empty a directory (retrying briefly: Windows may hold a handle for a moment after a process exits)."""
    for i in range(10):
        try:
            gitutil.rmtree(d)
            break
        except OSError:
            time.sleep(0.3 * (i + 1))
    d.mkdir(parents=True, exist_ok=True)


def strip_canaries_text(text: str) -> str:
    return "".join(l for l in text.splitlines(keepends=True) if "CANARY-" not in l)


def strip_canary_file(p: Path) -> None:
    if p.suffix not in TEXT_SUFFIXES:
        return
    raw = p.read_text(encoding="utf-8")
    if "CANARY-" not in raw:
        return
    stripped = strip_canaries_text(raw)
    if p.suffix == ".json":
        # Prefer dropping the canary line (keeps the file byte-identical otherwise); re-serialize only if that
        # leaves invalid JSON (e.g. "_canary" was the last key) or a "_canary" key on a shared line.
        try:
            ok = "_canary" not in json.loads(stripped)
        except (ValueError, TypeError):
            ok = False
        if not ok:
            data = json.loads(raw)
            if isinstance(data, dict):
                data.pop("_canary", None)
            stripped = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    p.write_text(stripped, encoding="utf-8", newline="\n")


def strip_canaries_tree(d: Path) -> None:
    for p in d.rglob("*"):
        if p.is_file():
            strip_canary_file(p)


def contract_checker() -> Path | None:
    for rel in CHECKER_CANDIDATES:
        if (paths.REPO / rel).exists():
            return paths.REPO / rel
    hits = sorted((paths.REPO / "ci").rglob("*verify*contract*.mjs")) if (paths.REPO / "ci").exists() else []
    return hits[0] if hits else None


def add_npm_script(pkg: Path, name: str, command: str) -> None:
    """Insert one script into package.json's "scripts" block textually (keeps the file's formatting)."""
    text = pkg.read_text(encoding="utf-8")
    m = re.search(r'"scripts"\s*:\s*\{(?P<body>[^{}]*)\}', text)
    if not m:
        data = json.loads(text)
        data.setdefault("scripts", {})[name] = command
        pkg.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8", newline="\n")
        return
    body = m.group("body")
    stripped = body.rstrip()
    indent = re.search(r'\n(\s*)"', body)
    ind = indent.group(1) if indent else "    "
    new_body = stripped + ("," if stripped.strip() else "") + f'\n{ind}"{name}": {json.dumps(command)}' + body[len(stripped):]
    pkg.write_text(text[:m.start("body")] + new_body + text[m.end("body"):], encoding="utf-8", newline="\n")


def _v1_extras(service: Path, notes: list) -> None:
    broker = paths.REPOS / "architecture" / "broker"
    dest = service / "contracts" / "consumers"
    dest.mkdir(parents=True, exist_ok=True)
    for name in V1_CONTRACTS:
        src = broker / name
        if not src.exists():
            notes.append(f"V1: broker contract {name} missing")
            continue
        shutil.copyfile(src, dest / name)
        strip_canary_file(dest / name)
    checker = contract_checker()
    (service / "scripts").mkdir(exist_ok=True)
    if checker:
        shutil.copyfile(checker, service / "scripts" / "verify-contracts.mjs")
        strip_canary_file(service / "scripts" / "verify-contracts.mjs")
    else:
        notes.append("V1: CI contract checker not found under ci/ (WP1 pending); scripts/verify-contracts.mjs not copied")
    add_npm_script(service / "package.json", "contracts", "node scripts/verify-contracts.mjs")


def materialize(ns: str, worker: int, unit: str, ticket: str | None, V: str, S: str, *,
                units: dict | None = None) -> Workspace:
    units = units or json.loads(paths.UNITS.read_text(encoding="utf-8"))
    adapter = units[unit]["adapter"]
    wdir = paths.worker_dir(ns, worker)
    root = paths.workspace_dir(ns, worker)
    cfg = paths.cfg_dir(ns, worker)
    wipe(root)
    wipe(cfg)
    for p in wdir.glob("snap-*"):
        gitutil.rmtree(p)
    ctx_name = scenario_io.context_name(adapter)
    ws = Workspace(ns=ns, worker=worker, unit=unit, adapter=adapter, ticket=ticket, V=V, S=S, root=root, cfg=cfg,
                   worker_dir=wdir, context_file=ctx_name, service_prefix="orders-service/" if V == "V2" else "")
    ctx = scenario_io.context_text(S)
    if V in ("V0", "V1"):
        shutil.copytree(paths.REPOS / "orders-service", root, ignore=COPY_IGNORE, dirs_exist_ok=True)
        (root / ctx_name).write_text(ctx, encoding="utf-8", newline="\n")
        if V == "V1":
            _v1_extras(root, ws.notes)
    elif V == "V2":
        for repo in ("orders-service",) + scenario_io.CONSUMERS:
            shutil.copytree(paths.REPOS / repo, root / repo, ignore=COPY_IGNORE)
            if repo != "orders-service":
                strip_canaries_tree(root / repo)
        (root / ctx_name).write_text(scenario_io.V2_LINE + "\n\n" + ctx, encoding="utf-8", newline="\n")
    else:
        raise ValueError(f"unknown visibility {V!r}")
    gitutil.init_commit(root, "base")
    return ws
