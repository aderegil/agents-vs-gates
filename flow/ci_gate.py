"""CI for a sprint PR, by condition (spec 16.2). Reuses the experiment's CI (ci/), never changes it.

- F1 (full CI): orders-service gets `ci.run.run_ci` as is (typecheck, unit-tests, ARCH-1..8). The other repos get the
  checks of ci/ that are not orders-service-specific: typecheck, unit-tests and ARCH-1..3 (their own
  dependency-cruiser rules + the I/O scan). ARCH-4..8 check orders-service against the broker and its catalog entry,
  so they do not apply to the consumers until M2a generalizes ci/ (gap recorded in the M2b report).
- F0 (no architecture gates): the same runs, filtered to the `build` and `test` checks (typecheck, unit-tests); `ok`
  is recomputed over what is kept. The F0 filter is applied to the `run_ci` verdict, as the spec says.

A verdict has the shape of docs/contracts/ci-verdict.schema.json: {"ok", "checks": [...], "feedback_text"} plus
"condition" and "repo".
"""
from __future__ import annotations

import time
from pathlib import Path

from ci import run as ci_run
from ci import scans, toolchain

KEEP_F0 = {"build", "test"}


def filter_condition(verdict: dict, condition: str) -> dict:
    checks = list(verdict["checks"])
    if condition == "F0":
        checks = [c for c in checks if c["category"] in KEEP_F0]
    failed = [c for c in checks if c["status"] != "pass"]
    return {"ok": not failed, "checks": checks, "feedback_text": ci_run._feedback_text(failed)}


def _repo_checks(svc: Path, with_gates: bool) -> list[dict]:
    try:
        tsc = ci_run._stage_tsc(svc)
        tests = ci_run._stage_tests(svc)
        checks = [ci_run._check("typecheck", tsc["status"], tsc["output"], tsc["ms"]),
                  ci_run._check("unit-tests", tests["status"], tests["output"], tests["ms"])]
        if with_gates and (svc / ".dependency-cruiser.cjs").exists():
            dc = ci_run._stage_depcruise(svc)
            t0 = time.monotonic()
            io = scans.scan_io(scans.load_sources(svc))
            checks += ci_run._arch_layer_checks(dc, io, int((time.monotonic() - t0) * 1000))
        return checks
    finally:
        toolchain.rmtree(svc / ci_run.CI_BUILD)


def run_pr_ci(svc: Path, repo: str, condition: str, run_id: str = "flow") -> dict:
    """CI verdict for one PR version whose source tree is `svc` (an extraction, never the scenario repo)."""
    svc = Path(svc)
    if repo == "orders-service":
        verdict = filter_condition(ci_run.run_ci(svc, "V0", run_id), condition)
    else:
        verdict = filter_condition({"checks": _repo_checks(svc, condition == "F1")}, condition)
    verdict.update({"condition": condition, "repo": repo})
    return verdict
