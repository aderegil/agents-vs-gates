"""Pilot X1 summary (exploratory; outside the confirmatory analysis; run before the freeze).

  python -X utf8 -m analysis.pilot_x1 [--ns real|mock] [--json]   -> results/<ns>/x1-summary.md (+ .json)

Per unit × ticket × V (V0 vs V2, S0, W1 base text):
  - first attempt broke a consumer (oracle on gen: metrics.staging_break) — the key metric — with Clopper-Pearson CI;
  - outcomes (passed_first_ci, fixed_code, ...);
  - ticket_done on the final PR (and on gen), out_of_scope_edits (V2);
  - median turns, tokens (input + output) and minutes;
  - covariates (calibration finding from P0): ran the checks in gen (ran_tests) and shell commands denied;
  - Fisher exact V0 vs V2 per ticket on "first attempt broke a consumer" and on passed_first_ci. Not corrected for
    multiplicity: exploratory.
Infrastructure failures and excluded runs (contamination, token exposed, isolation breach) are counted apart.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from statistics import median

from analysis import common, stats
from harness import jsonio, paths

STAGE = "X1"
TICKETS = ("X-rename", "X-remove")
VIS = ("V0", "V2")
NOTE = ("Pilot X1 · exploratory — run before the freeze; results disclosed, not part of the confirmatory analysis. "
        "Fisher p-values are uncorrected.")


def covariates_of(rec: dict) -> dict:
    """record.covariates, or computed from the archived transcript for records written before it existed."""
    if isinstance(rec.get("covariates"), dict):
        return rec["covariates"]
    from harness import covariates
    tr = jsonio.read_jsonl(common.run_files(rec) / "transcript.jsonl") if rec.get("run_id") else []
    return covariates.compute(tr or [])


def _med(xs):
    return round(median(xs), 1) if xs else None


def _group(recs: list[dict]) -> dict:
    n = len(recs)
    sb = sum(1 for r in recs if (r.get("metrics") or {}).get("staging_break") is True)
    pfc = sum(1 for r in recs if r.get("outcome") == "passed_first_ci")
    cov = [covariates_of(r) for r in recs]
    return {
        "n": n,
        "staging_break_gen": {"x": sb, "n": n, "ci": list(stats.clopper_pearson(sb, n)) if n else None},
        "passed_first_ci": {"x": pfc, "n": n, "ci": list(stats.clopper_pearson(pfc, n)) if n else None},
        "outcomes": dict(sorted(Counter(r.get("outcome") for r in recs).items())),
        "ticket_done": dict(sorted(Counter(str(r.get("ticket_done")) for r in recs).items())),
        "ticket_done_gen": dict(sorted(Counter(str(r.get("ticket_done_gen", r.get("ticket_done"))) for r in recs).items())),
        "out_of_scope": sum(1 for r in recs if r.get("out_of_scope_edits")),
        "median_turns": _med([(r.get("totals") or {}).get("turns", 0) for r in recs]),
        "median_tokens": _med([(r.get("totals") or {}).get("input_tokens", 0) + (r.get("totals") or {}).get("output_tokens", 0)
                               for r in recs]),
        "median_minutes": _med([r.get("duration_ms", 0) / 60000 for r in recs]),
        "ran_tests": {"x": sum(1 for c in cov if c.get("ran_tests")), "n": n},
        "shell_denials": {"runs": sum(1 for c in cov if c.get("shell_denials")), "total": sum(c.get("shell_denials", 0) for c in cov),
                          "median": _med([c.get("shell_denials", 0) for c in cov])},
        "run_ids": sorted(r["run_id"] for r in recs),
    }


def _fisher(a: dict, b: dict, key: str) -> float | None:
    if not a["n"] or not b["n"]:
        return None
    x0, x2 = a[key]["x"], b[key]["x"]
    return stats.fisher_exact(x0, a["n"] - x0, x2, b["n"] - x2)


def summarize(ns: str) -> dict:
    recs = [r for r in common.load_records(ns) if r.get("stage") == STAGE]
    units = {}
    excluded, infra = [], []
    for unit in sorted({r.get("unit") for r in recs}):
        tickets = {}
        for t in TICKETS:
            g = {}
            for V in VIS:
                sel = [r for r in recs if r.get("unit") == unit and r.get("ticket") == t and r.get("visibility") == V]
                ok = [r for r in sel if not common.is_infra(r) and not common.exclusion_reasons(r)]
                g[V] = _group(ok)
            g["fisher_staging_break"] = _fisher(g["V0"], g["V2"], "staging_break_gen")
            g["fisher_passed_first_ci"] = _fisher(g["V0"], g["V2"], "passed_first_ci")
            tickets[t] = g
        units[unit] = tickets
    for r in recs:
        if common.exclusion_reasons(r):
            excluded.append({"run_id": r["run_id"], "reasons": common.exclusion_reasons(r)})
        elif common.is_infra(r):
            infra.append({"run_id": r["run_id"], "kind": (r.get("infra_failure") or {}).get("kind")})
    return {"stage": STAGE, "ns": ns, "label": "Pilot X1 · exploratory", "note": NOTE, "runs": len(recs),
            "units": units, "excluded": excluded, "infra": infra}


def _ci(d: dict) -> str:
    return stats.x_of_n(d["x"], d["n"]) if d["n"] else "—"


def _counts(c: dict) -> str:
    return ", ".join(f"{k} {v}" for k, v in c.items()) or "—"


def _p(p) -> str:
    return "—" if p is None else f"{p:.4g}"


def markdown(s: dict) -> str:
    L = [f"# Pilot X1 · exploratory ({s['ns']})", ""]
    if s["ns"] == "mock":
        L += [f"**{common.SIM_BANNER}**", ""]
    L += [f"_{s['note']}_", "",
          "Design: X-rename and X-remove × V0 (orders-service only) vs V2 (the four repos in one workspace), S0, W1 base "
          "text, 10 runs per cell and unit, blocks of 4 (one run of each cell per block, shuffled).", "",
          f"Runs with a record: {s['runs']}. Excluded: {len(s['excluded'])}. Infrastructure failures: {len(s['infra'])}.", ""]
    if not s["units"]:
        L += ["No X1 runs yet.", ""]
    for unit, tickets in s["units"].items():
        L += [f"## Unit {unit}", ""]
        for t, g in tickets.items():
            a, b = g["V0"], g["V2"]
            L += [f"### {t}", "",
                  "| | V0 | V2 |", "|---|---|---|",
                  f"| Runs | {a['n']} | {b['n']} |",
                  f"| **First attempt broke a consumer (oracle on gen)** | {_ci(a['staging_break_gen'])} | {_ci(b['staging_break_gen'])} |",
                  f"| Passed the first CI | {_ci(a['passed_first_ci'])} | {_ci(b['passed_first_ci'])} |",
                  f"| Outcomes | {_counts(a['outcomes'])} | {_counts(b['outcomes'])} |",
                  f"| ticket_done (final PR) | {_counts(a['ticket_done'])} | {_counts(b['ticket_done'])} |",
                  f"| ticket_done (gen) | {_counts(a['ticket_done_gen'])} | {_counts(b['ticket_done_gen'])} |",
                  f"| Out-of-scope edits (another team's folder) | {a['out_of_scope']} | {b['out_of_scope']} |",
                  f"| Median turns | {a['median_turns'] if a['median_turns'] is not None else '—'} | {b['median_turns'] if b['median_turns'] is not None else '—'} |",
                  f"| Median tokens (in + out) | {a['median_tokens'] if a['median_tokens'] is not None else '—'} | {b['median_tokens'] if b['median_tokens'] is not None else '—'} |",
                  f"| Median minutes | {a['median_minutes'] if a['median_minutes'] is not None else '—'} | {b['median_minutes'] if b['median_minutes'] is not None else '—'} |",
                  f"| Ran the checks in gen (npm test / typecheck / tsc) | {a['ran_tests']['x']} of {a['n']} | {b['ran_tests']['x']} of {b['n']} |",
                  f"| Shell commands denied (runs with any / total) | {a['shell_denials']['runs']} / {a['shell_denials']['total']} | {b['shell_denials']['runs']} / {b['shell_denials']['total']} |",
                  "",
                  f"Fisher exact V0 vs V2 (two-sided, uncorrected, exploratory): first attempt broke a consumer p = "
                  f"{_p(g['fisher_staging_break'])}; passed the first CI p = {_p(g['fisher_passed_first_ci'])}.", ""]
    if s["excluded"]:
        L += ["## Excluded runs", ""] + [f"- {e['run_id']}: {', '.join(e['reasons'])}" for e in s["excluded"]] + [""]
    if s["infra"]:
        L += ["## Infrastructure failures", ""] + [f"- {e['run_id']}: {e['kind']}" for e in s["infra"]] + [""]
    return "\n".join(L)


def write(ns: str) -> dict:
    s = summarize(ns)
    d = paths.ns_dir(ns)
    d.mkdir(parents=True, exist_ok=True)
    (d / "x1-summary.md").write_text(markdown(s), encoding="utf-8", newline="\n")
    jsonio.write_json_atomic(d / "x1-summary.json", s)
    return s


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m analysis.pilot_x1")
    ap.add_argument("--ns", choices=["real", "mock"], default="real")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    s = write(a.ns)
    print(json.dumps(s, indent=2) if a.json else f"wrote {paths.ns_dir(a.ns) / 'x1-summary.md'} ({s['runs']} X1 runs)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
