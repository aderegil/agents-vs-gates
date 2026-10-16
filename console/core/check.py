"""`python -m console --check` (spec §24): headless end-to-end check on temporary data.

1. start the server on a free port (temp data dir, temp AVG_RESULTS_ROOT)
2. /api/setup owner, login, cookie and CSRF verified
3. load every manifest present (9 expected at integration; a missing or invalid one is a FAIL)
4. 8 mock runs: python -m harness.runner --unit mock --stage P1 --batch 8 (SKIP if harness.runner is missing)
5. GET every route each plugin registers (router introspection) → no 5xx
6. export a replay.json and validate it against docs/contracts/replay.schema.json (SKIP if the replay plugin is missing)
7. blinding: the incomplete stage P1 returns no outcomes anywhere
8. roles: a viewer gets 403 on /api/run-control/* (and on owner-only routes)
Prints CHECK OK or CHECK FAILED with the trace.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import traceback
from pathlib import Path

EXPECTED = ["start", "story", "overview", "run-control", "results", "runs", "replay", "teams", "scenario", "readiness", "users"]
OWNER = ("owner", "check-owner-Password-1")
VIEWER = ("viewer1", "check-viewer-Password-1")
USERS_RE = re.compile(r"(?i)[A-Z]:(?:\\\\|\\|/)Users(?:\\\\|\\|/)")


class Report:
    def __init__(self):
        self.lines: list[tuple[str, str, str]] = []
        self.traces: list[str] = []

    def ok(self, name, detail=""):
        self.lines.append(("OK  ", name, detail))
        print(f"OK   {name}{': ' + detail if detail else ''}", flush=True)

    def skip(self, name, reason):
        self.lines.append(("SKIP", name, reason))
        print(f"SKIP {name}: {reason}", flush=True)

    def fail(self, name, detail, trace: str | None = None):
        self.lines.append(("FAIL", name, detail))
        print(f"FAIL {name}: {detail}", flush=True)
        if trace:
            self.traces.append(f"--- {name}\n{trace}")

    @property
    def failed(self) -> bool:
        return any(s == "FAIL" for s, _, _ in self.lines)


def _require(cond, msg):
    if not cond:
        raise AssertionError(msg)


def _walk(obj, path=""):
    """Yield (path, dict) for every dict in a JSON value."""
    if isinstance(obj, dict):
        yield path, obj
        for k, v in obj.items():
            yield from _walk(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _walk(v, f"{path}[{i}]")


def run_check(keep: bool = False) -> int:
    tmp = Path(tempfile.mkdtemp(prefix="avg-console-check-"))
    data_dir, results = tmp / "data", tmp / "results"
    results.mkdir(parents=True)
    os.environ["AVG_RESULTS_ROOT"] = str(results)  # before anything resolves a results path
    rep = Report()
    print(f"console --check · temp {tmp}", flush=True)
    app = None
    try:
        from console.core.client import Client
        from console.core.server import App
        from harness import paths

        # 1 ------------------------------------------------------------ server
        try:
            app = App(data_dir)
            port = app.start(0)
            owner = Client(port)
            r = owner.get("/api/health")
            _require(r.status == 200 and r.json.get("ok"), f"/api/health → {r.status}")
            rep.ok("server", f"127.0.0.1:{port}")
        except Exception as e:  # noqa: BLE001
            rep.fail("server", str(e), traceback.format_exc())
            raise _Abort()

        # 2 ------------------------------------------------------------ setup, login, cookie, CSRF
        try:
            s = owner.session()
            _require(s.get("setup_required") is True, "setup_required should be true on an empty data dir")
            r = owner.post("/api/setup", {"username": OWNER[0], "password": OWNER[1]}, csrf=False)
            _require(r.status == 403, f"setup without CSRF → {r.status}, expected 403")
            r = owner.setup(*OWNER)
            _require(r.status == 201, f"setup → {r.status} {r.text[:200]}")
            cookie = next((c for c in r.headers_all("Set-Cookie") if c.startswith("avg_session=")), "")
            for attr in ("HttpOnly", "SameSite=Strict", "Max-Age=43200", "Path=/"):
                _require(attr in cookie, f"session cookie lacks {attr}: {cookie}")
            r = Client(port).setup("second", "another-Password-1")
            _require(r.status == 409, f"second setup → {r.status}, expected 409")
            r = owner.post("/api/logout")
            _require(r.status == 200, f"logout → {r.status}")
            r = owner.login(OWNER[0], "wrong-password-123")
            _require(r.status == 401, f"wrong password → {r.status}")
            r = owner.login(*OWNER)
            _require(r.status == 200, f"login → {r.status}")
            r = owner.post("/api/session/ns", {"ns": "mock"}, csrf=False)
            _require(r.status == 403, f"POST without CSRF → {r.status}, expected 403")
            r = owner.post("/api/session/ns", {"ns": "mock"})
            _require(r.status == 200, f"POST with CSRF → {r.status}")
            r = owner.post("/api/session/ns", {"ns": "mock"}, headers={"X-CSRF-Token": "forged"}, csrf=False)
            _require(r.status == 403, f"POST with a forged CSRF token → {r.status}")
            rep.ok("setup + login", "owner created; cookie HttpOnly/SameSite=Strict/12 h; CSRF enforced")
        except Exception as e:  # noqa: BLE001
            rep.fail("setup + login", str(e), traceback.format_exc())
            raise _Abort()

        # 3 ------------------------------------------------------------ manifests
        health = owner.get("/api/health").json or {}
        ids = [p["id"] for p in (owner.get("/api/plugins").json or {}).get("plugins", [])]
        invalid = health.get("invalid_plugins") or []
        api_errors = health.get("api_errors") or {}
        if invalid or api_errors:
            rep.fail("plugins", f"invalid manifests: {invalid}; API load errors: {api_errors}")
        else:
            rep.ok("plugins", f"{len(ids)} of {len(EXPECTED)} loaded: {', '.join(ids)}")
        for pid in EXPECTED:
            if pid not in ids:
                rep.fail(f"plugin {pid}", "plugin folder missing")

        # 4 ------------------------------------------------------------ 8 mock runs
        mock_ok = False
        if not (paths.REPO / "harness" / "runner.py").exists():
            rep.skip("mock runs", "harness.runner not present yet")
        else:
            argv = [app.python, "-X", "utf8", "-m", "harness.runner", "--unit", "mock", "--stage", "P1", "--batch", "8"]
            t0 = time.time()
            try:
                p = subprocess.run(argv, cwd=str(paths.REPO), capture_output=True, text=True, encoding="utf-8",
                                   errors="replace", timeout=1800, env=dict(os.environ))
                st = json.loads((results / "mock" / "state.json").read_text(encoding="utf-8")) \
                    if (results / "mock" / "state.json").exists() else {}
                done = [k for k, v in (st.get("runs") or {}).items() if k.startswith("p1-") and v.get("status") in ("done", "infra_failure_final")]
                out = (p.stdout + "\n" + p.stderr).strip()
                if p.returncode == 0 and len(done) >= 8:
                    mock_ok = True
                    rep.ok("mock runs", f"{len(done)} P1 runs in {time.time() - t0:.0f} s (workers under AVG_ROOT)")
                else:
                    rep.fail("mock runs", f"exit {p.returncode}, {len(done)} terminal P1 runs",
                             (p.stdout[-3000:] + "\n" + p.stderr[-3000:]).strip())
            except Exception as e:  # noqa: BLE001
                rep.fail("mock runs", str(e), traceback.format_exc())

        run_ids = sorted(d.name for d in (results / "mock" / "runs").iterdir()) if (results / "mock" / "runs").is_dir() else []
        p1_ids = [x for x in run_ids if x.startswith("p1-")]
        some_run = (p1_ids or run_ids or ["p1-0001"])[0]

        # 5 ------------------------------------------------------------ every GET route
        bodies: list[tuple[str, object]] = []
        texts: list[tuple[str, str]] = []
        fills = {"model": "cc-sonnet", "unit": "cc-sonnet", "ticket": "X-rename", "stage": "P1", "repo": "orders-service",
                 "rq": "rq1", "name": "orders-service", "username": OWNER[0], "user": OWNER[0], "file": "README.md"}

        def fill(pattern: str) -> str:
            def sub(m):
                n = m.group(1).lower()
                if "run" in n or n in ("id",):
                    return some_run
                return fills.get(n, "x")
            return re.sub(r"\{([A-Za-z_][A-Za-z0-9_]*)(?::path)?\}", sub, pattern)

        targets = ["/api/session", "/api/plugins", "/api/health", "/api/status", "/api/audit", "/api/audit?format=csv"]
        for p in app.plugins:
            for route in p.router.routes:
                if route.method == "GET":
                    targets.append(f"/api/{p.id}{fill(route.pattern) if route.pattern else ''}")
        bad = []
        for t in targets:
            url = t + ("&" if "?" in t else "?") + "ns=mock"
            try:
                r = owner.get(url)
            except Exception as e:  # noqa: BLE001
                bad.append(f"{t}: {e}")
                continue
            if r.status >= 500:
                bad.append(f"{t} → {r.status} {r.text[:200]}")
            texts.append((t, r.text))
            if r.json is not None:
                bodies.append((t, r.json))
        if bad:
            rep.fail("routes", f"{len(bad)} of {len(targets)} GET routes failed", "\n".join(bad))
        else:
            rep.ok("routes", f"{len(targets)} GET routes, none 5xx")

        leaks = [t for t, body in texts if USERS_RE.search(body)]
        if leaks:
            rep.fail("sanitization", f"C:\\Users\\<name> found in {leaks}")
        else:
            rep.ok("sanitization", "no response contains C:\\Users\\<name>")

        # 6 ------------------------------------------------------------ replay.json
        if "replay" not in ids:
            rep.skip("replay.json", "replay plugin not present yet")
        elif not run_ids:
            rep.skip("replay.json", "no mock runs to replay")
        else:
            try:
                import jsonschema
                lst = owner.get("/api/replay/list?ns=mock")
                _require(lst.status == 200, f"/api/replay/list → {lst.status}")
                items = lst.json if isinstance(lst.json, list) else (lst.json or {}).get("runs", [])
                items = [i for i in items if isinstance(i, dict) and i.get("run_id")]
                _require(items, "the replay list is empty")
                schema = json.loads((paths.CONTRACTS / "replay.schema.json").read_text(encoding="utf-8"))
                visible = [i["run_id"] for i in items if not i.get("blinded")]
                blinded = [i["run_id"] for i in items if i.get("blinded")]
                note = ""
                if blinded:
                    # A blinded stage's replay must be refused by the API (CI/oracle states are outcomes).
                    r = owner.get(f"/api/replay/run/{blinded[0]}?ns=mock")
                    _require(r.status == 403, f"/api/replay/run/{blinded[0]} (blinded) → {r.status}, expected 403")
                    note = f"; blinded {blinded[0]} refused with 403"
                if visible:
                    rid = visible[0]
                    r = owner.get(f"/api/replay/run/{rid}?ns=mock")
                    _require(r.status == 200, f"/api/replay/run/{rid} → {r.status} {r.text[:200]}")
                    jsonschema.validate(r.json, schema)
                else:
                    # Every mock run is still blinded: export directly with the same exporter the API uses.
                    from harness.jsonio import read_jsonl
                    from replay.export import build_replay
                    rid = blinded[0]
                    jsonschema.validate(build_replay(read_jsonl(results / "mock" / "runs" / rid / "events.jsonl")), schema)
                    note = " (exported with replay.export.build_replay)" + note
                rep.ok("replay.json", f"{rid} valid against replay.schema.json{note}")
            except Exception as e:  # noqa: BLE001
                rep.fail("replay.json", str(e), traceback.format_exc())

        # 7 ------------------------------------------------------------ blinding
        if not mock_ok:
            rep.skip("blinding", "needs the mock runs of step 4")
        else:
            st = json.loads((results / "mock" / "state.json").read_text(encoding="utf-8"))
            if (st.get("unblinded") or {}).get("P1"):
                rep.fail("blinding", "P1 is unblinded in a fresh temp namespace")
            else:
                hidden = {"outcome", "ticket_done", "ticket_done_gen", "ticket_check", "ticket_check_gen", "metrics", "oracle",
                          "final_message"}
                leaks = []
                for t, body in bodies:
                    for where, d in _walk(body):
                        rid = d.get("run_id") or d.get("id")
                        if isinstance(rid, str) and rid.startswith("p1-"):
                            got = [k for k in hidden if d.get(k) not in (None, {}, [])]
                            if got:
                                leaks.append(f"{t}{where}: {rid} exposes {got}")
                for t, body in bodies:          # repairs say CI failed: no fix* diff names, no worker session
                    for where, d in _walk(body):
                        rid = d.get("run_id")
                        if not (isinstance(rid, str) and rid.startswith("p1-")):
                            continue
                        files = d.get("files") if isinstance(d.get("files"), dict) else {}
                        if any(str(x).startswith("fix") for x in (files.get("diffs") or [])):
                            leaks.append(f"{t}{where}: {rid} lists repair diffs")
                        if isinstance(d.get("attempt"), str) and d["attempt"].startswith("fix"):
                            leaks.append(f"{t}{where}: {rid} shows the repair session in flight")
                from console.core.events import finished_payload
                if "outcome" in finished_payload("mock", {"run_id": p1_ids[0] if p1_ids else "p1-0001"}, st):
                    leaks.append("SSE runner.run_finished carries an outcome for P1")
                ov = owner.get("/api/overview?ns=mock").json or {}
                if ov.get("headlines"):
                    leaks.append("/api/overview shows headline figures for a blinded stage")
                if leaks:
                    rep.fail("blinding", f"{len(leaks)} outcome leak(s)", "\n".join(leaks[:50]))
                else:
                    rep.ok("blinding", f"P1 incomplete ({len(p1_ids)} of {sum(1 for k in (st.get("runs") or {}) if k.startswith("p1-"))}): no outcome in {len(bodies)} JSON responses or SSE")

        # 8 ------------------------------------------------------------ roles
        try:
            if "users" in ids:
                r = owner.post("/api/users", {"username": VIEWER[0], "password": VIEWER[1], "role": "viewer"})
            else:
                r = None
                app.users.create(VIEWER[0], VIEWER[1], "viewer", by="check")
            _require(r is None or r.status == 200, f"create viewer → {r.status if r else ''} {r.text[:200] if r else ''}")
            viewer = Client(port)
            _require(viewer.login(*VIEWER).status == 200, "viewer login failed")
            vids = [p["id"] for p in (viewer.get("/api/plugins").json or {}).get("plugins", [])]
            for hidden_id in ("run-control", "readiness", "users"):
                _require(hidden_id not in vids, f"viewer sees {hidden_id} in /api/plugins")
            checks = {"/api/audit": 403, "/api/users": 403, "/api/readiness/lock": 403}
            for path, want in checks.items():
                got = viewer.get(path).status
                _require(got == want, f"viewer GET {path} → {got}, expected {want}")
            _require(viewer.post("/api/users", {"username": "x2", "password": "0123456789ab", "role": "owner"}).status == 403,
                     "viewer could POST /api/users")
            if "run-control" in ids:
                rc = next(p for p in app.plugins if p.id == "run-control")
                paths_rc = [f"/api/run-control{fill(r.pattern)}" for r in rc.router.routes if r.method == "GET"] or ["/api/run-control/status"]
                for pth in paths_rc:
                    got = viewer.get(pth).status
                    _require(got == 403, f"viewer GET {pth} → {got}, expected 403")
                for r in rc.router.routes:
                    if r.method == "POST":
                        got = viewer.post(f"/api/run-control{fill(r.pattern)}", {}).status
                        _require(got == 403, f"viewer POST /api/run-control{r.pattern} → {got}, expected 403")
                rep.ok("roles", f"viewer: 403 on {len(paths_rc)} run-control GET routes, readiness, users, audit")
            else:
                rep.ok("roles", "viewer: 403 on readiness, users, audit")
                rep.skip("roles · run-control", "run-control plugin not present yet")
            r = Client(port).get("/api/plugins")
            _require(r.status == 401, f"anonymous /api/plugins → {r.status}, expected 401")
        except Exception as e:  # noqa: BLE001
            rep.fail("roles", str(e), traceback.format_exc())

        # SSE --------------------------------------------------------------
        try:
            first = owner.sse_first_bytes()
            _require(b": connected" in first, f"unexpected SSE start {first[:80]!r}")
            rep.ok("sse", "/api/events streams")
        except Exception as e:  # noqa: BLE001
            rep.fail("sse", str(e), traceback.format_exc())

    except _Abort:
        pass
    except Exception as e:  # noqa: BLE001
        rep.fail("check", str(e), traceback.format_exc())
    finally:
        if app is not None:
            try:
                app.stop()
            except Exception:  # noqa: BLE001
                pass

    for t in rep.traces:
        print(t)
    if rep.failed:
        print(f"CHECK FAILED  (temporary data kept in {tmp})")
        return 1
    if keep:
        print(f"temporary data kept in {tmp}")
    else:
        shutil.rmtree(tmp, ignore_errors=True)
    skips = sum(1 for s, _, _ in rep.lines if s == "SKIP")
    print("CHECK OK" + (f"  ({skips} step(s) skipped: their packages are not present yet)" if skips else ""))
    return 0


class _Abort(Exception):
    pass
