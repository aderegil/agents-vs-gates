"""Resumable batch runner (spec 11.4, 22.2; contract §5).

  python -X utf8 -m harness.runner --stage P1 --batch 10          up to 10 pending runs of P1
  python -X utf8 -m harness.runner --stage P1 --max-minutes 20    or until 20 minutes have passed
  python -X utf8 -m harness.runner --status [--ns mock] [--json]  progress (blind: no outcomes for blinded stages)
  python -X utf8 -m harness.runner --stage P0 --dry-run           list what would run
  python -X utf8 -m harness.runner --stage P1 --unit mock         the whole cycle with the simulated agent
  python -X utf8 -m harness.runner --calibrate                    run P0 and print the P1–P5 projection
  python -X utf8 -m harness.runner --unblind P1 [--force-unblind]
  python -X utf8 -m harness.runner --stage X1 --unit cc-sonnet --workers 3 --max-runs 3   pilot X1 (visible, exploratory;
                                                                  real needs --unit; writes results/<ns>/x1-summary.md)
  python -X utf8 -m harness.runner --stage X2 --workers 1          pilot X2 (X-remove V0/V2, cc-sonnet only; visible,
                                                                  exploratory; writes results/<ns>/x2-summary.md)
  python -X utf8 -m harness.runner --stage P6 --part P1 --workers 3   the P1 part of P6 (codex; needs the sidecar
                                                                  results/<ns>/manifest-p6.json, harness.manifest --p6-sidecar)
  python -X utf8 -m harness.runner --stage C8 --workers 1          agy-flash calibration (addendum 1; exploratory and
                                                                  visible like P0; needs results/smoke-agy.json) -> report
  python -X utf8 -m harness.runner --stage P7 --unit cc-sonnet --workers 3   addendum 1 (needs both locks to verify:
                                                                  PREREGISTRATION.lock and PREREGISTRATION-ADDENDUM-1.lock)
  python -X utf8 -m harness.runner --stage P9 --workers 3          addendum 2, agy-flash (needs the original lock and
                                                                  both addendum locks; sidecar manifest-ext2.json)
Options: --workers 1..6 (above 3 only with every worker folder ready), --max-runs N (alias of --batch; the smaller wins), --ns real|mock, --unit U, --part P1|P2|P4.
Exit codes: 0 ok, 2 usage/guard refusal (lock missing, smoke not passed, model drift), 3 rate-limited, 4 isolation
breach. While running: state.json rewritten atomically at least every second, PID in state.runner.pid,
runner.log.jsonl events (run_finished never carries the outcome), control.json polled between runs,
SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED) held until exit.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
import threading
import time
import traceback
from collections import Counter, defaultdict
from datetime import datetime, timezone

from harness import blinding, jsonio, paths
from harness import manifest as manifest_mod

EXIT_OK, EXIT_GUARD, EXIT_RATE, EXIT_BREACH = 0, 2, 3, 4
MAX_INFRA_RETRIES = 2
STAGES = (("P0", "P1", "P2", "P4", "P5", "P6") + manifest_mod.EXT_STAGES + manifest_mod.EXT2_STAGES
          + manifest_mod.PILOTS + manifest_mod.CAL_STAGES)
EXPLORATORY = ("P0",) + manifest_mod.PILOTS + manifest_mod.CAL_STAGES   # exempt from the locks (calibration, pilots)
MULTI_UNIT = manifest_mod.PILOTS + ("P7",)       # stages whose real runs belong to several units: --unit required
DRIFT_NOTED = (manifest_mod.EXT_STAGES + manifest_mod.EXT2_STAGES   # addenda 1 and 2: model drift is recorded,
               + manifest_mod.CAL_STAGES)                                # not a stop


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ---------------------------------------------------------------- state ------------------------------------------

def new_state(ns: str) -> dict:
    return {"schema": "state/1", "namespace": ns, "manifest_sha256": None, "runs": {},
            "runner": {"pid": None, "status": "idle", "started_at": None, "stage": None, "unit": None, "workers": 1,
                       "batch": None, "rate_limited_until": None, "sleep_prevented": False, "heartbeat_at": None,
                       "message": None},
            "workers": {}, "unblinded": {}, "usage": {}, "resume_at": None, "updated_at": now()}


def load_state(ns: str, manifest: dict | None) -> dict:
    st = jsonio.read_json(paths.state_path(ns)) or new_state(ns)
    for r in (manifest or {}).get("runs", []):
        st["runs"].setdefault(r["run_id"], {"status": "pending"})
    for rid, r in st["runs"].items():                    # a run cut in the middle is discarded and re-run
        if r.get("status") == "running":
            r["status"] = "pending"
            r["last_error"] = "interrupted (runner restarted)"
    st["manifest_sha256"] = manifest_mod.sha256(paths.manifest_path(ns))
    p6_sha = manifest_mod.sha256(manifest_mod.p6_path(ns))
    if p6_sha:
        st["p6_manifest_sha256"] = p6_sha
    ext_sha = manifest_mod.sha256(manifest_mod.ext1_path(ns))
    if ext_sha:
        st["ext1_manifest_sha256"] = ext_sha
    ext2_sha = manifest_mod.sha256(manifest_mod.ext2_path(ns))
    if ext2_sha:
        st["ext2_manifest_sha256"] = ext2_sha
    return st


class State:
    def __init__(self, ns: str, data: dict):
        self.ns, self.data, self.lock = ns, data, threading.RLock()

    def save(self) -> None:
        with self.lock:
            self.data["updated_at"] = now()
            self.data["runner"]["heartbeat_at"] = self.data["updated_at"]
            jsonio.write_json_atomic(paths.state_path(self.ns), self.data)

    def run(self, rid: str) -> dict:
        return self.data["runs"].setdefault(rid, {"status": "pending"})


def other_runner(ns: str) -> int | None:
    """PID of another live runner of this namespace (its lock file, or state.json's runner.pid), else None. Two
    runners would share state.json and the worker folders (2026-10-16 overlap, DECISIONS)."""
    from console.core.runner_ctl import pid_alive
    pids = []
    try:
        pids.append(int(paths.runner_lock_path(ns).read_text(encoding="utf-8").strip() or 0))
    except (OSError, ValueError):
        pass
    pids.append(((jsonio.read_json(paths.state_path(ns)) or {}).get("runner") or {}).get("pid"))
    for pid in pids:
        if pid and pid != os.getpid() and pid_alive(pid):
            return int(pid)
    return None


def log(ns: str, event: str, **kw) -> None:
    jsonio.append_jsonl(paths.runner_log_path(ns), {"ts": now(), "event": event, **kw})


_WS_PREFIX = re.compile(r"(?i)[a-z]:[\\/]avg[\\/]w[^\\/\s]*[\\/](?:r[\\/])?")


def activity_line(rid: str, ev: dict) -> str | None:
    """One stdout line per agent action, for the console's Runner output panel. Only printed for visible stages
    (spec 11.4): the sequence of sessions would tell a blinded stage when CI failed."""
    kind, sess = ev.get("kind"), ev.get("session") or "gen"
    if kind == "tool_call":
        inp = ev.get("input") or {}
        arg = next((inp[k] for k in ("command", "file_path", "pattern", "path", "url") if isinstance(inp.get(k), str)), "")
        what = f"{ev.get('name') or 'tool'} {_WS_PREFIX.sub('', arg)}".strip()
    elif kind == "text":
        what = "says: " + " ".join(str(ev.get("text") or "").split())
    elif kind == "tool_result" and ev.get("status") in ("denied", "error"):
        what = f"  -> {ev['status']}"
    else:
        return None
    return f"  {rid} [{sess}] {what[:160]}"


# ---------------------------------------------------------------- guards -----------------------------------------

def smoke_files(units_used) -> dict:
    """results/<file> that must hold a passed smoke for these units -> the extra CLI args that produce it.
    Claude Code units: smoke.json; the codex adapter: smoke-codex.json (harness/smoke_codex.py)."""
    try:
        from harness import cycle
        table = cycle.load_units()
    except (OSError, ValueError):
        table = {}
    out = {}
    for u in sorted(units_used):
        adapter = (table.get(u) or {}).get("adapter")
        if adapter == "codex":
            out["smoke-codex.json"] = " --unit codex"
        elif adapter == "agy":
            out["smoke-agy.json"] = " --unit agy-flash"
        elif adapter != "mock":
            out["smoke.json"] = ""
    return out or {"smoke.json": ""}


def guard_errors(ns: str, stage: str, units_used: set[str]) -> list[str]:
    if ns == "mock":
        return []
    errs = []
    for name, cmd in smoke_files(units_used).items():
        smoke = jsonio.read_json(paths.results_root() / name)
        if not (smoke and smoke.get("ok")):
            errs.append(f"live smoke test not passed (results/{name}); run `python -m harness.smoke{cmd}` with "
                        "authorization")
    if stage not in EXPLORATORY:
        from harness import prereg
        ok, problems = prereg.verify()
        if not ok:
            errs.append("pre-registration lock missing or does not match: " + "; ".join(problems[:5]))
        if stage in manifest_mod.EXT_STAGES + manifest_mod.EXT2_STAGES:
            ok, problems = prereg.verify_addendum(1)
            if not ok:
                errs.append("addendum-1 lock missing or does not match: " + "; ".join(problems[:5]))
        if stage in manifest_mod.EXT2_STAGES:          # P9 runs addendum 1's unit and adapter under addendum 2
            ok, problems = prereg.verify_addendum(2)
            if not ok:
                errs.append("addendum-2 lock missing or does not match: " + "; ".join(problems[:5]))
    for u in units_used:
        if u == "mock":
            errs.append("unit mock in the real namespace")
    return errs


def _full_model_id(model: str | None) -> bool:
    return bool(model and re.search(r"\d", model) and "-" in model)


class Execution:
    def __init__(self):
        self.prev = None

    def __enter__(self):
        if os.name == "nt":
            try:
                import ctypes
                self.prev = ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001)
            except (AttributeError, OSError):
                self.prev = None
        return self

    @property
    def active(self) -> bool:
        return bool(self.prev)

    def __exit__(self, *exc):
        if os.name == "nt" and self.prev:
            import ctypes
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)


# ---------------------------------------------------------------- batch ------------------------------------------

class Batch:
    def __init__(self, ns: str, stage: str, runs: list[dict], state: State, manifest: dict, *, workers: int,
                 max_runs: int | None, max_minutes: float | None, unit_label: str | None, pipeline=None,
                 mock_scripts: dict | None = None, quiet: bool = False):
        self.ns, self.stage, self.state, self.manifest = ns, stage, state, manifest
        self.queue = list(runs)
        self.workers, self.max_runs, self.max_minutes = workers, max_runs, max_minutes
        self.unit_label, self.pipeline, self.mock_scripts, self.quiet = unit_label, pipeline, mock_scripts, quiet
        self.started = 0
        self.t0 = time.monotonic()
        self.stop_reason: str | None = None
        self.exit_code = EXIT_OK
        self.lock = threading.Lock()
        self.alive = True
        self.units = {r["unit"] for r in runs}
        self.paused_units: dict[str, str | None] = {}     # mixed batch: unit -> rate-limit reset (its runs left pending)

    # -- queue
    def _stop_requested(self) -> bool:
        ctl = jsonio.read_json(paths.control_path(self.ns))
        if ctl and ctl.get("stop_after_current"):
            self.stop("stop_after_current requested" + (f" by {ctl.get('by')}" if ctl.get("by") else ""))
        return self.stop_reason is not None

    def stop(self, reason: str, code: int = EXIT_OK) -> None:
        with self.lock:
            if self.stop_reason is None:
                self.stop_reason = reason
            if code and not self.exit_code:
                self.exit_code = code

    def next_run(self) -> dict | None:
        if self._stop_requested():
            return None
        with self.lock:
            if self.max_runs is not None and self.started >= self.max_runs:
                return None
            if self.max_minutes is not None and (time.monotonic() - self.t0) / 60 >= self.max_minutes:
                return None
            if not self.queue:
                return None
            self.started += 1
            return self.queue.pop(0)

    # -- one worker thread
    def worker_loop(self, k: int) -> None:
        from harness import cycle
        units = cycle.load_units()
        st = self.state
        while True:
            entry = self.next_run()
            if entry is None:
                break
            rid = entry["run_id"]
            with st.lock:
                r = st.run(rid)
                r.update(status="running", worker=k, started_at=now(), ended_at=None)
                r["attempts"] = r.get("attempts", 0) + 1
                st.data["workers"][str(k)] = {"run_id": rid, "ticket": entry["ticket"], "cell": entry["cell"],
                                              "attempt": "gen", "started_at": now(), "turns": 0, "tokens": 0}
            log(self.ns, "run_started", run_id=rid, worker=k, ticket=entry["ticket"], cell=entry["cell"])
            show = not self.quiet and blinding.is_visible(st.data, entry.get("stage"))
            if not self.quiet:   # the cell only for visible stages, like every other stdout line
                cell = (f"  {entry['ticket']} {entry.get('visibility', '')}·{entry.get('spec', '')}·"
                        f"{entry.get('wording', '')}") if show else ""
                print(f"{rid}  started{cell}  worker {k}", flush=True)

            def on_event(ev, k=k, rid=rid, show=show):
                if show:
                    line = activity_line(rid, ev)
                    if line:
                        print(line, flush=True)
                with st.lock:
                    w = st.data["workers"].get(str(k)) or {}
                    w["attempt"] = ev.get("session", w.get("attempt"))
                    if ev.get("kind") == "tool_call":
                        w["turns"] = w.get("turns", 0) + 1
                    if ev.get("kind") == "final":
                        u = ev.get("usage") or {}
                        w["tokens"] = w.get("tokens", 0) + int(u.get("input_tokens", 0)) + int(u.get("output_tokens", 0))

            script = (self.mock_scripts or {}).get(rid)
            try:
                rec = cycle.execute_run(entry, ns=self.ns, worker_ns=self.ns, worker=k, units=units,
                                        pipeline=self.pipeline, on_event=on_event, mock_script=script,
                                        seed=self.manifest.get("seed", 0),
                                        infra_retries=st.run(rid).get("infra_failures", 0))
            except Exception as e:  # harness error: counts as an infrastructure failure of this run
                traceback.print_exc(file=sys.stderr)
                log(self.ns, "error", run_id=rid, message=f"{type(e).__name__}: {e}"[:500])
                self._infra(entry, {"kind": "harness_error", "detail": f"{type(e).__name__}: {e}"[:500]}, k)
                continue
            if rec["outcome"] == "infra_failure":
                self._infra(entry, rec["infra_failure"], k, rec)
            else:
                self._done(entry, rec, k)

    def _clear_worker(self, k: int) -> None:
        self.state.data["workers"][str(k)] = None

    def _done(self, entry: dict, rec: dict, k: int) -> None:
        st, rid = self.state, entry["run_id"]
        drift = self._model_drift(rec)
        with st.lock:
            r = st.run(rid)
            self._clear_worker(k)
            if drift:
                r.update(status="pending", ended_at=now(), last_error=drift)
                self.stop(drift, EXIT_GUARD)
                st.data["runner"]["message"] = drift
                return
            r.update(status="done", ended_at=now(), last_error=None)
            u = st.data["usage"].setdefault(entry["stage"], {"runs": 0, "input_tokens": 0, "output_tokens": 0,
                                                              "cache_read_tokens": 0, "cache_creation_tokens": 0,
                                                              "minutes": 0.0, "cost_usd_nominal": 0.0})
            t = rec["totals"]
            u["runs"] += 1
            for key in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"):
                u[key] += t.get(key, 0)
            u["minutes"] = round(u["minutes"] + rec["duration_ms"] / 60000, 3)
            u["cost_usd_nominal"] = round(u["cost_usd_nominal"] + (t.get("cost_usd_nominal") or 0), 6)
            b = st.data["runner"].get("batch") or {}
            b["done"] = b.get("done", 0) + 1
        tokens = rec["totals"]["input_tokens"] + rec["totals"]["output_tokens"]
        log(self.ns, "run_finished", run_id=rid, worker=k, turns=rec["totals"]["turns"],
            duration_ms=rec["duration_ms"], tokens=tokens)
        if not self.quiet:
            print(f"{rid}  turns={rec['totals']['turns']}  duration={rec['duration_ms'] / 1000:.0f}s  "
                  f"tokens={tokens:,}", flush=True)
        st.save()

    def _model_drift(self, rec: dict) -> str | None:
        if self.ns != "real":
            return None
        from harness import cycle
        unit = rec["unit"]
        reported = rec.get("model_reported")
        configured = cycle.load_units().get(unit, {}).get("model")
        seen = self.state.data.setdefault("models_seen", {})
        expected = configured if _full_model_id(configured) else seen.get(unit)
        if reported and expected and reported != expected:
            if rec.get("stage") in DRIFT_NOTED:   # addendum 1: a declared deviation, never a reason to stop
                notes = self.state.data.setdefault("drift_notes", [])
                note = {"stage": rec.get("stage"), "unit": unit, "reported": reported, "expected": expected,
                        "cli_version": rec.get("cli_version")}
                if note not in notes:
                    notes.append(dict(note, first_run=rec.get("run_id"), at=now()))
                    log(self.ns, "model_drift_noted", run_id=rec.get("run_id"), unit=unit, reported=reported,
                        expected=expected)
                return None
            return f"model drift for {unit}: reported {reported}, expected {expected}; batch stopped"
        if reported and unit not in seen:
            seen[unit] = reported
        return None

    def _infra(self, entry: dict, infra: dict, k: int, rec: dict | None = None) -> None:
        st, rid = self.state, entry["run_id"]
        kind = (infra or {}).get("kind", "unknown")
        with st.lock:
            r = st.run(rid)
            self._clear_worker(k)
            r["ended_at"] = now()
            r["last_error"] = f"{kind}: {(infra or {}).get('detail', '')}"[:300]
            if kind == "rate_limited":
                r["status"] = "pending"                        # quota, not a fault: no retry counted
                until = infra.get("reset_at")
                st.data["runner"]["rate_limited_until"] = until
                unit = entry.get("unit")
                if len(self.units) > 1:                        # mixed batch: pause only this unit's queue
                    with self.lock:
                        self.paused_units[unit] = until
                        self.queue = [e for e in self.queue if e.get("unit") != unit]
                        rest = bool(self.queue)
                        if not self.exit_code:
                            self.exit_code = EXIT_RATE
                    st.data["runner"]["message"] = "rate limited: " + ", ".join(
                        f"{u} until {t or 'unknown'}" for u, t in sorted(self.paused_units.items()))
                    log(self.ns, "rate_limited", run_id=rid, until=until, unit=unit, others_continue=rest)
                    if not rest:
                        self.stop(st.data["runner"]["message"], EXIT_RATE)
                else:
                    self.stop(f"rate limited until {until or 'unknown'}", EXIT_RATE)
                    log(self.ns, "rate_limited", run_id=rid, until=until)
            elif kind == "isolation_breach":
                r["status"] = "pending"                        # not re-queued: the batch stops (spec 10.6)
                self.stop(f"isolation breach in {rid}: {infra.get('detail', '')}", EXIT_BREACH)
            else:
                r["infra_failures"] = r.get("infra_failures", 0) + 1
                if r["infra_failures"] > MAX_INFRA_RETRIES:
                    r["status"] = "infra_failure_final"
                    self._mark_final(rid)
                else:
                    r["status"] = "infra_failure"
                    with self.lock:
                        self.queue.append(entry)
        if not self.quiet:
            print(f"{rid}  infrastructure failure ({kind})", flush=True)
        st.save()

    def _mark_final(self, rid: str) -> None:
        p = paths.run_dir(self.ns, rid) / "record.json"
        rec = jsonio.read_json(p)
        if rec and rec.get("infra_failure"):
            rec["infra_failure"]["final"] = True
            jsonio.write_json_atomic(p, rec)

    # -- driver
    def heartbeat(self) -> None:
        while self.alive:
            self.state.save()
            time.sleep(0.9)

    def run(self) -> int:
        st = self.state
        with st.lock:
            st.data["runner"].update(pid=os.getpid(), status="running", started_at=now(), stage=self.stage,
                                     unit=self.unit_label, workers=self.workers, rate_limited_until=None, message=None,
                                     batch={"max_runs": self.max_runs, "max_minutes": self.max_minutes, "done": 0,
                                            "planned": min(len(self.queue), self.max_runs or len(self.queue))})
            st.data["workers"] = {str(k): None for k in range(1, self.workers + 1)}
        log(self.ns, "batch_started", stage=self.stage, unit=self.unit_label, workers=self.workers,
            planned=st.data["runner"]["batch"]["planned"])
        with Execution() as ex:
            st.data["runner"]["sleep_prevented"] = ex.active
            st.save()
            hb = threading.Thread(target=self.heartbeat, daemon=True)
            hb.start()
            threads = [threading.Thread(target=self.worker_loop, args=(k,), daemon=True)
                       for k in range(1, self.workers + 1)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.alive = False
            hb.join(timeout=2)
        status = {EXIT_RATE: "rate_limited", EXIT_BREACH: "error", EXIT_GUARD: "error"}.get(self.exit_code, "stopped")
        with st.lock:
            st.data["runner"].update(pid=None, status=status, sleep_prevented=False,
                                     message=self.stop_reason or st.data["runner"].get("message"))
            st.data["workers"] = {}
        st.save()
        log(self.ns, "stopped", reason=self.stop_reason or "batch finished", exit_code=self.exit_code)
        try:
            paths.control_path(self.ns).unlink()
        except FileNotFoundError:
            pass
        if not self.quiet and self.stop_reason:
            print(f"stopped: {self.stop_reason}", flush=True)
        return self.exit_code


# ---------------------------------------------------------------- status / calibrate ------------------------------

def _records(ns: str, ids) -> dict:
    out = {}
    for rid in ids:
        rec = jsonio.read_json(paths.run_dir(ns, rid) / "record.json")
        if rec:
            out[rid] = rec
    return out


def status(ns: str) -> dict:
    manifest = manifest_mod.load(ns) or {"runs": []}
    state = jsonio.read_json(paths.state_path(ns)) or new_state(ns)
    out = {"ns": ns, "runner": state.get("runner"), "usage": state.get("usage", {}), "stages": {}}
    by_stage = defaultdict(list)
    for r in manifest.get("runs", []):
        by_stage[r["stage"]].append(r)
    for stage, runs in by_stage.items():
        visible = blinding.is_visible(state, stage)
        cells = {}
        counts = Counter()
        for r in runs:
            s = state.get("runs", {}).get(r["run_id"], {}).get("status", "pending")
            counts[s] += 1
            c = cells.setdefault(r["cell"] + ("|control" if r.get("control") else ""), Counter())
            c["total"] += 1
            c[s] += 1
        stage_out = {"total": len(runs), "counts": dict(counts), "visible": visible,
                     "complete": blinding.stage_complete(manifest, state, stage),
                     "cells": {k: dict(v) for k, v in cells.items()},
                     "infra_failures": sum(state.get("runs", {}).get(r["run_id"], {}).get("infra_failures", 0)
                                           for r in runs)}
        if visible:
            recs = _records(ns, [r["run_id"] for r in runs if state.get("runs", {}).get(r["run_id"], {}).get("status") == "done"])
            oc = defaultdict(Counter)
            for rec in recs.values():
                oc[rec["cell"]][rec["outcome"]] += 1
            stage_out["outcomes"] = {k: dict(v) for k, v in oc.items()}
        else:
            stage_out["outcomes"] = "Blinded until stage complete"
        out["stages"][stage] = stage_out
    return out


def print_status(s: dict) -> None:
    r = s.get("runner") or {}
    print(f"namespace {s['ns']}  runner {r.get('status')}  pid {r.get('pid')}  stage {r.get('stage')}")
    for stage in STAGES:
        st = s["stages"].get(stage)
        if not st:
            continue
        c = st["counts"]
        print(f"\n{stage}: {c.get('done', 0)}/{st['total']} done, {c.get('pending', 0)} pending, "
              f"{c.get('infra_failure', 0)} infra (retrying), {c.get('infra_failure_final', 0)} infra final"
              f"{'  [visible]' if st['visible'] else '  [blinded]'}")
        for cell, cc in sorted(st["cells"].items()):
            print(f"  {cell:<44} {cc.get('done', 0)}/{cc['total']}")
        if st["visible"] and st["outcomes"]:
            for cell, oc in sorted(st["outcomes"].items()):
                print(f"  outcomes {cell}: " + ", ".join(f"{k} {v}" for k, v in sorted(oc.items())))
        u = s["usage"].get(stage)
        if u:
            print(f"  usage: {u['runs']} runs, in {u['input_tokens']:,} / out {u['output_tokens']:,} / cache read "
                  f"{u['cache_read_tokens']:,} tokens, {u['minutes']:.1f} min")


def projection(ns: str) -> dict:
    manifest = jsonio.read_json(paths.manifest_path(ns)) or {"runs": []}
    p0 = [r["run_id"] for r in manifest["runs"] if r["stage"] == "P0"]
    recs = [r for r in _records(ns, p0).values() if r["outcome"] != "infra_failure"]
    if not recs:
        return {"runs": 0}
    keys = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens")
    avg = {k: sum(r["totals"].get(k, 0) for r in recs) / len(recs) for k in keys}
    mx = {k: max(r["totals"].get(k, 0) for r in recs) for k in keys}
    minutes = [r["duration_ms"] / 60000 for r in recs]
    turns = [r["totals"]["turns"] for r in recs]
    proj = {}
    for stage in ("P1", "P2", "P4", "P5"):
        n = sum(1 for r in manifest_mod.generate(ns=ns)["runs"] if r["stage"] == stage)
        proj[stage] = {"runs": n, **{k: round(avg[k] * n) for k in keys},
                       "minutes_1_worker": round(sum(minutes) / len(minutes) * n, 1)}
    return {"runs": len(recs), "avg": {k: round(v) for k, v in avg.items()}, "max": mx,
            "avg_minutes": round(sum(minutes) / len(minutes), 2), "max_minutes": round(max(minutes), 2),
            "avg_turns": round(sum(turns) / len(turns), 1), "max_turns": max(turns), "projection": proj,
            "P3": "≈190 tool-less reviewer calls (not calibrated by P0)",
            "note": "Tokens cannot be translated into a share of the Max plan quota (not published); Alfredo decides."}


def print_projection(p: dict) -> None:
    if not p.get("runs"):
        print("no finished P0 runs yet")
        return
    print(f"P0: {p['runs']} runs; per run avg tokens {p['avg']} (max {p['max']}); avg {p['avg_minutes']} min "
          f"(max {p['max_minutes']}); avg turns {p['avg_turns']} (max {p['max_turns']})")
    for stage, v in p["projection"].items():
        print(f"  {stage}: {v['runs']} runs -> in {v['input_tokens']:,} out {v['output_tokens']:,} cache read "
              f"{v['cache_read_tokens']:,} cache write {v['cache_creation_tokens']:,} tokens; "
              f"~{v['minutes_1_worker']} min with 1 worker")
    print(f"  P3: {p['P3']}\n  {p['note']}")


# ---------------------------------------------------------------- CLI --------------------------------------------

def main(argv=None, *, pipeline=None, mock_scripts: dict | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m harness.runner")
    ap.add_argument("--stage", choices=STAGES)
    ap.add_argument("--batch", type=int)
    ap.add_argument("--max-runs", type=int)
    ap.add_argument("--max-minutes", type=float)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--unit")
    ap.add_argument("--part", choices=manifest_mod.P6_PARTS, help="with --stage P6: only that part's runs")
    ap.add_argument("--ns", choices=["real", "mock"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--calibrate", action="store_true")
    ap.add_argument("--unblind", metavar="STAGE")
    ap.add_argument("--force-unblind", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    ns = a.ns or ("mock" if a.unit == "mock" else "real")
    # 3 by default; up to 6 since P9 (2026-10-18, Alfredo, Google AI Ultra): only if every worker folder is ready
    if not 1 <= a.workers <= 6:
        print("--workers must be 1..6 (parallel runs don't add quota; they spend it faster)", file=sys.stderr)
        return EXIT_GUARD
    if a.workers > 3 and not a.status and not a.unblind and not a.dry_run:
        from harness import doctor
        missing = [k for k in range(1, a.workers + 1) if not doctor.worker_ready(ns, k)]
        if missing:
            print(f"--workers {a.workers}: worker folders not ready: {missing} (python -m harness.doctor)",
                  file=sys.stderr)
            return EXIT_GUARD

    if a.status:
        s = status(ns)
        print(json.dumps(s, indent=2)) if a.json else print_status(s)
        return EXIT_OK

    manifest = manifest_mod.ensure(ns)
    if manifest is None:
        print(f"no manifest for namespace {ns}: run `python -m harness.manifest --seed 20261011` first",
              file=sys.stderr)
        return EXIT_GUARD
    st = State(ns, load_state(ns, manifest))

    if a.unblind:
        try:
            blinding.unblind(st.data, manifest, a.unblind, force=a.force_unblind, by=getpass.getuser())
        except ValueError as e:
            print(str(e), file=sys.stderr)
            return EXIT_GUARD
        st.save()
        print_status(status(ns)) if not a.json else print(json.dumps(status(ns)["stages"].get(a.unblind), indent=2))
        return EXIT_OK

    stage = "P0" if a.calibrate else a.stage
    if not stage:
        ap.error("--stage (or --calibrate, --status, --unblind) is required")
    runs = [r for r in manifest["runs"] if r["stage"] == stage]
    if a.part:
        if stage != "P6":
            print("--part applies only to --stage P6 (the P1, P2 or P4 part of the Codex replication)", file=sys.stderr)
            return EXIT_GUARD
        runs = [r for r in runs if r.get("part") == a.part]
    if ns == "real" and a.unit:                          # one unit, or several separated by commas (mixed rounds)
        wanted = {u.strip() for u in a.unit.split(",") if u.strip()}
        runs = [r for r in runs if r["unit"] in wanted]
    elif ns == "real" and stage in MULTI_UNIT and len({r["unit"] for r in runs}) > 1:
        print(f"{stage} has runs for several units ({', '.join(sorted({r['unit'] for r in runs}))}); pass --unit "
              "(one unit, or several separated by commas to mix them in the same rounds)", file=sys.stderr)
        return EXIT_GUARD
    todo = [r for r in runs if st.run(r["run_id"]).get("status", "pending") in ("pending", "infra_failure")]
    limit = min(x for x in (a.batch, a.max_runs) if x is not None) if (a.batch or a.max_runs) else None

    if a.dry_run:
        shown = todo[:limit] if limit else todo
        for r in shown:
            print(f"{r['run_id']}  {r['unit']:<10} {r['ticket']:<9} {r['visibility']}·{r['spec']}·{r['wording']}"
                  f"{'  p=' + r['paraphrase'] if r.get('paraphrase') else ''}{'  control' if r.get('control') else ''}")
        print(f"{len(shown)} run(s) would run ({len(todo)} pending in {stage}, namespace {ns})")
        return EXIT_OK

    errs = guard_errors(ns, stage, {r["unit"] for r in todo})
    if errs:
        for e in errs:
            print("refused:", e, file=sys.stderr)
        return EXIT_GUARD
    if not todo:
        print(f"nothing pending in {stage} ({ns})")
        if a.calibrate:
            p = projection(ns)
            print(json.dumps(p, indent=2)) if a.json else print_projection(p)
        return EXIT_OK
    if ns == "mock":
        from harness import cycle
        missing = cycle.wp1_missing()
        if missing and pipeline is None:
            print("refused: WP1 pieces missing: " + ", ".join(missing), file=sys.stderr)
            return EXIT_GUARD
    busy = other_runner(ns)
    if busy:
        print(f"refused: another runner is alive in namespace {ns} (pid {busy}); one runner at a time "
              "(stop it with the control file or wait)", file=sys.stderr)
        return EXIT_GUARD
    lock = paths.runner_lock_path(ns)
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text(str(os.getpid()), encoding="utf-8")
    batch = Batch(ns, stage, todo, st, manifest, workers=a.workers, max_runs=limit, max_minutes=a.max_minutes,
                  unit_label=a.unit or ("mock" if ns == "mock" else None), pipeline=pipeline,
                  mock_scripts=mock_scripts, quiet=a.quiet)
    try:
        code = batch.run()
    finally:
        try:
            if lock.read_text(encoding="utf-8").strip() == str(os.getpid()):
                lock.unlink()
        except OSError:
            pass
    if stage in manifest_mod.PILOTS:
        try:
            from analysis import pilot_x1
            pilot_x1.write(ns, stage)
            if not a.quiet:
                print(f"pilot summary: {paths.ns_dir(ns) / pilot_x1.summary_name(stage)}", flush=True)
        except Exception as e:  # noqa: BLE001 - a summary problem never changes the batch's exit code
            print(f"pilot summary not written: {type(e).__name__}: {e}", file=sys.stderr)
    if a.calibrate and code == EXIT_OK:
        p = projection(ns)
        print(json.dumps(p, indent=2)) if a.json else print_projection(p)
    return code


if __name__ == "__main__":
    sys.exit(main())
