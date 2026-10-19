"""Talk video, step 1: gather the data the scenes show (read-only on results/ and scenario/).

    .venv\\Scripts\\python.exe -X utf8 video\\prepare.py [--break-run x1-0002] [--stop-run x1-0003] [--summary auto|file|live]

Writes only under video/work/ (gitignored):
  replays/<run>.json        replay.json built in memory with replay.export.build_replay (never cached in results/)
  x1-summary.json           the pilot summary the results segment draws (see --summary)
  scenario.json             the four services, contracts and ARCH rules (canary markers stripped)
  runs.json                 the X1 records in end order (run id, ticket, V, outcome, staging_break) for captions
  timeline.json             X1 runs per worker from runner.log.jsonl (the parallel-workers chart)
  facts.json                the two featured runs' CI failures, oracle heads and the V2 agent's final message
  results/real/...          a snapshot of results/real without workspace bundles, for the private console
  meta.json                 what was used and when

--summary auto (default): results/real/x1-summary.json (written by analysis.pilot_x1) when it covers every X1 record;
when it is older than the records, the same analysis.pilot_x1.summarize("real") is computed in memory instead.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

VIDEO = Path(__file__).resolve().parent
REPO = VIDEO.parent
sys.path.insert(0, str(REPO))

from harness import paths  # noqa: E402
from harness.jsonio import read_json, read_jsonl  # noqa: E402
from replay.export import build_replay, load_extras  # noqa: E402

WORK = VIDEO / "work"
SERVICES = ("orders-service", "billing-service", "analytics-ingest", "web-storefront")
CANARY = re.compile(r"CANARY-[0-9a-f]+")


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8", newline="\n")


def x1_records() -> list[dict]:
    out = []
    for d in sorted(paths.runs_dir("real").glob("x1*")):
        r = read_json(d / "record.json")
        if isinstance(r, dict) and r.get("stage") == "X1":
            out.append(r)
    return out


def build_replays(run_ids: list[str]) -> dict:
    made = {}
    for rid in run_ids:
        run_dir = paths.run_dir("real", rid)
        events = read_jsonl(run_dir / "events.jsonl")
        if not events:
            raise SystemExit(f"{rid}: no events.jsonl")
        rep = build_replay(events, load_extras(run_dir))
        write(WORK / "replays" / f"{rid}.json", rep)
        made[rid] = {"steps": len(rep.get("steps") or []), "duration_ms": (rep.get("meta") or {}).get("duration_ms")}
    return made


def summary(mode: str, recs: list[dict]) -> dict:
    file_s = read_json(paths.ns_dir("real") / "x1-summary.json")
    n_recs = len(recs)
    use_file = mode == "file" or (mode == "auto" and isinstance(file_s, dict) and file_s.get("runs", 0) >= n_recs)
    if use_file:
        if not isinstance(file_s, dict):
            raise SystemExit("results/real/x1-summary.json is missing (run python -m analysis.pilot_x1)")
        s, src = file_s, "results/real/x1-summary.json"
    else:
        from analysis import pilot_x1
        s, src = pilot_x1.summarize("real"), "analysis.pilot_x1.summarize('real') in memory (summary file had " \
            f"{(file_s or {}).get('runs', 0)} runs, records {n_recs})"
    s = dict(s)
    from harness import manifest
    planned = {}
    for r in manifest.pilot_runs("real"):  # X1 ids are computed beside manifest.json, not stored in it
        planned[r["unit"]] = planned.get(r["unit"], 0) + 1
    s["_video"] = {"source": src, "records_seen": n_recs, "planned_by_unit": planned,
                   "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    write(WORK / "x1-summary.json", s)
    return s["_video"]


def scenario() -> dict:
    sys.path.insert(0, str(REPO / "console" / "plugins" / "scenario"))
    import miniyaml  # the console's own YAML subset reader

    arch = paths.REPOS / "architecture"
    services = {}
    for name in SERVICES:
        y = miniyaml.load((arch / "catalog" / f"{name}.yaml").read_text(encoding="utf-8"))
        services[name] = {"owner": y.get("owner"), "provides": y.get("provides") or {}, "consumes": y.get("consumes") or [],
                          "dependsOn": y.get("dependsOn") or []}
    contracts = []
    for f in sorted((arch / "broker").glob("*.json")):
        c = json.loads(f.read_text(encoding="utf-8"))
        c.pop("_canary", None)
        contracts.append(c)
    rules = []
    for line in (arch / "ARCHITECTURE-RULES.md").read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\| (ARCH-\d+) \| (.+?) \| (.+?) \| (.+?) \|$", line)
        if m:
            rules.append({"id": m[1], "rule": CANARY.sub("", m[2]).replace("`", ""), "owner": m[3], "enforced_by": m[4]})
    tickets = {t: (paths.TASKS / f"{t}.md").read_text(encoding="utf-8").strip() for t in ("X-rename", "X-remove")}
    data = {"services": services, "contracts": contracts, "rules": rules, "tickets": tickets}
    assert "CANARY" not in json.dumps(data), "canary leaked into scenario.json"
    write(WORK / "scenario.json", data)
    return {"services": len(services), "contracts": len(contracts), "rules": len(rules)}


def timeline(by_id: dict) -> dict:
    """X1 runs per worker from runner.log.jsonl (run_started / run_finished), with each finished run's record facts."""
    rows, open_ = [], {}
    for ev in read_jsonl(paths.runner_log_path("real")) or []:
        rid = str(ev.get("run_id") or "")
        if not rid.startswith("x1"):
            continue
        if ev.get("event") == "run_started":
            open_[rid] = ev
        elif ev.get("event") == "run_finished" and rid in open_:
            s = open_.pop(rid)
            r = by_id.get(rid) or {}
            rows.append({"run_id": rid, "worker": s.get("worker"), "start": s.get("ts"), "end": ev.get("ts"),
                         "ticket": r.get("ticket"), "V": r.get("visibility"), "outcome": r.get("outcome"),
                         "staging_break": (r.get("metrics") or {}).get("staging_break")})
    for rid, s in open_.items():
        rows.append({"run_id": rid, "worker": s.get("worker"), "start": s.get("ts"), "end": None})
    rows.sort(key=lambda x: str(x["start"]))
    out = {"runs": rows, "workers": sorted({r["worker"] for r in rows if r["worker"] is not None})}
    write(WORK / "timeline.json", out)
    return {"runs": len(rows), "unfinished": len(open_)}


