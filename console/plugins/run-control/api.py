"""Run Control plugin API (spec §22.2; contract console-api.md).

    GET  /api/run-control/stages      stage cards P0-P6: cells k/N, status, blinding, tokens, minutes, guards
    GET  /api/run-control/status      runner + live view: workers, next 5 queued, finished, usage limit, sleep notice
    POST /api/run-control/dry-run     what a batch would run (never launches anything)
    POST /api/run-control/start       launch `python -m harness.runner ...` as a detached process (preview: true = plan only)
    POST /api/run-control/stop        stop after the current run(s)
    POST /api/run-control/workers     workers 1..3 for the next batch (a console preference)
    POST /api/run-control/resume-at   schedule a resume (runner_ctl.schedule_resume) / preview / cancel
    POST /api/run-control/unblind     owner: unblind a complete stage (Overview points here)

The plugin is visible to owner and operator only (plugin.json `roles`): a viewer or presenter gets 403 on every
method, GET included (`console --check` step 8). Guards are enforced here, not only in the UI. Nothing in this module
calls a model; the only process it starts is `harness.runner`, through `ctx.runner.launch_runner`.

Outcomes: stage cards and the finished list carry an outcome only when `harness.blinding.is_visible` says the stage
is visible; a blinded stage shows counts of runs and nothing else.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from console.core import experiment, runner_ctl
from console.core.plugin_api import ApiError
from harness import blinding, paths
from harness.jsonio import read_json, write_json_atomic

# argparse `choices` of harness/runner.py --stage (P3 is the reviewer study, run by harness.reviewer).
RUNNABLE = ("P0", "X1", "P1", "P2", "P4", "P5", "P6")
EXPLORATORY = ("P0", "X1")   # no pre-registration lock needed (calibration, pilot); same as harness.runner
STAGE_NOTE = {"P3": "Reviewer calls (RQ4) run from the reviewer study, not from a batch."}
WORKERS_NOTICE = "Parallel runs don't add quota; they spend it faster"
MAX_BATCH = 1000
MAX_MINUTES = 24 * 60
FINISHED_LIMIT = 20
QUEUE_LIMIT = 5
HEARTBEAT_STALE_S = 30
LOG_FIRST = 48_000      # bytes of the runner log shown when the panel opens
LOG_MAX = 256_000       # most bytes returned by one /log call
WRITE_ROLES = ["owner", "operator"]
HHMM = re.compile(r"^(\d{1,2}):(\d{2})$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def _parse_ts(s):
    try:
        return runner_ctl.parse_iso(s)
    except (ValueError, TypeError):
        return None


def register(router, ctx):
    settings_path = ctx.data_dir / "run-control" / "settings.json"

    # ------------------------------------------------------------ settings (workers per namespace)
    def get_settings(ns: str) -> dict:
        data = read_json(settings_path, default=None) or {}
        s = data.get(ns) or {}
        w = s.get("workers")
        return {"workers": w if isinstance(w, int) and 1 <= w <= 3 else 1}

    def put_settings(ns: str, **kw) -> dict:
        data = read_json(settings_path, default=None) or {}
        cur = data.get(ns) or {}
        cur.update(kw)
        data[ns] = cur
        write_json_atomic(settings_path, data)
        return get_settings(ns)

    # ------------------------------------------------------------ guards (spec §22.2)
    def guard_reasons(ns: str, stage: str, *, strict: bool = False, units=None) -> list[dict]:
        """Why a real batch of `stage` must not start. MOCK has no guards. strict also re-verifies the lock hashes.
        units: the units that would run (Claude Code units need results/smoke.json, codex results/smoke-codex.json)."""
        if ns == "mock":
            return []
        out = []
        from harness.runner import smoke_files
        for name in smoke_files(set(units or ())):
            smoke = read_json(paths.results_root() / name, default=None)
            if not (isinstance(smoke, dict) and smoke.get("ok")):
                out.append({"code": "smoke", "message": f"Live smoke test not approved (results/{name})"})
        if stage not in EXPLORATORY:
            try:
                from harness import prereg
                lock = prereg.lock_info()
            except Exception:  # noqa: BLE001 - unreadable lock counts as missing
                lock = None
            if not lock:
                out.append({"code": "prereg", "message": "Pre-registration lock missing (freeze it in Readiness)"})
            elif strict:
                try:
                    ok, problems = prereg.verify()
                except Exception as e:  # noqa: BLE001
                    ok, problems = False, [f"{type(e).__name__}: {e}"]
                if not ok:
                    out.append({"code": "prereg_mismatch",
                                "message": "Pre-registration lock does not match: " + "; ".join(problems[:3])})
        return out

    # ------------------------------------------------------------ request parsing
    def units_table() -> dict:
        return read_json(paths.UNITS, default=None) or {}

    def parse_int(v, name, lo, hi):
        if isinstance(v, bool) or v is None or (isinstance(v, float) and v != int(v)):
            raise ApiError(400, f"{name} must be a whole number")
        try:
            n = int(v)
        except (TypeError, ValueError):
            raise ApiError(400, f"{name} must be a whole number")
        if not lo <= n <= hi:
            raise ApiError(400, f"{name} must be between {lo} and {hi}")
        return n

    def parse_params(ns: str, body: dict) -> dict:
        body = body if isinstance(body, dict) else {}
        calibrate = bool(body.get("calibrate"))
        stage = "P0" if calibrate else body.get("stage")
        if stage not in RUNNABLE:
            raise ApiError(400, f"stage must be one of {', '.join(RUNNABLE)}")
        batch = body.get("batch")
        minutes = body.get("max_minutes")
        batch = None if batch in (None, "") else parse_int(batch, "batch", 1, MAX_BATCH)
        if minutes in (None, ""):
            minutes = None
        else:
            if isinstance(minutes, bool):
                raise ApiError(400, "max_minutes must be a number")
            try:
                minutes = float(minutes)
            except (TypeError, ValueError):
                raise ApiError(400, "max_minutes must be a number")
            if not 0 < minutes <= MAX_MINUTES:
                raise ApiError(400, f"max_minutes must be between 0 and {MAX_MINUTES}")
            minutes = int(minutes) if minutes == int(minutes) else round(minutes, 1)
        if calibrate:
            batch = minutes = None  # --calibrate runs the whole of P0
        elif batch is None and minutes is None and ns == "real":
            raise ApiError(400, "A real batch needs a limit: a number of runs or a number of minutes")
        w = body.get("workers")
        workers = get_settings(ns)["workers"] if w in (None, "") else parse_int(w, "workers", 1, 3)
        unit = body.get("unit") or None
        if ns == "mock":
            unit = "mock"
        elif unit is not None:
            if not isinstance(unit, str) or unit == "mock" or unit not in units_table():
                raise ApiError(400, f"Unknown or non-real unit {unit!r}")
        args = ["--calibrate"] if calibrate else ["--stage", stage]
        args += ["--ns", ns]
        if unit:
            args += ["--unit", unit]
        args += ["--workers", str(workers)]
        if batch is not None:
            args += ["--batch", str(batch)]
        if minutes is not None:
            args += ["--max-minutes", str(minutes)]
        return {"stage": stage, "calibrate": calibrate, "batch": batch, "max_minutes": minutes, "workers": workers,
                "unit": unit, "args": args}

    # ------------------------------------------------------------ what would run (mirrors harness.runner main())
    def pending_runs(ns: str, stage: str, unit: str | None, manifest: dict, state: dict) -> list[dict]:
        runs = blinding.stage_runs(manifest, stage)
        if ns == "real" and unit:
            runs = [r for r in runs if r.get("unit") == unit]
        st = state.get("runs") or {}
        return [r for r in runs if (st.get(r["run_id"]) or {}).get("status", "pending") in ("pending", "infra_failure")]

    def unit_line(name: str) -> str:
        u = units_table().get(name) or {}
        bits = [u.get("adapter"), u.get("model"), u.get("effort")]
        return f"{name}: " + " · ".join(str(b) for b in bits if b) if any(bits) else name

    def plan(ns: str, params: dict) -> dict:
        manifest, state = experiment.load(ns)
        stage = params["stage"]
        todo = pending_runs(ns, stage, params["unit"], manifest, state) if manifest else []
        limit = params["batch"]
        shown = todo[:limit] if limit else todo
        alive = runner_ctl.runner_alive(ns)
        blocking = list(guard_reasons(ns, stage, strict=True,
                                      units={r["unit"] for r in todo} or ({params["unit"]} if params["unit"] else None)))
        notes = []
        if not manifest:
            if ns == "real":
                blocking.append({"code": "manifest", "message": "No run manifest for the real namespace "
                                 "(python -m harness.manifest --seed 20261011)"})
            else:
                notes.append("The mock manifest does not exist yet; the runner generates it on first use.")
        elif not todo:
            blocking.append({"code": "empty", "message": f"Nothing pending in {stage} ({ns})"})
        elif ns == "real" and not params["unit"] and len({r["unit"] for r in todo}) > 1 and stage == "X1":
            blocking.append({"code": "unit", "message": f"{stage} has runs for several units "
                             f"({', '.join(sorted({r['unit'] for r in todo}))}); pick one unit"})
        if alive:
            blocking.append({"code": "busy", "message": f"A runner is already running for the {ns} namespace"})
        if ns == "mock":
            try:
                from harness import cycle
                missing = cycle.wp1_missing()
                if missing:
                    notes.append("The runner will refuse to start: pipeline pieces missing: " + ", ".join(missing))
            except Exception:  # noqa: BLE001
                pass
        units = sorted({r["unit"] for r in shown})
        command = "python -m harness.runner " + " ".join(params["args"])
        limit_text = (f"up to {params['batch']} runs" if params["batch"] else "") + \
                     (" or " if params["batch"] and params["max_minutes"] else "") + \
                     (f"{params['max_minutes']} minutes" if params["max_minutes"] else "")
        summary = [
            f"Namespace: {ns.upper()}",
            ("Calibration (P0): " if params["calibrate"] else f"Stage {stage} · {experiment.STAGE_NAMES.get(stage, '')}: ")
            + (f"{len(shown)} run(s) of {len(todo)} pending" + (f" ({limit_text})" if limit_text else "")),
            f"Workers: {params['workers']}",
        ]
        if units:
            summary.append("Units: " + "; ".join(unit_line(u) for u in units))
        summary.append("Command: " + command)
        return {
            "ns": ns, "stage": stage, "calibrate": params["calibrate"], "batch": params["batch"],
            "max_minutes": params["max_minutes"], "workers": params["workers"], "unit": params["unit"],
            "args": params["args"], "command": command,
            "count": len(shown), "pending": len(todo),
            "runs": [{k: r.get(k) for k in ("run_id", "unit", "ticket", "visibility", "spec", "wording", "cell",
                                            "paraphrase", "control")} for r in shown[:200]],
            "units": units, "blocking": blocking, "notes": notes, "would_start": not blocking and bool(shown),
            "summary": summary, "workers_notice": WORKERS_NOTICE,
        }

    # ------------------------------------------------------------ GET /stages
    def stage_cards(ns: str) -> list[dict]:
        manifest, state = experiment.load(ns)
        progress = {p["stage"]: p for p in experiment.stage_progress(ns)}
        st_runs = state.get("runs") or {}
        runner = state.get("runner") or {}
        alive = runner_ctl.runner_alive(ns)
        active_stage = runner.get("stage") if alive and runner.get("status") in ("running", "stopping") else None
        cards = []
        for stage in experiment.STAGES:
            p = progress[stage]
            visible = blinding.is_visible(state, stage)
            cells: dict[str, dict] = {}
            outcomes: dict[str, int] = {}
            for r in blinding.stage_runs(manifest, stage):
                key = r["cell"] + ("|control" if r.get("control") else "")
                c = cells.setdefault(key, {
                    "cell": r["cell"], "control": bool(r.get("control")), "ticket": r.get("ticket"),
                    "visibility": r.get("visibility"), "spec": r.get("spec"), "wording": r.get("wording"),
                    "unit": r.get("unit"), "total": 0, "done": 0, "running": 0, "pending": 0, "infra_final": 0,
                    "outcomes": {} if visible else None})
                s = (st_runs.get(r["run_id"]) or {}).get("status", "pending")
                c["total"] += 1
                if s == "done":
                    c["done"] += 1
                    if visible:
                        rec = read_json(paths.run_dir(ns, r["run_id"]) / "record.json", default=None) or {}
                        o = rec.get("outcome")
                        if o:
                            c["outcomes"][o] = c["outcomes"].get(o, 0) + 1
                            outcomes[o] = outcomes.get(o, 0) + 1
                elif s == "running":
                    c["running"] += 1
                elif s == "infra_failure_final":
                    c["infra_final"] += 1
                else:
                    c["pending"] += 1
            if not p["in_manifest"]:
                status = "not_in_manifest"
            elif p["running"] or stage == active_stage:
                status = "running"
            elif p["complete"]:
                status = "complete"
            elif p["done"] > 0:
                status = "in_progress"
            else:
                status = "pending"
            runnable = stage in RUNNABLE
            stage_units = {r.get("unit") for r in blinding.stage_runs(manifest, stage)}
            if len(stage_units) > 1:     # a mixed stage (X1) is launched one unit at a time: the card shows Claude's
                stage_units.discard("codex")
            reasons = guard_reasons(ns, stage, units=stage_units) if runnable else []
            cards.append({
                "stage": stage, "name": p["name"], "runnable": runnable, "note": STAGE_NOTE.get(stage),
                "total": p["total"], "done": p["done"], "completed_ok": p["completed_ok"], "running": p["running"],
                "pending": p["pending"], "infra_final": p["infra_final"], "infra_events": p["infra_events"],
                "complete": p["complete"], "status": status, "blinding": p["blinding"],
                "unblinded_at": p["unblinded_at"], "tokens": p["tokens"], "minutes": p["minutes"],
                "in_manifest": p["in_manifest"], "cells": list(cells.values()),
                "outcomes": outcomes if visible else None,
                "outcomes_note": None if visible else "Blinded until stage complete",
                "guard": {"blocked": bool(reasons), "reasons": reasons},
            })
        return cards

    def get_stages(req):
        ns = req.ns
        units = [u for u in units_table() if (u == "mock") == (ns == "mock")]
        return {"ns": ns, "generated_at": experiment.utc_now(), "stages": stage_cards(ns), "units": units,
                "settings": get_settings(ns), "workers_notice": WORKERS_NOTICE,
                "runner": runner_ctl.status(ns), "can_unblind": bool(req.user and req.user.get("role") == "owner")}

    # ------------------------------------------------------------ GET /status
    def run_row(ns, rid, stage, r, state):
        row = {"run_id": rid, "stage": stage, "status": r.get("status"), "worker": r.get("worker"),
               "started_at": r.get("started_at"), "ended_at": r.get("ended_at"),
               "attempts": r.get("attempts"), "infra_failures": r.get("infra_failures") or 0,
               "last_error": r.get("last_error") if r.get("status") != "done" else None}
        rec = read_json(paths.run_dir(ns, rid) / "record.json", default=None)
        if isinstance(rec, dict):
            t = rec.get("totals") or {}
            row.update(ticket=rec.get("ticket"), cell=rec.get("cell"), turns=t.get("turns"),
                       duration_ms=rec.get("duration_ms"),
                       tokens=(t.get("input_tokens") or 0) + (t.get("output_tokens") or 0))
            if blinding.is_visible(state, stage):
                row["outcome"] = rec.get("outcome")
        return row

    def get_status(req):
        ns = req.ns
        manifest, state = experiment.load(ns)
        base = runner_ctl.status(ns)
        alive = base["alive"]
        runner = state.get("runner") or {}
        stage_by_run = {r["run_id"]: r["stage"] for r in manifest.get("runs", [])}
        st_runs = state.get("runs") or {}
        settings = get_settings(ns)

        # workers: one column each; a dead runner has no live runs, whatever state.json still says
        n_workers = int(runner.get("workers") or settings["workers"]) if alive else settings["workers"]
        wstate = state.get("workers") or {}
        workers = []
        for k in range(1, max(1, min(3, n_workers)) + 1):
            w = wstate.get(str(k)) if alive else None
            workers.append({"worker": k, "run": None if not w else {
                "run_id": w.get("run_id"), "ticket": w.get("ticket"), "cell": w.get("cell"),
                "attempt": w.get("attempt"), "started_at": w.get("started_at"),
                "turns": w.get("turns"), "tokens": w.get("tokens")}})

        # next queued runs of the active batch
        queue = []
        if alive and runner.get("status") in ("running", "stopping") and runner.get("stage"):
            b = runner.get("batch") or {}
            in_flight = sum(1 for w in workers if w["run"])
            remaining = None if b.get("planned") is None else max(0, int(b["planned"]) - int(b.get("done") or 0) - in_flight)
            unit = runner.get("unit") if ns == "real" else None
            pend = pending_runs(ns, runner["stage"], unit, manifest, state)
            running_ids = {w["run"]["run_id"] for w in workers if w["run"]}
            pend = [r for r in pend if r["run_id"] not in running_ids]
            limit = QUEUE_LIMIT if remaining is None else min(QUEUE_LIMIT, remaining)
            queue = [{k: r.get(k) for k in ("run_id", "ticket", "cell", "unit", "visibility", "spec", "wording")}
                     for r in pend[:limit]]

        # finished (newest first); outcome only for visible stages
        fin = [(rid, r) for rid, r in st_runs.items()
               if (r or {}).get("status") in ("done", "infra_failure", "infra_failure_final") and (r or {}).get("ended_at")]
        fin.sort(key=lambda kv: str(kv[1].get("ended_at")), reverse=True)
        finished = [run_row(ns, rid, stage_by_run.get(rid) or experiment.stage_of_run(rid), r, state)
                    for rid, r in fin[:FINISHED_LIMIT]]

        # usage limit
        sched = runner_ctl.scheduled(ns)
        until = runner.get("rate_limited_until")
        limited = (runner.get("status") == "rate_limited") and not alive
        rate_limit = None
        if limited or sched:
            rate_limit = {"limited": limited, "until": until, "scheduled_at": (sched or {}).get("at"),
                          "scheduled_by": (sched or {}).get("by"), "scheduled_args": (sched or {}).get("args")}

        launch = runner_ctl.last_launch(ns)
        launch_out = None
        if launch:
            launch_out = {"pid": launch.get("pid"), "at": launch.get("at"), "by": launch.get("by"),
                          "args": launch.get("args")}
            lt = _parse_ts(launch.get("at"))
            if not alive and lt and (_now() - lt).total_seconds() < 600:
                launch_out["log_tail"] = log_tail(launch.get("log"))
        hb = _parse_ts(runner.get("heartbeat_at"))
        hb_age = None if not hb else max(0, int((_now() - hb).total_seconds()))
        return {
            "ns": ns, "generated_at": experiment.utc_now(), "runner": base, "alive": alive,
            "started_at": runner.get("started_at") if alive else None,
            "stage": runner.get("stage"), "unit": runner.get("unit"), "workers_count": n_workers,
            "batch": runner.get("batch"), "message": runner.get("message"),
            "heartbeat_age_s": hb_age if alive else None,
            "heartbeat_stale": bool(alive and hb_age is not None and hb_age > HEARTBEAT_STALE_S),
            "sleep_prevented": bool(alive and runner.get("sleep_prevented")),
            "workers": workers, "queue": queue, "finished": finished, "rate_limit": rate_limit,
            "launch": launch_out, "settings": settings, "workers_notice": WORKERS_NOTICE,
            "stop_requested": bool(read_json(paths.control_path(ns), default=None)),
        }

    def get_log(req):
        """The spawned runner's stdout/stderr, read incrementally for the Runner output panel.
        ?offset=<bytes already shown>; 0 (or a stale offset) returns the last LOG_FIRST bytes. The core sanitizes it."""
        ns = req.ns
        launch = runner_ctl.last_launch(ns) or {}
        rel = launch.get("log")
        out = {"ns": ns, "log": rel, "alive": runner_ctl.status(ns)["alive"], "launched_at": launch.get("at"),
               "args": launch.get("args"), "size": 0, "offset": 0, "reset": True, "text": ""}
        if not isinstance(rel, str) or ".." in rel or not re.match(r"^logs/[A-Za-z0-9_.-]+\.log$", rel):
            return out
        try:
            offset = max(0, int(req.query.get("offset", "0") or 0))
        except ValueError:
            offset = 0
        try:
            with open(ctx.data_dir / rel, "rb") as f:
                f.seek(0, 2)
                size = f.tell()
                reset = offset == 0 or offset > size
                start = max(0, size - LOG_FIRST) if reset else offset
                start = max(start, size - LOG_MAX)
                f.seek(start)
                data = f.read(size - start)
        except OSError:
            return out
        if reset and start > 0 and b"\n" in data:
            data = data[data.index(b"\n") + 1:]  # start on a whole line
        out.update(size=size, offset=size, reset=reset, text=data.decode("utf-8", "replace"))
        return out

    def log_tail(rel) -> list[str]:
        """Last lines of the spawned runner's stdout/stderr log (the core sanitizes the response)."""
        if not isinstance(rel, str) or ".." in rel or not re.match(r"^logs/[A-Za-z0-9_.-]+\.log$", rel):
            return []
        p = ctx.data_dir / rel
        try:
            with open(p, "rb") as f:
                f.seek(0, 2)
                size = f.tell()
                f.seek(max(0, size - 4000))
                text = f.read().decode("utf-8", "replace")
        except OSError:
            return []
        return [ln for ln in text.splitlines() if ln.strip()][-8:]

    # ------------------------------------------------------------ POST /dry-run
    def post_dry_run(req):
        params = parse_params(req.ns, req.json)
        p = plan(req.ns, params)
        ctx.audit("run_control.dry_run", {"ns": req.ns, "args": params["args"], "count": p["count"]}, req.user)
        return p

    # ------------------------------------------------------------ POST /start
    def require_confirmed(req):
        body = req.json if isinstance(req.json, dict) else {}
        if req.ns == "real" and body.get("confirmed") is not True:
            raise ApiError(400, "Confirmation required: this acts on the real namespace")

    def post_start(req):
        ns = req.ns
        body = req.json if isinstance(req.json, dict) else {}
        params = parse_params(ns, body)
        p = plan(ns, params)
        if body.get("preview"):  # the exact summary shown in the confirmation dialog; launches and audits nothing
            return p
        if p["blocking"]:
            raise ApiError(409, p["blocking"][0]["message"])
        require_confirmed(req)
        try:  # a stop request left behind by a crashed runner would stop the new batch at once
            paths.control_path(ns).unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass
        pid = ctx.runner.launch_runner(ns, params["args"], req.user)
        if body.get("workers") not in (None, ""):
            put_settings(ns, workers=params["workers"])
        ctx.audit("run_control.start", {"ns": ns, "stage": params["stage"], "calibrate": params["calibrate"],
                                        "args": params["args"], "count": p["count"], "pid": pid,
                                        "summary": p["summary"]}, req.user)
        return {"ok": True, "pid": pid, "args": params["args"], "command": p["command"], "summary": p["summary"]}

    # ------------------------------------------------------------ POST /stop
    def post_stop(req):
        ns = req.ns
        if not runner_ctl.runner_alive(ns):
            raise ApiError(409, f"No runner is running for the {ns} namespace")
        require_confirmed(req)
        runner = (experiment.load(ns)[1].get("runner") or {})
        ctl = ctx.runner.request_stop(ns, req.user)
        ctx.audit("run_control.stop", {"ns": ns, "stage": runner.get("stage")}, req.user)
        return {"ok": True, "control": ctl}

    # ------------------------------------------------------------ POST /workers
    def post_workers(req):
        body = req.json if isinstance(req.json, dict) else {}
        n = parse_int(body.get("workers"), "workers", 1, 3)
        before = get_settings(req.ns)["workers"]
        s = put_settings(req.ns, workers=n)
        ctx.audit("run_control.workers", {"ns": req.ns, "from": before, "to": n}, req.user)
        return {"ok": True, "settings": s, "notice": WORKERS_NOTICE,
                "applies": "to the next batch" if runner_ctl.runner_alive(req.ns) else "to the next batch you start"}

    # ------------------------------------------------------------ POST /resume-at
    def resume_time(ns: str, raw, runner: dict) -> datetime:
        if raw in (None, ""):
            until = _parse_ts(runner.get("rate_limited_until"))
            if not until:
                raise ApiError(400, "No usage-limit reset time is known; give a time (HH:MM)")
            return until
        if isinstance(raw, str):
            m = HHMM.match(raw.strip())
            if m:
                h, mi = int(m.group(1)), int(m.group(2))
                if h > 23 or mi > 59:
                    raise ApiError(400, "Time must be HH:MM (24 h)")
                local = _now().astimezone()
                at = local.replace(hour=h, minute=mi, second=0, microsecond=0)
                if at <= local:
                    at += timedelta(days=1)
                return at
        at = _parse_ts(raw) if isinstance(raw, str) else None
        if not at:
            raise ApiError(400, "Time must be HH:MM or an ISO 8601 timestamp")
        return at

    def resume_args(ns: str, state: dict) -> list[str]:
        """The arguments of the batch that was cut, with --batch reduced by what it already finished."""
        runner = state.get("runner") or {}
        launch = runner_ctl.last_launch(ns)
        args = list((launch or {}).get("args") or [])
        if not args:
            if not runner.get("stage"):
                raise ApiError(409, "There is no earlier batch to resume")
            args = ["--stage", runner["stage"], "--ns", ns]
            if runner.get("unit"):
                args += ["--unit", runner["unit"]]
            args += ["--workers", str(runner.get("workers") or 1)]
            b = runner.get("batch") or {}
            if b.get("max_runs"):
                args += ["--batch", str(b["max_runs"])]
            if b.get("max_minutes"):
                args += ["--max-minutes", str(b["max_minutes"])]
        b = runner.get("batch") or {}
        if "--batch" in args and b.get("max_runs") and b.get("done"):
            i = args.index("--batch")
            args[i + 1] = str(max(1, int(b["max_runs"]) - int(b["done"])))
        return args

    def stage_of_args(args: list[str]) -> str:
        if "--calibrate" in args:
            return "P0"
        if "--stage" in args and args.index("--stage") + 1 < len(args):
            return args[args.index("--stage") + 1]
        return "P0"

    def post_resume(req):
        ns = req.ns
        body = req.json if isinstance(req.json, dict) else {}
        if body.get("cancel"):
            had = ctx.runner.cancel_resume(ns, req.user)
            ctx.audit("run_control.resume_cancel", {"ns": ns, "had": bool(had)}, req.user)
            return {"ok": True, "cancelled": bool(had)}
        if runner_ctl.runner_alive(ns):
            raise ApiError(409, f"A runner is running for the {ns} namespace; there is nothing to resume")
        _, state = experiment.load(ns)
        at = resume_time(ns, body.get("at"), state.get("runner") or {})
        args = resume_args(ns, state)
        stage = stage_of_args(args)
        blocking = guard_reasons(ns, stage, strict=True,
                                 units={args[args.index("--unit") + 1]} if "--unit" in args else None)
        local = at.astimezone()
        info = {"ns": ns, "at": _iso(at), "at_local": local.strftime("%H:%M"), "args": args,
                "command": "python -m harness.runner " + " ".join(args), "blocking": blocking,
                "summary": [f"Namespace: {ns.upper()}", f"Launch at {local.strftime('%H:%M')} "
                            f"({local.strftime('%d %b')}): python -m harness.runner " + " ".join(args)]}
        if body.get("preview"):
            return info
        if blocking:
            raise ApiError(409, blocking[0]["message"])
        require_confirmed(req)
        entry = ctx.runner.schedule_resume(ns, info["at"], args, req.user)
        ctx.audit("run_control.resume_at", {"ns": ns, "at": entry["at"], "args": args}, req.user)
        return dict(info, ok=True, scheduled=entry)

    # ------------------------------------------------------------ POST /unblind (owner)
    def post_unblind(req):
        ns = req.ns
        body = req.json if isinstance(req.json, dict) else {}
        stage = body.get("stage")
        if stage not in experiment.STAGES or stage in blinding.ALWAYS_VISIBLE:
            raise ApiError(400, "Pick a stage P1-P6 (P0 and X1 are always visible)")
        if body.get("confirm") != f"UNBLIND {stage}":
            raise ApiError(400, f"Type UNBLIND {stage} to confirm")
        manifest, state = experiment.load(ns)
        if runner_ctl.runner_alive(ns):
            raise ApiError(409, "Stop the runner before unblinding (it owns state.json)")
        if not state:
            raise ApiError(409, "There is no state.json for this namespace yet")
        if (state.get("unblinded") or {}).get(stage):
            raise ApiError(409, f"{stage} is already unblinded")
        if not blinding.stage_complete(manifest, state, stage):
            raise ApiError(409, f"{stage} is not complete; a forced unblind is a command-line decision "
                                f"(python -m harness.runner --unblind {stage} --force-unblind)")
        blinding.unblind(state, manifest, stage, force=False, by=req.user["username"])
        state["updated_at"] = _iso(_now())
        write_json_atomic(paths.state_path(ns), state)
        ctx.audit("run_control.unblind", {"ns": ns, "stage": stage}, req.user)
        return {"ok": True, "stage": stage, "unblinded": state["unblinded"][stage]}

    router.get("/stages", get_stages)
    router.get("/status", get_status)
    router.get("/log", get_log)
    router.post("/dry-run", post_dry_run, roles=WRITE_ROLES)
    router.post("/start", post_start, roles=WRITE_ROLES)
    router.post("/stop", post_stop, roles=WRITE_ROLES)
    router.post("/workers", post_workers, roles=WRITE_ROLES)
    router.post("/resume-at", post_resume, roles=WRITE_ROLES)
    router.post("/unblind", post_unblind, roles=["owner"])
