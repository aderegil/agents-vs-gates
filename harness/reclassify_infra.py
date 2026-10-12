"""One-off: archived Codex runs whose shell was dead (the sandbox launcher could not start their commands) are
infrastructure failures, not agent outcomes (PREREGISTRATION §5). This re-marks them and puts them back to pending,
so the runner re-runs them with the same ids (DECISIONS, 2026-10-12, "sandbox_unavailable").

  python -m harness.reclassify_infra --ns real --stage P6                          dry run: candidates in the stage
  python -m harness.reclassify_infra --ns real --runs p6-0053,p6-0055              dry run: the plan for those runs
  python -m harness.reclassify_infra --ns real --runs p6-0053,p6-0055 --apply      do it

A run is accepted only if it is `done` in state.json and its own archived transcript shows the signature: a Bash
tool_result with status error whose output matches the adapter's _SANDBOX_DEAD. Any other listed run is refused, and
then nothing is changed. On --apply, per run:
  - results/<ns>/runs/<id>/ is moved, unchanged, to results/<ns>/attempts/<id>/attempt-<n>/ (n = its attempt number),
    with reclassified.json beside it (the outcome it had, the kind it gets, the evidence);
  - state.json: status pending, infra_failures + 1, last_error, and a `reclassified` entry;
  - runner.log.jsonl: one `reclassified` event.
Nothing else is touched: not the manifests, not coding/, reviews/ or the summary. Refuses while a runner is alive.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys

from harness import jsonio, paths
from harness.adapters.codex import _SANDBOX_DEAD
from harness.jsonio import read_json, read_jsonl

KIND = "sandbox_unavailable"


def now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def evidence(ns: str, rid: str) -> dict:
    """Bash calls in the archived transcript, and which failed with the dead-sandbox signature."""
    names, bash, dead, first = {}, 0, 0, None
    for e in read_jsonl(paths.run_dir(ns, rid) / "transcript.jsonl"):
        key = (e.get("session"), e.get("id"))
        if e.get("kind") == "tool_call":
            names[key] = e.get("name")
        elif e.get("kind") == "tool_result" and names.get(key) == "Bash":
            bash += 1
            if e.get("status") == "error" and _SANDBOX_DEAD.search(str(e.get("output") or "")):
                dead += 1
                first = first or {"session": e.get("session"), "bash_call": bash, "ts": e.get("ts"),
                                  "output": str(e.get("output")).strip()[:300]}
    return {"bash_calls": bash, "sandbox_dead": dead, "first": first}


def plan(ns: str, rids: list[str] | None, stage: str | None) -> tuple[list[dict], list[str]]:
    state = read_json(paths.state_path(ns)) or {}
    runs = state.get("runs") or {}
    explicit = rids is not None          # listed runs must all qualify; a scan just skips the ones that don't
    if rids is None:
        rids = sorted(r for r in runs if (paths.run_dir(ns, r) / "record.json").exists())
    items, refused = [], []
    for rid in rids:
        rec = read_json(paths.run_dir(ns, rid) / "record.json")
        st = runs.get(rid) or {}
        if not isinstance(rec, dict):
            refused.append(f"{rid}: no archived record")
            continue
        if stage and rec.get("stage") != stage:
            if explicit:
                refused.append(f"{rid}: stage {rec.get('stage')}, not {stage}")
            continue
        ev = evidence(ns, rid)
        if not ev["sandbox_dead"]:
            if explicit:
                refused.append(f"{rid}: no dead-sandbox signature in its transcript")
            continue
        if st.get("status") != "done":
            refused.append(f"{rid}: state status is {st.get('status')!r}, not 'done'")
            continue
        n = int(st.get("attempts") or 1)
        items.append({"run_id": rid, "stage": rec.get("stage"), "unit": rec.get("unit"), "outcome": rec.get("outcome"),
                      "started_at": rec.get("started_at"), "attempt": n, "evidence": ev,
                      "archive_to": str(paths.ns_dir(ns) / "attempts" / rid / f"attempt-{n}"),
                      "state_after": {"status": "pending", "infra_failures": int(st.get("infra_failures") or 0) + 1}})
    return items, refused


def runner_alive(ns: str) -> bool:
    r = (read_json(paths.state_path(ns)) or {}).get("runner") or {}
    if r.get("status") == "running":
        return True
    if r.get("pid"):
        from console.core.runner_ctl import pid_alive
        return pid_alive(r["pid"])
    return False


def apply(ns: str, items: list[dict]) -> None:
    at = now()
    for it in items:
        dst = paths.ns_dir(ns) / "attempts" / it["run_id"] / f"attempt-{it['attempt']}"
        if dst.exists():
            raise SystemExit(f"{dst} already exists: refusing to overwrite an archived attempt")
    state = read_json(paths.state_path(ns))
    for it in items:
        rid, dst = it["run_id"], paths.ns_dir(ns) / "attempts" / it["run_id"] / f"attempt-{it['attempt']}"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(paths.run_dir(ns, rid)), str(dst))
        note = {"run_id": rid, "at": at, "by": "harness.reclassify_infra", "from_outcome": it["outcome"],
                "infra_failure": {"kind": KIND, "detail": "sandbox could not start a command: "
                                  + ((it["evidence"]["first"] or {}).get("output") or ""), "reset_at": None},
                "evidence": it["evidence"], "rule": "PREREGISTRATION §5: infrastructure failures are re-queued"}
        jsonio.write_json_atomic(dst / "reclassified.json", note)
        r = state["runs"][rid]
        r.update(status="pending", infra_failures=it["state_after"]["infra_failures"], worker=None,
                 last_error=f"{KIND}: reclassified from {it['outcome']} (archived attempt {it['attempt']})")
        r.setdefault("reclassified", []).append({"at": at, "from_outcome": it["outcome"], "kind": KIND,
                                                 "attempt": it["attempt"],
                                                 "archive": str(dst.relative_to(paths.ns_dir(ns))).replace("\\", "/")})
        jsonio.append_jsonl(paths.runner_log_path(ns), {"ts": at, "event": "reclassified", "run_id": rid,
                                                         "kind": KIND, "from_outcome": it["outcome"],
                                                         "attempt": it["attempt"]})
    state["updated_at"] = at
    jsonio.write_json_atomic(paths.state_path(ns), state)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m harness.reclassify_infra", description=__doc__.split("\n")[0])
    ap.add_argument("--ns", default="mock", choices=sorted(paths.NAMESPACES))
    ap.add_argument("--stage", help="limit to one stage (with no --runs: list the candidates in it)")
    ap.add_argument("--runs", help="comma-separated run ids (required with --apply)")
    ap.add_argument("--apply", action="store_true", help="make the changes (default: dry run)")
    a = ap.parse_args(argv)
    rids = [r.strip() for r in a.runs.split(",") if r.strip()] if a.runs else None
    if a.apply and not rids:
        print("--apply needs an explicit --runs list", file=sys.stderr)
        return 2
    items, refused = plan(a.ns, rids, a.stage)
    print(f"{'APPLY' if a.apply else 'DRY RUN'}  ns={a.ns}  root={paths.results_root()}")
    for it in items:
        ev = it["evidence"]
        print(f"  {it['run_id']}  {it['stage']} {it['unit']}  outcome {it['outcome']} -> pending ({KIND})  "
              f"bash {ev['bash_calls']}, dead {ev['sandbox_dead']} (first at call {(ev['first'] or {}).get('bash_call')}, "
              f"{(ev['first'] or {}).get('ts')})  infra_failures -> {it['state_after']['infra_failures']}  "
              f"archive -> attempts/{it['run_id']}/attempt-{it['attempt']}")
    for r in refused:
        print(f"  REFUSED {r}")
    print(f"{len(items)} run(s) to re-queue, {len(refused)} refused")
    if refused and a.apply:
        print("nothing changed: fix or drop the refused runs first", file=sys.stderr)
        return 2
    if a.apply:
        if runner_alive(a.ns):
            print("a runner is alive in this namespace: nothing changed", file=sys.stderr)
            return 2
        apply(a.ns, items)
        print(f"applied: {len(items)} run(s) archived and back to pending")
    return 0


if __name__ == "__main__":
    sys.exit(main())
