"""Deck clips, step 1: gather what the clips show (read-only on results/ and scenario/; writes only video/work/).

    .venv\\Scripts\\python.exe -X utf8 video\\prepare_clips.py [--one-run auto|<run id>] [--codex-run auto|<run id>]

  replays/<run>.json   the two featured real runs, built in memory with replay.export.build_replay
  scenario.json        the four services, contracts and ARCH rules (canary markers stripped; prepare.scenario)
  clip-facts.json      what the cards say, taken from the two records (nothing typed by hand)
  theater/             a frozen copy of console/plugins/replay/web/dist (with the AI-SDLC scenes)
  clips-meta.json      what was used and when

Run picks are rules, not choices: the one-run clip uses the poll-PR run (analysis.select_poll_pr, spec 14.3); the
Codex clip uses the first P6 X-remove V1·S0 codex run in manifest order that edited a consumer contract (detector D6).
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

VIDEO = Path(__file__).resolve().parent
REPO = VIDEO.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(VIDEO))

from analysis import common  # noqa: E402
from analysis.select_poll_pr import select  # noqa: E402
from harness import paths  # noqa: E402
from harness.jsonio import read_json  # noqa: E402
import prepare  # noqa: E402  (the draft's helpers: build_replays, scenario, write)

WORK = prepare.WORK


def codex_run() -> dict:
    man = read_json(paths.ns_dir("real") / "manifest-p6.json") or {}
    recs = {r["run_id"]: r for r in common.load_records("real")}
    for m in man.get("runs", []):
        if (m["ticket"], m["visibility"], m["spec"], m["unit"]) != ("X-remove", "V1", "S0", "codex"):
            continue
        r = recs.get(m["run_id"])
        flags = [f for d in (r or {}).get("detectors") or [] for f in d.get("flags") or []]
        if r and any(f.get("detector") == "D6" for f in flags):
            return r
    raise SystemExit("no P6 X-remove V1·S0 codex run with a consumer-contract edit")


def heads(rec: dict, state: str) -> dict:
    cons = ((rec.get("oracle") or {}).get(state) or {}).get("consumers") or {}
    out = {}
    for k, v in cons.items():
        msg = v.get("message") or ""
        first = msg.split(" | ")[0]
        parts = first.split(": ")
        out[k] = {"ok": v.get("ok"), "tests": parts[0] if parts else msg,
                  "impact": parts[2] if len(parts) > 2 else (parts[1] if len(parts) > 1 else ""),
                  "detail": ": ".join(parts[3:])[:160] if len(parts) > 3 else ""}
    return out


def one_run_facts(r: dict) -> dict:
    ci = []
    for c in r.get("ci") or []:
        v = c.get("verdict") or {}
        ci.append({"attempt": c.get("attempt"), "ok": v.get("ok"),
                   "failing": [{"id": k.get("id"), "lines": [ln for ln in (k.get("output") or "").splitlines()
                                                              if " FAIL " in ln][:4]}
                               for k in v.get("checks") or [] if k.get("status") == "fail"],
                   "checks": len(v.get("checks") or [])})
    fixes = sorted((paths.run_dir("real", r["run_id"]) / "diffs").glob("fix*.diff"))
    dep = [ln[1:].strip() for ln in (fixes[-1].read_text(encoding="utf-8").splitlines() if fixes else [])
           if ln.startswith("+") and "@deprecated" in ln][:4]
    return {"run_id": r["run_id"], "stage": r.get("stage"), "unit": r.get("unit"), "model": r.get("model_reported"),
            "ticket": r.get("ticket"), "ticket_text": r.get("ticket_text"), "V": r.get("visibility"),
            "S": r.get("spec"), "outcome": r.get("outcome"), "ticket_done": r.get("ticket_done"),
            "turns": (r.get("totals") or {}).get("turns"), "minutes": round((r.get("duration_ms") or 0) / 60000, 1),
            "ci": ci, "oracle_gen": heads(r, "gen"), "oracle_final": heads(r, "final"),
            "repair_diff": fixes[-1].name if fixes else None, "deprecated_lines": dep}


def codex_facts(r: dict) -> dict:
    flags = [f for d in r.get("detectors") or [] for f in d.get("flags") or []]
    return {"run_id": r["run_id"], "stage": r.get("stage"), "unit": r.get("unit"), "model": r.get("model_reported"),
            "ticket": r.get("ticket"), "ticket_text": r.get("ticket_text"), "V": r.get("visibility"),
            "S": r.get("spec"), "outcome": r.get("outcome"),
            "ci_first_ok": ((r.get("ci") or [{}])[0].get("verdict") or {}).get("ok"),
            "flags": [{"detector": f.get("detector"), "path": f.get("path"), "summary": f.get("summary")} for f in flags],
            "oracle_gen": heads(r, "gen"), "turns": (r.get("totals") or {}).get("turns"),
            "minutes": round((r.get("duration_ms") or 0) / 60000, 1)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="video/prepare_clips.py")
    ap.add_argument("--one-run", default="auto")
    ap.add_argument("--codex-run", default="auto")
    a = ap.parse_args(argv)
    WORK.mkdir(exist_ok=True)
    recs = {r["run_id"]: r for r in common.load_records("real")}
    one = select("real") if a.one_run == "auto" else recs[a.one_run]
    cx = codex_run() if a.codex_run == "auto" else recs[a.codex_run]
    facts = {"one": one_run_facts(one), "codex": codex_facts(cx)}
    prepare.write(WORK / "clip-facts.json", facts)
    meta = {"one_run": one["run_id"], "codex_run": cx["run_id"],
            "rules": {"one_run": "poll-PR rule (analysis.select_poll_pr, spec 14.3)",
                      "codex_run": "first P6 X-remove V1·S0 codex run in manifest order with a D6 flag"},
            "replays": prepare.build_replays([one["run_id"], cx["run_id"]]), "scenario": prepare.scenario(),
            "prepared_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    dist = REPO / "console" / "plugins" / "replay" / "web" / "dist"
    shutil.rmtree(WORK / "theater", ignore_errors=True)
    shutil.copytree(dist, WORK / "theater")
    prepare.write(WORK / "clips-meta.json", meta)
    print(json.dumps(meta, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
