"""RQ4 PR set (spec 12.1), labelled by the oracle on the `gen` state.

    python -m analysis.build_pr_set --ns real [--seed 20261011]  ->  results/<ns>/reviews/pr_set.json

Categories (seeded sampling, shortfall reported):
  breaking  up to 20: oracle on gen breaks >= 1 consumer (stages P1, P2, P4; mock ns also selftest)
  semantic  up to 10: X-units with first CI green and oracle on gen failing
  benign    up to 20: oracle on gen and first CI green, ticket_done == done (X-add and S2 additive changes)
10 breaking PRs are flagged repeat_subsample (reviewed 3 times in R-S0 and R-C).
A run lands in at most one category (semantic before breaking). P0, excluded and infra runs are skipped.
"""
from __future__ import annotations

import argparse
import random
import sys
from datetime import datetime, timezone

from analysis import common
from harness import paths
from harness.jsonio import write_json_atomic

QUOTA = {"breaking": 20, "semantic": 10, "benign": 20}
REPEAT_N = 10
SOURCE_STAGES = ("P1", "P2", "P4")


def _category(rec: dict) -> str | None:
    og = common.oracle_gen(rec)
    ci_ok = common.first_ci_ok(rec)
    if og is None or ci_ok is None:
        return None
    if rec.get("ticket") == "X-units" and ci_ok and not og.get("ok"):
        return "semantic"
    if not og.get("ok"):
        return "breaking"
    if ci_ok and rec.get("ticket_done") == "done" and (rec.get("ticket") == "X-add" or rec.get("spec") == "S2"):
        return "benign"
    return None


def build_pr_set(ns: str, seed: int = 20261011) -> dict:
    stages = SOURCE_STAGES + (("selftest",) if ns == "mock" else ())
    pools = {k: [] for k in QUOTA}
    for rec in common.load_records(ns):
        if rec.get("stage") not in stages or common.exclusion_reasons(rec) or common.is_infra(rec):
            continue
        cat = _category(rec)
        if cat:
            pools[cat].append(rec)
    rng = random.Random(seed)
    chosen, shortfall = [], {}
    for cat in ("breaking", "semantic", "benign"):
        pool = sorted(pools[cat], key=lambda r: r["run_id"])
        pick = rng.sample(pool, min(QUOTA[cat], len(pool)))
        if len(pick) < QUOTA[cat]:
            shortfall[cat] = QUOTA[cat] - len(pick)
        chosen += [(cat, r) for r in sorted(pick, key=lambda r: r["run_id"])]
    breaking_ids = [r["run_id"] for c, r in chosen if c == "breaking"]
    repeat = set(rng.sample(breaking_ids, min(REPEAT_N, len(breaking_ids))))
    prs = []
    for i, (cat, r) in enumerate(chosen, 1):
        prs.append({"pr_id": f"pr-{i:03d}", "run_id": r["run_id"], "stage": r.get("stage"), "ticket": r.get("ticket"),
                    "visibility": r.get("visibility"), "spec": r.get("spec"), "unit": r.get("unit"),
                    "category": cat, "ci_first_ok": bool(common.first_ci_ok(r)),
                    "oracle_gen_ok": bool((common.oracle_gen(r) or {}).get("ok")),
                    "affected_consumers": common.affected_consumers(r), "repeat_subsample": r["run_id"] in repeat})
    return {"schema": "prset/1", "ns": ns, "seed": seed,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "prs": prs, "shortfall": shortfall}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m analysis.build_pr_set")
    ap.add_argument("--ns", choices=paths.NAMESPACES, default="real")
    ap.add_argument("--seed", type=int, default=20261011)
    a = ap.parse_args(argv)
    s = build_pr_set(a.ns, a.seed)
    out = paths.ns_dir(a.ns) / "reviews" / "pr_set.json"
    write_json_atomic(out, s)
    counts = {c: sum(p["category"] == c for p in s["prs"]) for c in QUOTA}
    print(f"wrote {out}: {counts}; shortfall {s['shortfall'] or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
