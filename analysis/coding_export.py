"""Blind coding sheet (spec 14.4).

    python -m analysis.coding_export --ns real [--seed 20261011]
      -> results/<ns>/coding/sheet.csv  (no unit, condition, stage or run_id)
      -> results/<ns>/coding/key.json   (code -> run_id / review_id; keep it away from the coder)

One row per run flagged by any detector (kind=gate) and one per reviewer reason (kind=reviewer_reason).
Rows are ordered by their random code, so the order leaks nothing either.
"""
from __future__ import annotations

import argparse
import csv
import random
import sys

from analysis import common
from harness import paths
from harness.jsonio import write_json_atomic

COLUMNS = ["code", "kind", "ticket", "diff_excerpt", "detectors", "last_message", "reviewer_reason",
           "affected_consumers", "label", "notes"]
EXCERPT = 1500


def _diff_excerpt(rec: dict, flagged_paths: set[str]) -> str:
    ddir = common.run_files(rec) / "diffs"
    if not ddir.exists():
        return ""
    chunks = []
    for f in sorted(ddir.glob("*.diff"), key=lambda p: (p.stem != "gen", p.stem)):
        text = f.read_text(encoding="utf-8", errors="replace")
        for block in text.split("diff --git ")[1:]:
            head = block.splitlines()[0] if block else ""
            if not flagged_paths or any(p and p in head for p in flagged_paths):
                chunks.append(f"[{f.stem}] diff --git " + block)
    return "".join(chunks)[:EXCERPT]


def export(ns: str, seed: int = 20261011) -> tuple[list[dict], dict]:
    rng = random.Random(seed)
    used: set[str] = set()

    def code() -> str:
        while True:
            c = f"C{rng.randrange(16**6):06x}"
            if c not in used:
                used.add(c)
                return c

    rows, key = [], {}
    records = common.load_records(ns)
    for rec in records:
        if common.exclusion_reasons(rec) or common.is_infra(rec):
            continue
        flags = [f for d in rec.get("detectors") or [] for f in d.get("flags") or []]
        if not flags:
            continue
        c = code()
        uniq = sorted({(f["detector"], f["path"]) for f in flags})
        rows.append({"code": c, "kind": "gate", "ticket": rec.get("ticket"),
                     "diff_excerpt": _diff_excerpt(rec, {p for _, p in uniq}),
                     "detectors": "; ".join(f"{d} {p}" for d, p in uniq),
                     "last_message": (rec.get("final_message") or "")[:1500], "reviewer_reason": "",
                     "affected_consumers": "", "label": "", "notes": ""})
        key[c] = {"run_id": rec["run_id"]}
    by_id = {r["run_id"]: r for r in records}
    prs = {p["pr_id"]: p for p in (common.load_pr_set(ns) or {}).get("prs", [])}
    for rv in common.load_reviews(ns):
        pr = prs.get(rv.get("pr_id"), {})
        rec = by_id.get(rv.get("run_id"), {})
        for i, reason in enumerate(rv.get("reasons") or []):
            c = code()
            rows.append({"code": c, "kind": "reviewer_reason", "ticket": rec.get("ticket") or pr.get("ticket"),
                         "diff_excerpt": _diff_excerpt(rec, set()) if rec else "", "detectors": "",
                         "last_message": "", "reviewer_reason": reason,
                         "affected_consumers": ", ".join(pr.get("affected_consumers") or []),
                         "label": "", "notes": ""})
            key[c] = {"review_id": rv.get("review_id"), "reason_index": i}
    rows.sort(key=lambda r: r["code"])
    return rows, key


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m analysis.coding_export")
    ap.add_argument("--ns", choices=paths.NAMESPACES, default="real")
    ap.add_argument("--seed", type=int, default=20261011)
    a = ap.parse_args(argv)
    rows, key = export(a.ns, a.seed)
    out = paths.ns_dir(a.ns) / "coding"
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "sheet.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    write_json_atomic(out / "key.json", key)
    print(f"wrote {out / 'sheet.csv'} ({len(rows)} rows) and key.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
