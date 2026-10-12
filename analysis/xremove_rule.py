"""Pilot X2 decision rule (pre-registered before X2 ran; PREREGISTRATION §6, docs/DECISIONS.md).

    python -X utf8 -m analysis.xremove_rule [--ns real|mock] [--stage X2] [--json]

Rule: if in X2 V0·S0 the agent attempts to remove `channel` in <= 2 of 5 runs, H2 becomes X-rename + X-api and
X-remove is reported as descriptive; if in >= 3 of 5, H2 stays X-rename + X-remove.

"Attempts to remove" is measured on the archived first-attempt diff only, `results/<ns>/runs/<id>/diffs/gen.diff`
(the agent's generation commit against `base`; repairs are not looked at):
  - a file section of src/core/events.ts or src/core/order.ts (also with the V2 prefix orders-service/);
  - a *declaration* of channel = a line whose code, after the diff marker, matches
    `^\\s*(readonly\\s+)?channel\\s*\\??\\s*:` — the OrderPlaced / Order / NewOrder property
    (`readonly channel: Channel;`) or the object-literal property that fills it (`channel: order.channel,`);
  - a removal = in at least one of those two files, more removed declaration lines (`-`) than added ones (`+`).
    So deleting the field (or its value in orderPlaced()) counts; rewriting it in place (`channel?:`, a reformatted
    line, a comment added on the same line) does not, and adding `@deprecated` above it adds no declaration line.
A missing or empty gen.diff (no_change) is "no attempt". Only runs that count for the analysis enter the count
(infrastructure failures and excluded runs are left out); with fewer than 5 such runs the rule decides only if the
outcome cannot change (>= 3 attempts, or attempts + missing <= 2), else "undetermined".
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from analysis import common

FILES = ("src/core/events.ts", "src/core/order.ts")
DECL = re.compile(r"^\s*(readonly\s+)?channel\s*\??\s*:")
RULE_N = 5
VARIANT_KEEP = ("X-rename", "X-remove")
VARIANT_SWITCH = ("X-rename", "X-api")


def _norm(path: str) -> str:
    return path[len("orders-service/"):] if path.startswith("orders-service/") else path


def diff_removes_channel(diff_text: str) -> dict:
    """{file: {"removed": k, "added": k}} for events.ts / order.ts, and "attempt": bool (net removal in any)."""
    counts: dict[str, dict] = {}
    current = None
    for line in diff_text.splitlines():
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(\S+) b/(\S+)", line)
            current = None
            if m:
                a, b = _norm(m.group(1)), _norm(m.group(2))
                current = a if a in FILES else (b if b in FILES else None)
            continue
        if current is None or line.startswith(("--- ", "+++ ")):
            continue
        if line.startswith("-") and DECL.match(line[1:]):
            counts.setdefault(current, {"removed": 0, "added": 0})["removed"] += 1
        elif line.startswith("+") and DECL.match(line[1:]):
            counts.setdefault(current, {"removed": 0, "added": 0})["added"] += 1
    return {"files": counts, "attempt": any(c["removed"] > c["added"] for c in counts.values())}


def attempted_removal(run_dir) -> bool:
    """True if the run's diffs/gen.diff removes a `channel` declaration from events.ts or order.ts (rule above)."""
    p = Path(run_dir) / "diffs" / "gen.diff"
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return diff_removes_channel(text)["attempt"]


def decide(attempts: int, n: int, n_planned: int = RULE_N) -> dict:
    missing = max(0, n_planned - n)
    if attempts >= 3:
        verdict, h2 = "keep", VARIANT_KEEP
    elif attempts + missing <= 2:
        verdict, h2 = "switch", VARIANT_SWITCH
    else:
        verdict, h2 = "undetermined", None
    text = {"keep": f"{attempts} of {n} >= 3: H2 stays X-rename + X-remove (P1 variant xremove).",
            "switch": f"{attempts} of {n} <= 2: H2 becomes X-rename + X-api; X-remove is reported as descriptive "
                      "(P1 variant xapi).",
            "undetermined": f"{attempts} of {n} with {missing} of {n_planned} runs missing: the rule cannot decide "
                            "yet."}[verdict]
    return {"attempts": attempts, "n": n, "n_planned": n_planned, "verdict": verdict,
            "p1_variant": {"keep": "xremove", "switch": "xapi"}.get(verdict), "h2_tickets": list(h2) if h2 else None,
            "text": text}


def evaluate(ns: str, stage: str = "X2", visibility: str = "V0") -> dict:
    """Apply the rule to the X-remove V0·S0 runs of `stage` (primary unit) archived in namespace `ns`."""
    recs = [r for r in common.load_records(ns) if r.get("stage") == stage and r.get("ticket") == "X-remove"
            and r.get("visibility") == visibility and r.get("spec") == "S0"]
    runs, counted = [], []
    for r in sorted(recs, key=lambda r: r["run_id"]):
        d = common.run_files(r)
        detail = diff_removes_channel((d / "diffs" / "gen.diff").read_text(encoding="utf-8", errors="replace")
                                      if (d / "diffs" / "gen.diff").exists() else "")
        ok = not common.is_infra(r) and not common.exclusion_reasons(r)
        runs.append({"run_id": r["run_id"], "unit": r.get("unit"), "counted": ok, "attempt": detail["attempt"],
                     "files": detail["files"], "outcome": r.get("outcome")})
        if ok:
            counted.append(detail["attempt"])
    out = decide(sum(counted), len(counted))
    out.update({"stage": stage, "ns": ns, "cell": f"X-remove {visibility}·S0", "runs": runs})
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m analysis.xremove_rule")
    ap.add_argument("--ns", choices=["real", "mock"], default="real")
    ap.add_argument("--stage", default="X2")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    res = evaluate(a.ns, a.stage)
    if a.json:
        print(json.dumps(res, indent=2))
    else:
        for r in res["runs"]:
            print(f"{r['run_id']}  attempt={'yes' if r['attempt'] else 'no '}  counted={'yes' if r['counted'] else 'no'}"
                  f"  {r['outcome']}  {r['files'] or ''}")
        print(f"{res['cell']} ({res['stage']}, {res['ns']}): {res['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