def run_facts(break_rec: dict, stop_rec: dict) -> dict:
    """What the cards around the theater say, taken from the two records (nothing typed by hand)."""
    def failing(ci_entry):
        return [{"id": c.get("id"), "output": [ln for ln in (c.get("output") or "").splitlines() if " FAIL " in ln][:4]}
                for c in (ci_entry.get("verdict") or {}).get("checks") or [] if c.get("status") == "fail"]

    def oracle(state):
        cons = ((break_rec.get("oracle") or {}).get(state) or {}).get("consumers") or {}
        return {k: {"ok": v.get("ok"), "head": (v.get("message") or "").split(":")[0]} for k, v in cons.items()}

    br = {"run_id": break_rec["run_id"], "ticket": break_rec.get("ticket"), "ticket_text": break_rec.get("ticket_text"),
          "V": break_rec.get("visibility"), "S": break_rec.get("spec"), "outcome": break_rec.get("outcome"),
          "ticket_done": break_rec.get("ticket_done"), "turns": (break_rec.get("totals") or {}).get("turns"),
          "minutes": round((break_rec.get("duration_ms") or 0) / 60000, 1), "model": break_rec.get("model_reported"),
          "ci": [{"attempt": c.get("attempt"), "ref": c.get("ref"), "ok": (c.get("verdict") or {}).get("ok"),
                  "failing": failing(c)} for c in break_rec.get("ci") or []],
          "oracle_gen": oracle("gen"), "oracle_final": oracle("final")}
    # the repair's @deprecated lines, straight from the archived diff of the last repair session
    fixes = sorted((paths.run_dir("real", break_rec["run_id"]) / "diffs").glob("fix*.diff"))
    br["repair_diff"] = fixes[-1].name if fixes else None
    br["deprecated_lines"] = [ln[1:].strip() for ln in (fixes[-1].read_text(encoding="utf-8").splitlines() if fixes else [])
                              if ln.startswith("+") and "@deprecated" in ln][:4]
    msg = stop_rec.get("final_message") or ""
    st = {"run_id": stop_rec["run_id"], "ticket": stop_rec.get("ticket"), "V": stop_rec.get("visibility"),
          "S": stop_rec.get("spec"), "outcome": stop_rec.get("outcome"), "turns": (stop_rec.get("totals") or {}).get("turns"),
          "minutes": round((stop_rec.get("duration_ms") or 0) / 60000, 1), "final_message": msg}
    data = {"break": br, "stop": st}
    write(WORK / "facts.json", data)
    return {"break_ci_attempts": len(br["ci"]), "stop_message_chars": len(msg)}


