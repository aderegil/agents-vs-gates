"""Staging oracle (spec 8): the canonical consumers' own code against the run's orders-service.

    python -m oracle.run <service_dir> [--out f]
    from oracle.run import run_oracle; run_oracle(service_dir) -> {"ok", "consumers": {name: {ok, status, message}}}

`service_dir` is any orders-service source tree (e.g. a `git archive gen` extraction). It is copied and compiled into
a cache under %TEMP% (never in place, never inside scenario/repos), so it works with no node_modules above it. The
canonical consumers (scenario/repos/{billing-service,analytics-ingest,web-storefront}) are compiled once per source
hash and cached the same way.

Each suite in oracle/suites (override with env ORACLE_SUITES_DIR) runs as `node --test <file>` with ci/netstub.mjs
preloaded and env ORACLE_ORDERS_MODULE (compiled orders-service dist/src/main.js) and ORACLE_{BILLING,ANALYTICS,
STOREFRONT}_MODULE (compiled consumers' dist/src/index.js). If the service does not yield a loadable createApp,
every consumer is `error`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ci import toolchain
from harness import paths

CONSUMERS = {  # consumer -> (suite file, env var)
    "billing-service": ("billing.test.mjs", "ORACLE_BILLING_MODULE"),
    "analytics-ingest": ("analytics.test.mjs", "ORACLE_ANALYTICS_MODULE"),
    "web-storefront": ("storefront.test.mjs", "ORACLE_STOREFRONT_MODULE"),
}
SKIP_PARTS = {"node_modules", "dist", ".ci-build", ".git"}
SUITE_TIMEOUT = 180
CACHE_KEEP = 60
BUILD_VERSION = "1"   # bump to invalidate cached builds


def cache_root() -> Path:
    return Path(os.environ.get("AVG_ORACLE_CACHE", str(Path(tempfile.gettempdir()) / "avg-oracle-cache")))


def suites_dir() -> Path:
    return Path(os.environ.get("ORACLE_SUITES_DIR", str(paths.REPO / "oracle" / "suites")))


def _files(src: Path) -> list[Path]:
    out = []
    for p in sorted(src.rglob("*")):
        if p.is_file() and not (set(p.relative_to(src).parts) & SKIP_PARTS):
            out.append(p)
    return out


def tree_hash(src: Path) -> str:
    h = hashlib.sha256(BUILD_VERSION.encode())
    tsc_pkg = paths.NODE_MODULES / "typescript" / "package.json"
    h.update(tsc_pkg.read_bytes() if tsc_pkg.exists() else b"")
    for p in _files(src):
        h.update(p.relative_to(src).as_posix().encode())
        h.update(b"\0")
        h.update(p.read_bytes())
        h.update(b"\0")
    return h.hexdigest()[:24]


def _prune(prefix: str) -> None:
    root = cache_root()
    entries = sorted((p for p in root.glob(prefix + "*") if p.is_dir()), key=lambda p: p.stat().st_mtime)
    for p in entries[:-CACHE_KEEP]:
        toolchain.rmtree(p)


def compile_tree(src: Path, kind: str, entry: str) -> dict:
    """Copy `src` into the cache and compile it to <copy>/dist (tsc emits even with type errors).
    Returns {"dir", "entry": Path|None, "tsc_code", "log", "cached"}."""
    src = Path(src)
    key = f"{kind}-{tree_hash(src)}"
    final = cache_root() / key
    meta_file = final / ".oracle-build.json"
    if meta_file.exists():
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        try:
            os.utime(final)
        except OSError:
            pass
        ent = final / meta["entry"] if meta.get("entry") else None
        return {"dir": final, "entry": ent, "tsc_code": meta.get("tsc_code"), "log": meta.get("log", ""),
                "cached": True}
    cache_root().mkdir(parents=True, exist_ok=True)
    stage = cache_root() / f".stage-{key}-{uuid.uuid4().hex[:8]}"
    stage.mkdir(parents=True)
    for p in _files(src):
        dest = stage / p.relative_to(src)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(p.read_bytes())
    if not (stage / "tsconfig.json").exists():
        log, code, ent_rel = "no tsconfig.json in the service tree", None, None
    else:
        r = toolchain.tsc_emit(stage, "dist", timeout=300, force_type_roots=True)
        code = None if r.timed_out else r.code
        log = r.text[-4000:] if not r.timed_out else "tsc timed out"
        ent = toolchain.find_entry(stage / "dist", entry)
        ent_rel = ent.relative_to(stage).as_posix() if ent else None
    (stage / ".oracle-build.json").write_text(json.dumps({"entry": ent_rel, "tsc_code": code, "log": log}),
                                              encoding="utf-8")
    try:
        os.replace(stage, final)
    except OSError:
        toolchain.rmtree(stage)     # another process won the race; use its build
        if not meta_file.exists():
            raise
    _prune(kind)
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    ent = final / meta["entry"] if meta.get("entry") else None
    return {"dir": final, "entry": ent, "tsc_code": meta.get("tsc_code"), "log": meta.get("log", ""), "cached": False}


def compile_service(service_dir: Path) -> dict:
    return compile_tree(Path(service_dir), "svc", "main.js")


def consumer_modules() -> dict[str, Path]:
    out = {}
    for name in CONSUMERS:
        b = compile_tree(paths.REPOS / name, f"cons-{name}", "index.js")
        if b["entry"] is None:
            raise RuntimeError(f"canonical consumer {name} did not compile: {b['log'][-500:]}")
        out[name] = b["entry"]
    return out


PROBE_JS = (
    "const u = process.argv[1];"
    "let m; try { m = await import(u); } catch (e) { console.log('IMPORT_FAILED ' + (e && e.message)); process.exit(3); }"
    "if (typeof m.createApp !== 'function') { console.log('NO_CREATEAPP'); process.exit(4); }"
    "console.log('OK');"
)


def probe_service(main_js: Path) -> str | None:
    """None if `createApp` loads; otherwise the reason."""
    r = toolchain.run([toolchain.node(), toolchain.netstub_flag(), "--input-type=module", "-e", PROBE_JS,
                       Path(main_js).as_uri()], Path(main_js).parent, env=toolchain.base_env(), timeout=60)
    if r.timed_out:
        return "loading the compiled service timed out"
    if r.code == 0:
        return None
    if "NO_CREATEAPP" in r.out:
        return "the compiled service does not export createApp"
    return "the compiled service cannot be loaded: " + r.text[-600:]


# ---- running suites -------------------------------------------------------------------------------------------

def _summarize_tap(text: str) -> tuple[int, int, list[str]]:
    """(tests, failed, details) from TAP output of node --test."""
    tests = failed = 0
    m = re.search(r"^# tests (\d+)", text, re.M)
    if m:
        tests = int(m.group(1))
    m = re.search(r"^# fail (\d+)", text, re.M)
    if m:
        failed = int(m.group(1))
    details = []
    lines = text.splitlines()
    for i, l in enumerate(lines):
        mm = re.match(r"^\s*not ok \d+ - (.*)$", l)
        if not mm:
            continue
        name = mm.group(1).strip()
        # Skip parent "describe" failures whose children already reported (they say "N subtests failed")
        block = "\n".join(lines[i + 1:i + 40])
        if "subtests failed" in block or "subtestsFailed" in block:
            continue
        err = re.search(r"^\s*error:\s*(.*)$", block, re.M)
        msg = err.group(1).strip().strip("'|>-").strip() if err else ""
        if msg in ("", "|-", ">-", "|"):
            # multi-line YAML string: take the next non-empty line
            idx = block.find("error:")
            tail = [t.strip() for t in block[idx:].splitlines()[1:4] if t.strip()] if idx >= 0 else []
            msg = tail[0] if tail else ""
        details.append(f"{name}: {msg}"[:400] if msg else name[:400])
    return tests, failed, details


def run_suite(consumer: str, orders_module: Path, modules: dict[str, Path], extra_env: dict | None = None) -> dict:
    suite_file, _ = CONSUMERS[consumer]
    suite = suites_dir() / suite_file
    if not suite.exists():
        return {"ok": False, "status": "error", "message": f"oracle suite {suite_file} not found"}
    env = toolchain.base_env(ORACLE_ORDERS_MODULE=str(orders_module), NETSTUB_STOCK_AVAILABLE="1000")
    for name, (_, var) in CONSUMERS.items():
        env[var] = str(modules[name])
    env.update(extra_env or {})
    argv = [toolchain.node(), toolchain.netstub_flag(), "--test", "--test-reporter=tap", str(suite)]
    r = toolchain.run(argv, suite.parent, env=env, timeout=SUITE_TIMEOUT)
    if r.timed_out:
        return {"ok": False, "status": "error", "message": f"suite timed out after {SUITE_TIMEOUT}s"}
    tests, failed, details = _summarize_tap(r.out)
    if r.code == 0:
        return {"ok": True, "status": "pass", "message": f"{tests} tests passed"}
    if tests == 0 and not details:
        return {"ok": False, "status": "error", "message": "suite did not run: " + r.text[-800:]}
    head = f"{failed or len(details)} of {tests} tests failed"
    return {"ok": False, "status": "fail", "message": (head + ": " + " | ".join(details))[:1800]}


def run_suites(orders_module: Path, modules: dict[str, Path], extra_env: dict | None = None) -> dict:
    with ThreadPoolExecutor(max_workers=len(CONSUMERS)) as pool:
        futs = {c: pool.submit(run_suite, c, orders_module, modules, extra_env) for c in CONSUMERS}
        consumers = {c: f.result() for c, f in futs.items()}
    return {"ok": all(v["ok"] for v in consumers.values()), "consumers": consumers}


def _all_error(message: str) -> dict:
    return {"ok": False, "consumers": {c: {"ok": False, "status": "error", "message": message} for c in CONSUMERS}}


def run_oracle(service_dir: Path) -> dict:
    service_dir = Path(service_dir)
    try:
        build = compile_service(service_dir)
    except Exception as ex:  # noqa: BLE001 — any build failure means the service is not deployable
        return _all_error(f"orders-service did not compile: {type(ex).__name__}: {ex}")
    if build["entry"] is None:
        return _all_error("orders-service did not compile (no dist/src/main.js): " + build["log"][-600:])
    why = probe_service(build["entry"])
    if why:
        return _all_error(why)
    modules = consumer_modules()
    return run_suites(build["entry"], modules)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m oracle.run")
    ap.add_argument("service_dir")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    t0 = time.monotonic()
    verdict = run_oracle(Path(a.service_dir))
    text = json.dumps(verdict, indent=2, ensure_ascii=False)
    if a.out:
        Path(a.out).write_text(text + "\n", encoding="utf-8", newline="\n")
    print(text)
    print(f"({time.monotonic() - t0:.1f}s)", file=sys.stderr)
    return 0 if verdict["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
