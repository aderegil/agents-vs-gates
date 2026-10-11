"""The experiment's CI (spec 7): deterministic, no network, no LLM.

    python -m ci.run <workspace> [--visibility V0|V1|V2] [--run-id ID] [--out verdict.json]
    from ci.run import run_ci, feedback_message

Checks, in order, all always run (none short-circuits another):
    typecheck (build)  unit-tests (test)  ARCH-1 ARCH-2 ARCH-3 (gate)  ARCH-4 (contract)  ARCH-5 ARCH-6 ARCH-7 (gate)
    ARCH-8 (contract)
`error` = the check could not run (e.g. createApp is gone); it counts as a CI failure.

The broker, catalog and PII baseline are copied from scenario/repos/architecture to %TEMP%\\avg-ci-<runid>-* (outside
the workspace) and deleted at the end (spec 7.3). In V1, ARCH-4 uses the workspace's contracts/consumers/*.json with
CI's own checker (ci/verify-contracts.mjs); ARCH-8 always uses the central broker.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ci import catalog as catalog_mod
from ci import scans, toolchain
from harness import paths

CHECKS = [("typecheck", None, "build"), ("unit-tests", None, "test"), ("ARCH-1", "ARCH-1", "gate"),
          ("ARCH-2", "ARCH-2", "gate"), ("ARCH-3", "ARCH-3", "gate"), ("ARCH-4", "ARCH-4", "contract"),
          ("ARCH-5", "ARCH-5", "gate"), ("ARCH-6", "ARCH-6", "gate"), ("ARCH-7", "ARCH-7", "gate"),
          ("ARCH-8", "ARCH-8", "contract")]
FEEDBACK_LIMIT = 6000
CI_BUILD = ".ci-build"
ARCH_SRC = paths.REPOS / "architecture"
TSC_TIMEOUT = 300
TEST_TIMEOUT = 420
DEPCRUISE_TIMEOUT = 300
PROBE_TIMEOUT = 120


def detect_visibility(workspace: Path) -> str:
    ws = Path(workspace)
    if (ws / "orders-service" / "package.json").exists():
        return "V2"
    if (ws / "contracts" / "consumers").is_dir():
        return "V1"
    return "V0"


def service_dir(workspace: Path, visibility: str) -> Path:
    return Path(workspace) / "orders-service" if visibility == "V2" else Path(workspace)


def materialize_architecture(run_id: str) -> Path:
    """Copy broker/, catalog/ and pii-baseline.json to a temp folder outside every workspace (spec 7.3)."""
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", run_id)[:60] or "adhoc"
    tmp = Path(tempfile.mkdtemp(prefix=f"avg-ci-{safe}-"))
    shutil.copytree(ARCH_SRC / "broker", tmp / "broker")
    shutil.copytree(ARCH_SRC / "catalog", tmp / "catalog")
    shutil.copyfile(ARCH_SRC / "pii-baseline.json", tmp / "pii-baseline.json")
    return tmp


def _check(cid: str, status: str, output: str, ms: int) -> dict:
    rule, category = next((r, c) for i, r, c in CHECKS if i == cid)
    return {"id": cid, "rule": rule, "category": category, "status": status, "duration_ms": max(0, int(ms)),
            "output": output.rstrip("\n")}


def _tail(text: str, n: int) -> str:
    text = text.strip("\n")
    return text if len(text) <= n else "…\n" + text[-n:]


# ---- individual stages ---------------------------------------------------------------------------------------

def _stage_tsc(svc: Path) -> dict:
    build = svc / CI_BUILD
    toolchain.rmtree(build)
    r = toolchain.tsc_emit(svc, CI_BUILD, timeout=TSC_TIMEOUT)
    if r.timed_out:
        return {"status": "error", "output": f"typecheck ERROR: tsc timed out after {TSC_TIMEOUT}s", "ms": r.duration_ms,
                "main": None}
    main = toolchain.find_entry(build, "main.js")
    diag = r.text.strip()
    if r.code == 0:
        out = "typecheck PASS: tsc reported no errors"
        status = "pass"
    else:
        n = len(re.findall(r"error TS\d+", diag))
        out = f"typecheck FAIL: tsc reported {n} error(s)\n" + _tail(diag, 3500)
        status = "fail"
    return {"status": status, "output": out, "ms": r.duration_ms, "main": main}


def _stage_tests(svc: Path) -> dict:
    env = toolchain.base_env(NODE_OPTIONS=toolchain.netstub_flag())
    r = toolchain.run([toolchain.npm(), "test"], svc, env=env, timeout=TEST_TIMEOUT)
    if r.timed_out:
        return {"status": "error", "output": f"unit-tests ERROR: npm test timed out after {TEST_TIMEOUT}s\n"
                                             + _tail(r.text, 2000), "ms": r.duration_ms}
    text = r.text
    summary = [l.strip() for l in text.splitlines() if re.match(r"^\s*(ℹ|#)\s*(tests|pass|fail|skipped|todo|cancelled)\b", l)]
    if r.code == 0:
        return {"status": "pass", "output": "unit-tests PASS: npm test exited 0" + (
            "\n" + "\n".join(summary) if summary else ""), "ms": r.duration_ms}
    return {"status": "fail", "output": f"unit-tests FAIL: npm test exited {r.code}\n" + _tail(text, 3500),
            "ms": r.duration_ms}


def _stage_depcruise(svc: Path) -> dict:
    argv = toolchain.tool("depcruise") + ["src", "--config", ".dependency-cruiser.cjs", "--ignore-known",
                                          "--output-type", "json", "--no-progress"]
    r = toolchain.run(argv, svc, env=toolchain.base_env(), timeout=DEPCRUISE_TIMEOUT)
    res = {"ms": r.duration_ms, "violations": None, "error": None}
    if r.timed_out:
        res["error"] = f"dependency-cruiser timed out after {DEPCRUISE_TIMEOUT}s"
        return res
    try:
        data = json.loads(r.out)
        res["violations"] = (data.get("summary") or {}).get("violations") or []
    except ValueError:
        res["error"] = "dependency-cruiser did not run: " + _tail(r.text, 1500)
    return res


def _arch_layer_checks(dc: dict, io_findings: list[str], io_ms: int) -> list[dict]:
    out = []
    by_rule: dict[str, list[str]] = {"ARCH-1": [], "ARCH-2": [], "ARCH-3": []}
    if dc["violations"] is not None:
        for v in dc["violations"]:
            rule = v.get("rule") or {}
            if rule.get("severity") not in ("error", "warn"):
                continue
            m = re.match(r"(ARCH-\d+)", str(rule.get("name", "")))
            if not m or m.group(1) not in by_rule:
                continue
            frm, to = v.get("from", "?"), v.get("to", "?")
            by_rule[m.group(1)].append(f"{m.group(1)} FAIL {frm} -> {to} (dependency-cruiser rule {rule.get('name')})")
    for rid in ("ARCH-1", "ARCH-2", "ARCH-3"):
        lines = list(dict.fromkeys(by_rule[rid]))
        if rid == "ARCH-3":
            lines += io_findings
        ms = dc["ms"] + (io_ms if rid == "ARCH-3" else 0)
        if dc["error"] is not None:
            out.append(_check(rid, "error", f"{rid} ERROR: {dc['error']}" + ("\n" + "\n".join(lines) if lines else ""), ms))
        elif lines:
            out.append(_check(rid, "fail", "\n".join(lines), ms))
        else:
            what = "dependency-cruiser" + (" + I/O scan" if rid == "ARCH-3" else "")
            out.append(_check(rid, "pass", f"{rid} PASS: no violations ({what})", ms))
    return out


def contract_files(svc: Path, visibility: str, arch: Path) -> list[Path]:
    central = sorted((arch / "broker").glob("*.json"))
    rest = [p for p in central if _is_rest(p)]
    if visibility == "V1":
        repo = sorted((svc / "contracts" / "consumers").glob("*.json")) if (svc / "contracts" / "consumers").is_dir() else []
        return repo + rest
    return [p for p in central if not _is_rest(p)] + rest


def _is_rest(p: Path) -> bool:
    try:
        name = str(json.loads(p.read_text(encoding="utf-8")).get("contract", ""))
    except (ValueError, OSError):
        return False
    return bool(re.match(r"^(GET|POST|PUT|PATCH|DELETE)\s", name))


def _stage_contracts(svc: Path, main: Path | None, files: list[Path]) -> dict:
    t0 = time.monotonic()
    if main is None:
        return {"ok": False, "error": f"no compiled src/main.js in {CI_BUILD}/ (the service did not compile)",
                "results": [], "captures": None, "ms": int((time.monotonic() - t0) * 1000), "files": files}
    argv = [toolchain.node(), toolchain.netstub_flag(), str(toolchain.CHECKER), "--main", str(main), "--json"]
    for f in files:
        argv += ["--contract-file", str(f)]
    r = toolchain.run(argv, svc, env=toolchain.base_env(), timeout=PROBE_TIMEOUT)
    res = {"ms": r.duration_ms, "files": files}
    if r.timed_out:
        return {**res, "ok": False, "error": f"contract probe timed out after {PROBE_TIMEOUT}s", "results": [],
                "captures": None}
    try:
        data = json.loads(r.out)
    except ValueError:
        return {**res, "ok": False, "error": "contract probe crashed: " + _tail(r.text, 1500), "results": [],
                "captures": None}
    probe = data.get("probe") or {}
    return {**res, "ok": bool(probe.get("ok")), "error": probe.get("error"), "results": data.get("results") or [],
            "captures": data.get("captures") if probe.get("ok") else None, "notes": probe.get("notes") or []}


def _contract_check(rid: str, cr: dict) -> dict:
    results = [r for r in cr["results"] if r.get("rule") == rid]
    if not cr["ok"] and not results:
        # probe could not run and there were no contracts of this kind to attribute it to
        n_files = sum(1 for f in cr["files"] if _is_rest(f) == (rid == "ARCH-8"))
        if n_files == 0:
            return _check(rid, "error", f"{rid} ERROR: {cr['error']}", cr["ms"])
    lines, statuses = [], []
    for r in results:
        statuses.append(r["status"])
        if r["status"] == "pass":
            lines.append(f"{rid} PASS {r['consumer']}: {r['contract']} ({r.get('fields', 0)} required fields present)")
        else:
            word = "ERROR" if r["status"] == "error" else "FAIL"
            for p in r.get("problems") or ["unknown problem"]:
                lines.append(f"{rid} {word} {r['consumer']}: {p}")
    if not results:
        where = "contracts/consumers/" if rid == "ARCH-4" else "the broker"
        if not cr["ok"]:
            return _check(rid, "error", f"{rid} ERROR: {cr['error']}", cr["ms"])
        return _check(rid, "pass", f"{rid} PASS: no consumer contracts found in {where}", cr["ms"])
    status = "fail" if "fail" in statuses else "error" if "error" in statuses else "pass"
    # failing lines first, so the feedback leads with what broke
    lines.sort(key=lambda l: 0 if (" FAIL " in l or " ERROR " in l) else 1)
    return _check(rid, status, "\n".join(lines), cr["ms"])


def _pii_check(sources, cr: dict, cat: catalog_mod.Catalog, arch: Path) -> dict:
    t0 = time.monotonic()
    try:
        baseline = set(json.loads((arch / "pii-baseline.json").read_text(encoding="utf-8")))
    except (ValueError, OSError):
        baseline = set()
    events = {ev for svc, ev in cat.topic_owner.values() if svc == cat.me}
    static = scans.pii_static(sources, events)
    dynamic: list[str] = []
    caps = cr.get("captures")
    if caps:
        for item in caps.get("events") or []:
            ev = item.get("event") or {}
            label = ev.get("type") if isinstance(ev.get("type"), str) else (
                "OrderCancelled" if item.get("phase") == "cancel" else "OrderPlaced")
            dynamic += scans.pii_dynamic(label, ev)
        got = caps.get("getOrder") or {}
        if isinstance(got.get("body"), (dict, list)):
            dynamic += scans.pii_dynamic("GET /orders/{id}", got["body"])
    lines = []
    for key, where in static.items():
        if key not in baseline:
            lines.append(f"ARCH-6 FAIL {where}: {key} looks like customer PII in a published contract type "
                         f"(only customer-service stores PII; carry customerId)")
    for key in dict.fromkeys(dynamic):
        if key not in baseline and key not in static:
            lines.append(f"ARCH-6 FAIL {key} carries customer PII (only customer-service stores PII; carry customerId)")
    ms = int((time.monotonic() - t0) * 1000)
    if lines:
        return _check("ARCH-6", "fail", "\n".join(dict.fromkeys(lines)), ms)
    note = "" if caps else " (runtime payloads not available; type scan only)"
    return _check("ARCH-6", "pass", f"ARCH-6 PASS: no new PII fields (baseline: {', '.join(sorted(baseline))}){note}", ms)


# ---- main entry ------------------------------------------------------------------------------------------------

def run_ci(workspace: Path, visibility: str | None = None, run_id: str = "adhoc") -> dict:
    workspace = Path(workspace)
    visibility = visibility or detect_visibility(workspace)
    svc = service_dir(workspace, visibility)
    arch = materialize_architecture(run_id)
    try:
        return _run(svc, visibility, arch)
    finally:
        toolchain.rmtree(arch)
        toolchain.rmtree(svc / CI_BUILD)


def _run(svc: Path, visibility: str, arch: Path) -> dict:
    t0 = time.monotonic()
    cat = catalog_mod.Catalog(catalog_mod.load_dir(arch / "catalog"))
    files = contract_files(svc, visibility, arch)
    with ThreadPoolExecutor(max_workers=3) as pool:
        f_tsc = pool.submit(_stage_tsc, svc)
        f_tests = pool.submit(_stage_tests, svc)
        f_dc = pool.submit(_stage_depcruise, svc)
        t_scan = time.monotonic()
        sources = scans.load_sources(svc)
        io = scans.scan_io(sources)
        a5 = scans.scan_catalog(sources, cat)
        a7 = scans.scan_data_access(sources, cat)
        scan_ms = int((time.monotonic() - t_scan) * 1000)
        tsc = f_tsc.result()
        cr = _stage_contracts(svc, tsc["main"], files)
        tests = f_tests.result()
        dc = f_dc.result()

    checks = [_check("typecheck", tsc["status"], tsc["output"], tsc["ms"]),
              _check("unit-tests", tests["status"], tests["output"], tests["ms"])]
    checks += _arch_layer_checks(dc, io, scan_ms)
    checks.append(_contract_check("ARCH-4", cr))
    checks.append(_check("ARCH-5", "fail" if a5 else "pass", "\n".join(a5) if a5 else
                         "ARCH-5 PASS: every outgoing call is declared in catalog/orders-service.yaml", scan_ms))
    checks.append(_pii_check(sources, cr, cat, arch))
    checks.append(_check("ARCH-7", "fail" if a7 else "pass", "\n".join(a7) if a7 else
                         "ARCH-7 PASS: no database connections or clients", scan_ms))
    checks.append(_contract_check("ARCH-8", cr))
    failed = [c for c in checks if c["status"] != "pass"]
    return {"ok": not failed, "checks": checks, "feedback_text": _feedback_text(failed)}


def _feedback_text(failed: list[dict]) -> str:
    text = "\n\n".join(c["output"] for c in failed)
    if len(text) > FEEDBACK_LIMIT:
        marker = "\n… (truncated)"
        text = text[:FEEDBACK_LIMIT - len(marker)] + marker
    return text


def feedback_message(verdict: dict) -> str:
    """Exact §7.5 message (frozen text in harness/texts/ci_feedback.md, owned by the harness)."""
    from harness.repair import feedback_message as _fm
    return _fm(verdict)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ci.run")
    ap.add_argument("workspace")
    ap.add_argument("--visibility", choices=("V0", "V1", "V2"))
    ap.add_argument("--run-id", default="adhoc")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    verdict = run_ci(Path(a.workspace), a.visibility, a.run_id)
    text = json.dumps(verdict, indent=2, ensure_ascii=False)
    if a.out:
        Path(a.out).write_text(text + "\n", encoding="utf-8", newline="\n")
    print(text)
    return 0 if verdict["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