def snapshot() -> int:
    """results/real without workspace.bundle, for the private console (its replay cache then writes here, not in results/)."""
    src = paths.ns_dir("real")
    dst = WORK / "results" / "real"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    # every manifest (the P6 and addendum sidecars too, else the console lists only the main manifest's runs), the
    # state, the coding labels and the reviewer study the Results page reads
    names = ["state.json", "runner.log.jsonl", "x1-summary.json", "x1-summary.md"] + sorted(
        f.name for f in src.glob("manifest*.json"))
    for name in names:
        if (src / name).is_file():
            shutil.copy2(src / name, dst / name)
    for sub in ("coding/labels.json", "reviews/reviews.jsonl", "reviews/pr_set.json"):
        if (src / sub).is_file():
            (dst / sub).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src / sub, dst / sub)
    n = 0
    for d in sorted((src / "runs").iterdir()):
        if not d.is_dir():
            continue
        t = dst / "runs" / d.name
        t.mkdir(parents=True)
        for f in d.iterdir():
            if f.is_file() and f.name not in ("workspace.bundle", "replay.json"):
                shutil.copy2(f, t / f.name)
            elif f.is_dir() and f.name == "diffs":
                shutil.copytree(f, t / "diffs")
        n += 1
    (WORK / "results" / "mock" / "runs").mkdir(parents=True, exist_ok=True)
    for f in paths.results_root().glob("smoke*.json"):      # the live smoke tests Run Control's guards read
        shutil.copy2(f, WORK / "results" / f.name)
    return n


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="video/prepare.py")
    ap.add_argument("--break-run", default="x1-0002", help="real X1 V0 run that breaks a consumer (segment 3)")
    ap.add_argument("--stop-run", default="x1-0003", help="real X1 V2 run that stops and asks (segment 4)")
    ap.add_argument("--summary", choices=["auto", "file", "live"], default="auto")
    ap.add_argument("--no-snapshot", action="store_true", help="keep the existing console snapshot")
    a = ap.parse_args(argv)
    WORK.mkdir(exist_ok=True)
    recs = x1_records()
    by_id = {r["run_id"]: r for r in recs}
    for rid, want in ((a.break_run, "V0"), (a.stop_run, "V2")):
        r = by_id.get(rid)
        if not r or r.get("visibility") != want:
            raise SystemExit(f"{rid}: not a finished X1 {want} run")
    runs = sorted(({"run_id": r["run_id"], "ticket": r.get("ticket"), "V": r.get("visibility"), "outcome": r.get("outcome"),
                    "staging_break": (r.get("metrics") or {}).get("staging_break"), "ticket_done": r.get("ticket_done"),
                    "ended_at": r.get("ended_at"), "minutes": round((r.get("duration_ms") or 0) / 60000, 1)} for r in recs),
                  key=lambda x: str(x["ended_at"]))
    write(WORK / "runs.json", runs)
    meta = {"break_run": a.break_run, "stop_run": a.stop_run,
            "break_record": {k: by_id[a.break_run].get(k) for k in ("ticket", "visibility", "spec", "outcome", "ticket_done", "unit", "model_reported")},
            "stop_record": {k: by_id[a.stop_run].get(k) for k in ("ticket", "visibility", "spec", "outcome", "ticket_done", "unit", "model_reported")},
            "replays": build_replays([a.break_run, a.stop_run]),
            "summary": summary(a.summary, recs), "scenario": scenario(),
            "timeline": timeline(by_id), "facts": run_facts(by_id[a.break_run], by_id[a.stop_run]),
            "snapshot_runs": None if a.no_snapshot else snapshot(),
            "prepared_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    write(WORK / "meta.json", meta)
    print(json.dumps(meta, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
