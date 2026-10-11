"""Poll PR selection (spec 14.3). Pre-registered rule, no manual choice:

  the first run of stage P1, ticket X-rename, V0·S0, unit cc-sonnet (mock ns: unit mock), in manifest order,
  whose oracle on the gen state breaks at least one consumer.

    python -m analysis.select_poll_pr [--ns real]
      prints the run_id and writes results/<ns>/poll-pr/{selection.json, gen.diff, fix<n>.diff, ci.json, final_message.txt}

Refuses (exit 2) while P1 is blinded. Excluded and infra-failure runs are skipped.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from datetime import datetime, timezone

from analysis import common
from harness import blinding, paths
from harness.jsonio import write_json_atomic


def select(ns: str) -> dict | None:
    manifest, state = common.load_manifest(ns), common.load_state(ns)
    if not blinding.is_visible(state, "P1"):
        raise PermissionError("P1 is blinded until stage complete")
    unit = common.PRIMARY_UNIT[ns]
    by_id = {r["run_id"]: r for r in common.load_records(ns)}
    for m in (manifest or {}).get("runs", []):
        if (m["stage"], m["ticket"], m["visibility"], m["spec"], m["unit"]) != ("P1", "X-rename", "V0", "S0", unit):
            continue
        rec = by_id.get(m["run_id"])
        if not rec or not common.analyzable(rec, state):
            continue
        og = common.oracle_gen(rec)
        if og is not None and not og.get("ok"):
            return rec
    return None


def write_poll_pr(ns: str, rec: dict):
    out = paths.ns_dir(ns) / "poll-pr"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    ddir = common.run_files(rec) / "diffs"
    for f in sorted(ddir.glob("*.diff")) if ddir.exists() else []:
        shutil.copyfile(f, out / f.name)
    write_json_atomic(out / "ci.json", common.first_ci(rec))
    write_json_atomic(out / "ci_all.json", rec.get("ci") or [])
    with open(out / "final_message.txt", "w", encoding="utf-8", newline="\n") as f:
        f.write((rec.get("final_message") or "") + "\n")
    write_json_atomic(out / "selection.json", {
        "run_id": rec["run_id"], "rule": "first P1 X-rename V0·S0 primary-unit run in manifest order whose oracle "
                                          "on gen breaks a consumer (spec 14.3)",
        "affected_consumers": common.affected_consumers(rec), "outcome": rec.get("outcome"),
        "selected_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m analysis.select_poll_pr")
    ap.add_argument("--ns", choices=paths.NAMESPACES, default="real")
    a = ap.parse_args(argv)
    try:
        rec = select(a.ns)
    except PermissionError as e:
        print(f"refused: {e}")
        return 2
    if rec is None:
        print("no qualifying run yet")
        return 1
    out = write_poll_pr(a.ns, rec)
    print(rec["run_id"])
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
