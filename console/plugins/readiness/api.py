"""Readiness plugin API (spec §22.8): doctor, smoke, lock, freeze, units, token, checklist.

Owner writes; operator reads (readonly_roles). Missing harness modules degrade to {"available": false}, never 500.
The smoke test and the freeze are only ever *spawned* here, after a typed confirmation; nothing runs them implicitly.
"""
from __future__ import annotations

import json
import re
import subprocess
import threading
from pathlib import Path

from console.core import experiment, runner_ctl
from console.core.plugin_api import ApiError
from harness import paths
from harness.jsonio import read_json, write_json_atomic

EFFORTS = [None, "low", "medium", "high", "xhigh", "max"]
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\-\[\]/]{0,99}$")
SMOKE_CONFIRM = "RUN SMOKE"
FREEZE_CONFIRM = "FREEZE"


def module_available(name: str) -> bool:
    """True when harness/<name>.py exists (other packages are built in parallel)."""
    return (paths.REPO / "harness" / f"{name}.py").exists()


def register(router, ctx):
    state_dir = Path(ctx.data_dir) / "readiness"
    doctor_lock = threading.Lock()

    def run_json(argv: list[str], timeout: int) -> tuple[dict | None, str | None]:
        try:
            p = subprocess.run(argv, cwd=str(ctx.repo), capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as e:
            return None, f"{type(e).__name__}: {e}"
        try:
            return json.loads(p.stdout), None
        except ValueError:
            tail = (p.stdout + p.stderr).strip().splitlines()[-5:]
            return None, f"exit {p.returncode}: " + " | ".join(tail)

    def spawned(name: str) -> dict | None:
        rec = read_json(state_dir / f"{name}.json", default=None)
        if isinstance(rec, dict):
            rec["running"] = runner_ctl.pid_alive(rec.get("pid"))
            return rec
        return None

    def spawn(name: str, module: str, args: list[str], req) -> dict:
        pid = ctx.spawn(ctx.module_argv(module, *args), f"{name}-{experiment.utc_now()[:19].replace(':', '')}")
        rec = {"pid": pid, "at": experiment.utc_now(), "by": req.user["username"], "argv": [module, *args]}
        write_json_atomic(state_dir / f"{name}.json", rec)
        return rec

    def body(req) -> dict:
        b = req.json
        if b is None:
            return {}
        if not isinstance(b, dict):
            raise ApiError(400, "Request body must be a JSON object")
        return b

    # ------------------------------------------------------------ health
    def doctor(req):
        if not module_available("doctor"):
            return {"available": False}
        cache = state_dir / "doctor.json"
        cached = read_json(cache, default=None)
        if cached and req.query.get("refresh") not in ("1", "true"):
            return dict(cached, available=True, cached=True)
        with doctor_lock:
            data, err = run_json(ctx.module_argv("harness.doctor", "--json"), timeout=180)
            out = {"available": True, "at": experiment.utc_now(), "result": data, "error": err, "cached": False}
            write_json_atomic(cache, {k: v for k, v in out.items() if k not in ("available", "cached")})
        return out

    # ------------------------------------------------------------ smoke
    def smoke(req):
        s = experiment.smoke_status()
        s["run"] = spawned("smoke-run")
        s["confirm_text"] = SMOKE_CONFIRM
        s["can_run"] = ctx.can_write(req) and req.user["role"] == "owner"
        return s

    def smoke_run(req):
        b = body(req)
        if b.get("confirm") != SMOKE_CONFIRM:
            raise ApiError(400, f"Type {SMOKE_CONFIRM} to confirm")
        if not module_available("smoke"):
            raise ApiError(409, "harness.smoke is not available yet")
        run = spawned("smoke-run")
        if run and run["running"]:
            raise ApiError(409, "The smoke test is already running")
        rec = spawn("smoke-run", "harness.smoke", ["--i-am-authorized"], req)
        ctx.audit("smoke.run", {"pid": rec["pid"]}, req.user)
        return {"ok": True, "run": rec}

    # ------------------------------------------------------------ pre-registration
    def freeze_blockers(pre: dict) -> list[str]:
        out = []
        if pre["frozen"]:
            out.append("Already frozen")
        if not module_available("prereg"):
            out.append("harness.prereg is not available yet")
        if not experiment.p0_complete():
            out.append("P0 calibration is not complete (real namespace)")
        run = spawned("freeze-run")
        if run and run["running"]:
            out.append("A freeze is already running")
        return out

    def lock(req):
        pre = experiment.prereg_status()
        verify = None
        if pre["frozen"] and module_available("prereg"):
            data, err = run_json(ctx.module_argv("harness.prereg", "--verify", "--json"), timeout=120)
            verify = {"result": data, "error": err}
        chk = experiment.checklist_items(ctx.data_dir)
        blockers = freeze_blockers(pre)
        return {
            **pre, "verify": verify, "prereg_available": module_available("prereg"),
            "p0_complete": experiment.p0_complete(), "freeze_blockers": blockers,
            "can_freeze": not blockers and ctx.can_write(req) and req.user["role"] == "owner",
            "confirm_text": FREEZE_CONFIRM, "freeze_run": spawned("freeze-run"),
            "checklist": {"exists": chk["exists"], "done": chk["done"], "total": chk["total"]},
            "changed": [f for f in pre["files"] if f["status"] != "same"],
        }

    def freeze(req):
        b = body(req)
        if b.get("confirm") != FREEZE_CONFIRM:
            raise ApiError(400, f"Type {FREEZE_CONFIRM} to confirm")
        blockers = freeze_blockers(experiment.prereg_status())
        if blockers:
            raise ApiError(409, "; ".join(blockers))
        rec = spawn("freeze-run", "harness.prereg", ["--freeze"], req)
        ctx.audit("prereg.freeze", {"pid": rec["pid"]}, req.user)
        return {"ok": True, "run": rec}

    # ------------------------------------------------------------ units.json
    def units(req):
        data = read_json(paths.UNITS, default=None)
        if not isinstance(data, dict):
            return {"available": False, "units": {}, "locked": False}
        frozen = paths.PREREG_LOCK.exists()
        return {"available": True, "units": data, "locked": frozen,
                "locked_reason": "Locked by the pre-registration freeze" if frozen else None,
                "efforts": EFFORTS, "editable": ctx.can_write(req) and req.user["role"] == "owner" and not frozen}

    def units_save(req):
        if paths.PREREG_LOCK.exists():
            raise ApiError(409, "units.json is locked by the pre-registration freeze")
        b = body(req)
        changes = b.get("units")
        if not isinstance(changes, dict) or not changes:
            raise ApiError(400, "Send {\"units\": {\"<unit>\": {\"model\": ..., \"effort\": ...}}}")
        data = read_json(paths.UNITS, default=None)
        if not isinstance(data, dict):
            raise ApiError(409, "harness/units.json is missing")
        before = json.loads(json.dumps(data))
        diff = {}
        for name, ch in changes.items():
            if name not in data:
                raise ApiError(400, f"Unknown unit {name}")
            if not isinstance(ch, dict) or set(ch) - {"model", "effort"}:
                raise ApiError(400, f"Only model and effort can be edited ({name})")
            if data[name].get("adapter") == "mock":
                raise ApiError(400, "The mock unit has no model or effort")
            if "model" in ch:
                m = ch["model"]
                if m in ("", None):
                    m = None
                elif not isinstance(m, str) or not MODEL_RE.match(m):
                    raise ApiError(400, f"Invalid model id for {name}")
                if data[name].get("model") != m:
                    diff.setdefault(name, {})["model"] = [data[name].get("model"), m]
                data[name]["model"] = m
            if "effort" in ch:
                e = ch["effort"] or None
                if e not in EFFORTS:
                    raise ApiError(400, f"Effort must be one of {', '.join(x for x in EFFORTS if x)} or empty")
                if data[name].get("effort") != e:
                    diff.setdefault(name, {})["effort"] = [data[name].get("effort"), e]
                data[name]["effort"] = e
        if not diff:
            return {"ok": True, "changed": {}, "units": data}
        _write_units(data)
        ctx.audit("units.update", {"changes": diff}, req.user)
        return {"ok": True, "changed": diff, "units": data, "before": before}

    def _write_units(data: dict) -> None:
        # Keep the one-line-per-unit layout of the original file.
        width = max(len(k) for k in data) + 3
        lines = []
        for i, (k, v) in enumerate(data.items()):
            key = (json.dumps(k) + ":").ljust(width)
            lines.append(f"  {key}{json.dumps(v, ensure_ascii=False)}" + ("," if i < len(data) - 1 else ""))
        text = "{\n" + "\n".join(lines) + "\n}\n"
        tmp = paths.UNITS.with_suffix(".json.tmp")
        tmp.write_text(text, encoding="utf-8", newline="\n")
        tmp.replace(paths.UNITS)

    # ------------------------------------------------------------ token
    def token(req):
        env = paths.env_file()
        exists = env.exists()
        has = False
        if exists:
            try:
                has = any(l.strip().startswith("CLAUDE_CODE_OAUTH_TOKEN=") and len(l.strip()) > 24
                          for l in env.read_text(encoding="utf-8", errors="replace").splitlines())
            except OSError:
                has = False
        return {"env_path": str(env), "exists": exists, "has_token": has,
                "instructions": [
                    "In a terminal, run: claude setup-token",
                    "Sign in with the Max-plan account when the browser opens.",
                    f"Put the token on one line of {env}:  CLAUDE_CODE_OAUTH_TOKEN=<token>",
                    "Never commit or paste it anywhere else; the console only checks that the line exists.",
                ]}

    # ------------------------------------------------------------ checklist
    def checklist(req):
        out = experiment.checklist_items(ctx.data_dir)
        out["path"] = "docs/REVIEW-CHECKLIST.md"
        out["editable"] = ctx.can_write(req) and req.user["role"] == "owner"
        return out

    def checklist_mark(req):
        b = body(req)
        iid, checked = b.get("id"), b.get("checked")
        if not isinstance(iid, str) or not isinstance(checked, bool):
            raise ApiError(400, "Send {\"id\": \"…\", \"checked\": true|false}")
        cur = experiment.checklist_items(ctx.data_dir)
        item = next((i for i in cur["items"] if i["id"] == iid), None)
        if not item:
            raise ApiError(404, "No such checklist item (the file may have changed; reload)")
        f = Path(ctx.data_dir) / "checklist.json"
        data = read_json(f, default=None) or {"schema": "checklist/1", "items": {}}
        data.setdefault("items", {})[iid] = {"checked": checked, "by": req.user["username"],
                                             "at": experiment.utc_now(), "text": item["text"]}
        write_json_atomic(f, data)
        ctx.audit("checklist.mark", {"id": iid, "text": item["text"], "checked": checked}, req.user)
        return experiment.checklist_items(ctx.data_dir)

    owner = ["owner"]
    router.get("/doctor", doctor)
    router.get("/smoke", smoke)
    router.post("/smoke", smoke_run, roles=owner)
    router.get("/lock", lock)
    router.post("/freeze", freeze, roles=owner)
    router.get("/units", units)
    router.post("/units", units_save, roles=owner)
    router.get("/token", token)
    router.get("/checklist", checklist)
    router.post("/checklist", checklist_mark, roles=owner)
