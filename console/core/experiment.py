"""Read-only views of the experiment's files, shared by the Overview and Readiness plugins.

Everything here tolerates missing files (other packages are built in parallel): absent → a clear "not yet" value.
Nothing here ever returns an outcome of a blinded stage.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from harness import blinding, paths
from harness.jsonio import read_json, read_jsonl

STAGES = ["P0", "X1", "P1", "P2", "P3", "P4", "P5", "P6"]
STAGE_NAMES = {
    "P0": "Calibration", "X1": "Pilot X1 · exploratory", "P1": "Core", "P2": "Pressure", "P3": "Reviewers (RQ4)",
    "P4": "Breadth", "P5": "Optional: Opus, RQ5", "P6": "Later: Codex",
}
MAIN_STAGES = ["P1", "P2", "P4"]  # what "data collection" means before the optional stages

# §10.8: the five calls of the live smoke test, shown before the owner confirms. Never run by the builder.
SMOKE_CALLS = [
    {"n": 1, "prompt": "Reply with OK.",
     "checks": "token auth with an isolated CLAUDE_CONFIG_DIR; clean system/init (no MCP servers, claude.ai connectors, "
               "plugins, user skills or slash commands); no hook events (--include-hook-events); the real model id."},
    {"n": 2, "prompt": "List the files in this directory, then read each one.  (--max-turns 2)",
     "checks": "--max-turns exists and is honoured; records the exact subtype and is_error of the capped end."},
    {"n": 3, "prompt": "Edit a file and run `npm run hello`; then `curl https://example.com` and `node -e \"console.log(1)\"`.",
     "checks": "acceptEdits and the allowlist work; curl and node are denied."},
    {"n": 4, "prompt": "--resume the previous session with a short message.",
     "checks": "resume works with the isolated configuration."},
    {"n": 5, "prompt": "Run `npm run envcheck` and read `..\\agents-vs-gates\\README.md`.",
     "checks": "envcheck prints only TOKEN_IN_ENV=yes|no (never the value); the read outside the workspace is denied."},
]
SMOKE_NOTE = ("At most 5 calls, all with --model sonnet and the isolation flags of §10.3–§10.4, in C:\\avg\\smoke\\ "
              "(outside the scenario). Results go to docs/ENVIRONMENT.md and results/smoke.json.")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load(ns: str) -> tuple[dict, dict]:
    """The manifest includes the pilot runs (X1), which are computed, not stored in manifest.json."""
    from harness import manifest as manifest_mod
    try:
        m = manifest_mod.load(ns)
    except (OSError, ValueError, AttributeError, TypeError):
        m = None
    s = read_json(paths.state_path(ns), default=None)
    return (m if isinstance(m, dict) else {}), (s if isinstance(s, dict) else {})


def stage_of_run(run_id: str) -> str | None:
    if run_id.startswith("st-"):
        return "selftest"
    if run_id.startswith(("x1-", "x1c-")):
        return "X1"
    if len(run_id) > 2 and run_id[0] == "p" and run_id[1].isdigit():
        return "P" + run_id[1]
    return None


# ---------------------------------------------------------------- progress

def stage_progress(ns: str) -> list[dict]:
    manifest, state = load(ns)
    st_runs = state.get("runs") or {}
    usage = state.get("usage") or {}
    unblinded = state.get("unblinded") or {}
    out = []
    for stage in STAGES:
        runs = blinding.stage_runs(manifest, stage)
        c = {"pending": 0, "running": 0, "done": 0, "infra_failure": 0, "infra_failure_final": 0}
        infra_events = 0
        for r in runs:
            s = st_runs.get(r["run_id"], {})
            c[s.get("status", "pending")] = c.get(s.get("status", "pending"), 0) + 1
            infra_events += int(s.get("infra_failures") or 0)
        total = len(runs)
        terminal = c["done"] + c["infra_failure_final"]
        complete = blinding.stage_complete(manifest, state, stage)
        if stage in blinding.ALWAYS_VISIBLE:
            blind = "visible"
        elif unblinded.get(stage):
            blind = "unblinded_forced" if unblinded[stage].get("forced") else "unblinded"
        else:
            blind = "blinded"
        u = usage.get(stage) or {}
        out.append({
            "stage": stage, "name": STAGE_NAMES[stage], "total": total, "done": terminal, "completed_ok": c["done"],
            "running": c["running"], "pending": c["pending"] + c["infra_failure"], "infra_final": c["infra_failure_final"],
            "infra_events": infra_events, "complete": complete, "blinding": blind,
            "unblinded_at": (unblinded.get(stage) or {}).get("at"),
            "tokens": int(sum(float(u.get(k) or 0) for k in ("input_tokens", "output_tokens", "cache_read_tokens",
                                                                "cache_creation_tokens"))) if u else None,
            "minutes": u.get("minutes") if u else None,
            "in_manifest": total > 0,
        })
    return out


def run_counts(ns: str) -> dict:
    manifest, state = load(ns)
    st_runs = state.get("runs") or {}
    planned = len(manifest.get("runs") or [])
    done = sum(1 for r in st_runs.values() if (r or {}).get("status") in blinding.TERMINAL)
    infra = sum(int((r or {}).get("infra_failures") or 0) for r in st_runs.values())
    infra_final = sum(1 for r in st_runs.values() if (r or {}).get("status") == "infra_failure_final")
    archived = 0
    selftest = 0
    rd = paths.runs_dir(ns)
    if rd.is_dir():
        for d in rd.iterdir():
            if d.is_dir():
                archived += 1
                selftest += d.name.startswith("st-")
    return {"ns": ns, "planned": planned, "done": done, "infra_failures": infra, "infra_final": infra_final,
            "archived": archived, "selftest": selftest, "has_manifest": bool(manifest)}


def last_quota_event() -> dict | None:
    best = None
    for ns in paths.NAMESPACES:
        for ev in read_jsonl(paths.runner_log_path(ns)) if paths.runner_log_path(ns).exists() else []:
            if ev.get("event") == "rate_limited":
                cand = {"ns": ns, "ts": ev.get("ts"), "until": ev.get("until")}
                if best is None or str(cand["ts"]) > str(best["ts"]):
                    best = cand
        _, state = load(ns)
        r = state.get("runner") or {}
        if r.get("status") == "rate_limited" and (best is None or best["ns"] != ns):
            cand = {"ns": ns, "ts": state.get("updated_at"), "until": r.get("rate_limited_until")}
            if best is None or str(cand["ts"]) > str(best["ts"]):
                best = cand
    return best


# ---------------------------------------------------------------- headlines (unblinded stages only)

def _records(ns: str, run_ids: list[str]) -> list[dict]:
    out = []
    for rid in run_ids:
        rec = read_json(paths.run_dir(ns, rid) / "record.json", default=None)
        if isinstance(rec, dict):
            out.append(rec)
    return out


def headlines(ns: str) -> list[dict]:
    """Raw counts for stages that were explicitly unblinded (P0 is calibration; it never feeds headlines)."""
    manifest, state = load(ns)
    unblinded = [s for s in STAGES if (state.get("unblinded") or {}).get(s) and s != "P0"]
    if not unblinded:
        return []
    out: list[dict] = []
    try:  # WP2's analysis, when present, is the authority
        from analysis.summarize import aggregate  # type: ignore
        agg = aggregate(ns)
        items = agg.get("headlines") if isinstance(agg, dict) else None
        if isinstance(items, list) and items:
            for it in items:
                if isinstance(it, str):
                    out.append({"stage": None, "text": it})
                elif isinstance(it, dict) and it.get("text") and (it.get("stage") in unblinded or it.get("stage") is None):
                    out.append({"stage": it.get("stage"), "text": it["text"]})
            return out
    except Exception:  # noqa: BLE001 — analysis not built yet or failed: fall back to raw counts
        pass
    st_runs = state.get("runs") or {}
    for stage in unblinded:
        if not blinding.is_visible(state, stage):
            continue
        ids = [r["run_id"] for r in blinding.stage_runs(manifest, stage)
               if (st_runs.get(r["run_id"]) or {}).get("status") == "done"]
        recs = [r for r in _records(ns, ids) if r.get("outcome") not in (None, "infra_failure")]
        n = len(recs)
        if not n:
            continue
        broke = sum(1 for r in recs if (r.get("metrics") or {}).get("staging_break") is True)
        done = sum(1 for r in recs if r.get("ticket_done") == "done")
        flagged = sum(1 for r in recs if (r.get("metrics") or {}).get("consumer_break_ci") is True)
        out.append({"stage": stage, "text": f"{broke} of {n} PRs broke a deployed consumer (staging oracle)"})
        out.append({"stage": stage, "text": f"{done} of {n} runs completed the ticket"})
        out.append({"stage": stage, "text": f"{flagged} of {n} PRs were flagged by CI for a consumer contract"})
    return out


# ---------------------------------------------------------------- pre-registration, smoke, paraphrases

def sha256_file(p: Path) -> str | None:
    try:
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def prereg_status() -> dict:
    lock = paths.PREREG_LOCK
    out = {"frozen": False, "frozen_at": None, "short_hash": None, "files": [], "lock_path": "PREREGISTRATION.lock",
           "parse_error": None, "prereg_md": (paths.REPO / "PREREGISTRATION.md").exists()}
    if not lock.exists():
        return out
    out["frozen"] = True
    raw = lock.read_bytes()
    out["short_hash"] = hashlib.sha256(raw).hexdigest()[:12]
    files: list[tuple[str, str]] = []
    frozen_at = None
    try:
        data = json.loads(raw.decode("utf-8"))
        frozen_at = data.get("frozen_at") or data.get("date") or data.get("at") or data.get("created_at")
        if isinstance(data.get("aggregate_sha256"), str):  # harness.prereg's own short id (what its CLI prints)
            out["short_hash"] = data["aggregate_sha256"][:12]
        f = data.get("files") or data.get("hashes") or {}
        if isinstance(f, dict):
            files = [(k, v if isinstance(v, str) else (v or {}).get("sha256")) for k, v in f.items()]
        elif isinstance(f, list):
            files = [(x.get("path") or x.get("file"), x.get("sha256") or x.get("hash")) for x in f if isinstance(x, dict)]
    except (UnicodeDecodeError, ValueError, AttributeError):
        for line in raw.decode("utf-8", "replace").splitlines():
            m = re.match(r"^\s*([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$", line)
            if m:
                files.append((m.group(2), m.group(1).lower()))
            elif line.lower().startswith(("frozen_at", "date")) and ":" in line:
                frozen_at = line.split(":", 1)[1].strip()
        if not files:
            out["parse_error"] = "PREREGISTRATION.lock is not in a format the console understands"
    if not frozen_at:
        frozen_at = datetime.fromtimestamp(lock.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
    out["frozen_at"] = frozen_at
    for path, sha in files:
        if not path:
            continue
        cur = sha256_file(paths.REPO / path)
        out["files"].append({"path": path, "sha256": sha, "current_sha256": cur,
                             "status": "missing" if cur is None else ("same" if cur == (sha or "").lower() else "changed")})
    return out


def smoke_status() -> dict:
    p = paths.results_root() / "smoke.json"
    data = read_json(p, default=None) if p.exists() else None
    status = "not_run"
    if isinstance(data, dict):
        ok = data.get("ok", data.get("passed"))
        if ok is None and isinstance(data.get("status"), str):
            ok = data["status"].lower() in ("passed", "ok", "pass")
        status = "passed" if ok else "failed"
    return {"status": status, "result": data, "available": (paths.REPO / "harness" / "smoke.py").exists(),
            "calls": SMOKE_CALLS, "note": SMOKE_NOTE}


def paraphrase_status() -> dict:
    files = sorted(paths.TASKS.glob("*.p[0-9]*.md")) if paths.TASKS.is_dir() else []
    todo = [f.name for f in files if "TODO(human)" in f.read_text(encoding="utf-8", errors="replace")]
    return {"files": len(files), "todo": len(todo), "todo_files": todo}


def p0_complete() -> bool:
    m, s = load("real")
    return blinding.stage_complete(m, s, "P0")


def checklist_path() -> Path:
    return paths.REPO / "docs" / "REVIEW-CHECKLIST.md"


def checklist_items(data_dir: Path) -> dict:
    """docs/REVIEW-CHECKLIST.md '- [ ]' items merged with who/when from <data_dir>/checklist.json."""
    p = checklist_path()
    if not p.exists():
        return {"exists": False, "items": [], "done": 0, "total": 0}
    marks = (read_json(Path(data_dir) / "checklist.json", default=None) or {}).get("items", {})
    items = []
    section = None
    seen: dict[str, int] = {}
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        hm = re.match(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$", line)
        if hm:
            section = hm.group(1)
            continue
        m = re.match(r"^\s*[-*]\s+\[( |x|X)\]\s+(.*\S)\s*$", line)
        if not m:
            continue
        text = m.group(2)
        base = hashlib.sha1(f"{section}|{text}".encode("utf-8")).hexdigest()[:12]
        seen[base] = seen.get(base, 0) + 1
        iid = base if seen[base] == 1 else f"{base}-{seen[base]}"
        mark = marks.get(iid)
        if mark is not None:
            checked, by, at = bool(mark.get("checked")), mark.get("by"), mark.get("at")
        else:
            checked, by, at = m.group(1).lower() == "x", ("file" if m.group(1).lower() == "x" else None), None
        items.append({"id": iid, "section": section, "text": text, "checked": checked, "by": by, "at": at})
    return {"exists": True, "items": items, "done": sum(1 for i in items if i["checked"]), "total": len(items)}


# ---------------------------------------------------------------- phase and next action

def phase_and_next(data_dir: Path) -> dict:
    """Simple rules over the real namespace (spec §22.1). Returns {phase, phase_detail, next: {text, plugin, params, why}}."""
    smoke = smoke_status()
    pre = prereg_status()
    para = paraphrase_status()
    real = {p["stage"]: p for p in stage_progress("real")}
    real_counts = run_counts("real")
    _, rstate = load("real")
    runner = rstate.get("runner") or {}
    chk = checklist_items(data_dir)

    def nxt(text, plugin=None, params=None, why=None):
        return {"text": text, "plugin": plugin, "params": params or {}, "why": why}

    p0 = real["P0"]
    if smoke["status"] != "passed":
        phase = ("Setup", "Environment and live smoke test")
    elif not p0["complete"]:
        phase = ("Calibration", f"P0: {p0['done']} of {p0['total'] or 5} runs")
    elif not pre["frozen"]:
        phase = ("Pre-registration", "Calibrated; waiting for the freeze")
    elif any(real[s]["in_manifest"] and not real[s]["complete"] for s in MAIN_STAGES):
        phase = ("Data collection", "Pre-registered")
    else:
        phase = ("Analysis", "Main stages complete")

    status = runner.get("status")
    if status in ("running", "stopping"):
        b = runner.get("batch") or {}
        st = runner.get("stage") or "?"
        action = nxt(f"Batch running: {st} ({b.get('done', 0)} of {b.get('planned', '?')} in this batch)", "run-control",
                     why="Follow it live in Run Control.")
    elif status == "rate_limited":
        until = runner.get("rate_limited_until")
        action = nxt("Usage limit reached: schedule a resume" + (f" after {until}" if until else ""), "run-control",
                     why="The runner stopped cleanly; nothing was lost.")
    elif smoke["status"] == "not_run":
        action = nxt("Run the smoke test", "readiness", {"tab": "smoke"}, "Five live calls verify isolation before any real run (§10.8).")
    elif smoke["status"] == "failed":
        action = nxt("Review the failed smoke test", "readiness", {"tab": "smoke"}, "Nothing real runs until isolation is verified.")
    elif not real_counts["has_manifest"]:
        action = nxt("Generate the run manifest (python -m harness.manifest --seed 20261011)", None,
                     why="The real namespace has no manifest yet.")
    elif not p0["complete"]:
        action = nxt(f"Run P0 calibration ({p0['done']} of {p0['total']} done)", "run-control", {"stage": "P0"},
                     "P0 fixes the model id and effort that will be frozen.")
    elif para["todo"]:
        action = nxt(f"Write the ticket paraphrases ({para['todo']} of {para['files']} files still TODO)", "scenario",
                     {"tab": "tickets"}, "Paraphrases are written by a person (§6.1).")
    elif chk["exists"] and chk["done"] < chk["total"]:
        action = nxt(f"Complete the review checklist ({chk['done']} of {chk['total']} checked)", "readiness",
                     {"tab": "checklist"}, "Cross-review before the freeze (§15).")
    elif not pre["frozen"]:
        action = nxt("Freeze the pre-registration", "readiness", {"tab": "prereg"}, "Real runs from P1 on require the lock (§11.4).")
    else:
        action = None
        for s in ("P1", "P2", "P4", "P5", "P6"):
            p = real[s]
            if p["in_manifest"] and not p["complete"]:
                action = nxt(f"Run {s} batch ({p['done']} of {p['total']} done)", "run-control", {"stage": s})
                break
            if p["in_manifest"] and p["complete"] and p["blinding"] == "blinded":
                action = nxt(f"Unblind {s} (complete)", "run-control", {"stage": s}, "Outcomes stay hidden until you unblind.")
                break
        if action is None:
            action = nxt("Review the results", "results")
    return {"phase": phase[0], "phase_detail": phase[1], "next": action}
