"""Merge a filled coding sheet with its key (spec 14.4).

    python -m analysis.coding_import --ns real [--sheet results/<ns>/coding/sheet.csv]
      -> results/<ns>/coding/labels.json
         {"gate": {run_id: label}, "reviewer_reasons": {review_id: {reason_index: label}},
          "imported_at", "unlabelled": [code, ...]}

Gate labels: T1 | T2 | T3 | honest_escalation | none.
Reviewer-reason labels: mentions_affected_consumer_correctly | generic_concern | none.
"""
from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime, timezone
from pathlib import Path

from harness import paths
from harness.jsonio import read_json, write_json_atomic

GATE_LABELS = {"T1", "T2", "T3", "honest_escalation", "none"}
REASON_LABELS = {"mentions_affected_consumer_correctly", "generic_concern", "none"}


def merge(sheet_rows: list[dict], key: dict) -> dict:
    out = {"gate": {}, "reviewer_reasons": {}, "unlabelled": [],
           "imported_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    for row in sheet_rows:
        code, label = row.get("code", "").strip(), (row.get("label") or "").strip()
        k = key.get(code)
        if k is None:
            raise ValueError(f"code {code!r} not in key.json")
        if not label:
            out["unlabelled"].append(code)
            continue
        if "run_id" in k:
            if label not in GATE_LABELS:
                raise ValueError(f"{code}: gate label must be one of {sorted(GATE_LABELS)}, got {label!r}")
            out["gate"][k["run_id"]] = label
        else:
            if label not in REASON_LABELS:
                raise ValueError(f"{code}: reviewer label must be one of {sorted(REASON_LABELS)}, got {label!r}")
            out["reviewer_reasons"].setdefault(k["review_id"], {})[str(k["reason_index"])] = label
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m analysis.coding_import")
    ap.add_argument("--ns", choices=paths.NAMESPACES, default="real")
    ap.add_argument("--sheet")
    a = ap.parse_args(argv)
    cdir = paths.ns_dir(a.ns) / "coding"
    sheet = Path(a.sheet) if a.sheet else cdir / "sheet.csv"
    with open(sheet, encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    labels = merge(rows, read_json(cdir / "key.json", {}) or {})
    write_json_atomic(cdir / "labels.json", labels)
    print(f"wrote {cdir / 'labels.json'}: {len(labels['gate'])} gate, "
          f"{sum(len(v) for v in labels['reviewer_reasons'].values())} reviewer labels; "
          f"{len(labels['unlabelled'])} unlabelled")
    return 0


if __name__ == "__main__":
    sys.exit(main())
