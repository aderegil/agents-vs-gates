"""Agents vs. Gates — Console: HTTP server, sessions, plugin host and SSE (spec §21, §23; contract console-api.md).

Binds to 127.0.0.1 only. Run with `python -m console [--port N] [--data-dir D]`.
"""
from __future__ import annotations

import json
import mimetypes
import os
import queue
import secrets
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit, unquote

from harness import paths
from harness.jsonio import read_json

from . import runner_ctl
from .audit import AuditLog
from .auth import RateLimiter, SessionStore, UserStore, csrf_ok, public_user, ITERATIONS, SESSION_TTL_S
from .events import EventBus, Watcher, progress_payload, sse_comment, sse_format
from .plugin_api import ApiError, Ctx, Request, Response, default_python
from .plugins import discover, load_api
from .sanitize import sanitize_text

CONSOLE_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = CONSOLE_DIR / "web"
PLUGINS_DIR = CONSOLE_DIR / "plugins"
DEFAULT_DATA_DIR = CONSOLE_DIR / "data"
VERSION = "1.0.0"
MAX_BODY = 10 * 1024 * 1024
COOKIE = "avg_session"
PRE_COOKIE = "avg_csrf"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
    ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8", ".wasm": "application/wasm", ".md": "text/plain; charset=utf-8",
}
TEXTUAL = ("application/json", "text/", "image/svg+xml", "application/x-ndjson", "application/javascript")

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; "
       "form-action 'self'; object-src 'none'")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class App:
    def __init__(self, data_dir: Path | None = None, *, plugins_dir: Path | None = None, repo: Path | None = None,
                 iterations: int = ITERATIONS, watch_interval: float = 1.0, session_ttl_s: int = SESSION_TTL_S):
        self.repo = Path(repo or paths.REPO)
        self.data_dir = Path(data_dir or DEFAULT_DATA_DIR)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "logs").mkdir(exist_ok=True)
        self.plugins_dir = Path(plugins_dir or PLUGINS_DIR)
        self.python = default_python(self.repo)
        self.users = UserStore(self.data_dir / "users.json", iterations=iterations)
        self.sessions = SessionStore(self.data_dir / "sessions.json", ttl_s=session_ttl_s)
        self.bus = EventBus()
        self.audit = AuditLog(self.data_dir / "audit.jsonl", bus=self.bus)
        self.limiter = RateLimiter()
        self.watch_interval = watch_interval
        self.started = time.time()
        self.server: ThreadingHTTPServer | None = None
        self.port: int | None = None
        self.watcher: Watcher | None = None
        self.stopping = threading.Event()
        self._real_cache = (0.0, False)
        runner_ctl.configure(data_dir=self.data_dir, audit=self.audit, python=self.python)
        self.load_plugins()

    # ------------------------------------------------------------ plugins
    def load_plugins(self) -> None:
        self.plugins, self.invalid_plugins = discover(self.plugins_dir)
        for bad in self.invalid_plugins:
            self.audit.append("plugin.invalid", bad, None, plugin="core")
        for p in self.plugins:
            load_api(p, Ctx(self, p.manifest))
            if p.api_error:
                self.audit.append("plugin.api_error", {"plugin": p.id, "error": p.api_error}, None, plugin="core")
        self.by_id = {p.id: p for p in self.plugins}

    # ------------------------------------------------------------ namespace
    def real_runs_exist(self) -> bool:
        t, v = self._real_cache
        if time.time() - t < 5:
            return v
        st = read_json(paths.state_path("real"), default=None) or {}
        v = any((r or {}).get("status") not in (None, "pending") for r in (st.get("runs") or {}).values())
        if not v:
            rd = paths.runs_dir("real")
            v = rd.is_dir() and any(rd.iterdir())
        self._real_cache = (time.time(), v)
        return v

    def default_ns(self) -> str:
        return "real" if self.real_runs_exist() else "mock"

    def session_ns(self, session: dict | None) -> str:
        ns = (session or {}).get("ns")
        return ns if ns in paths.NAMESPACES else self.default_ns()

    # ------------------------------------------------------------ lifecycle
    def start(self, port: int = 8765, *, background: bool = True) -> int:
        handler = type("BoundHandler", (Handler,), {"app": self})
        self.server = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.watcher = Watcher(self.bus, interval=self.watch_interval, scheduler=runner_ctl.scheduler_tick)
        self.watcher.start()
        if background:
            threading.Thread(target=self.server.serve_forever, name="avg-http", daemon=True).start()
        return self.port

    def serve_forever(self) -> None:
        assert self.server
        self.server.serve_forever()

    def stop(self) -> None:
        self.stopping.set()
        if self.watcher:
            self.watcher.stop()
        if self.server:
            self.server.shutdown()
            self.server.server_close()

    def log_error(self, text: str) -> None:
        try:
            with open(self.data_dir / "logs" / "console.log", "a", encoding="utf-8", newline="\n") as f:
                f.write(f"{_now_iso()} {sanitize_text(text)}\n")
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    app: App
    server_version = "AgentsVsGatesConsole/" + VERSION
    sys_version = ""

    # ------------------------------------------------------------ plumbing
    def log_message(self, fmt, *args):  # quiet; errors go to data/logs/console.log
        pass

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-store")

    def _send(self, status: int, body: bytes, content_type: str, headers: dict | None = None,
              cookies_out: list[str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._security_headers()
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        for c in cookies_out or []:
            self.send_header("Set-Cookie", c)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, obj, cookies_out: list[str] | None = None, headers: dict | None = None) -> None:
        text = sanitize_text(json.dumps(obj, ensure_ascii=False, default=str))
        self._send(status, text.encode("utf-8"), "application/json; charset=utf-8", headers, cookies_out)

    def _error(self, status: int, message: str, headers: dict | None = None) -> None:
        self._json(status, {"error": message}, headers=headers)

    def _cookies(self) -> dict:
        c = cookies.SimpleCookie()
        try:
            c.load(self.headers.get("Cookie", ""))
        except cookies.CookieError:
            return {}
        return {k: m.value for k, m in c.items()}

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        port = self.app.port
        return host in (f"127.0.0.1:{port}", f"localhost:{port}") or (port == 80 and host in ("127.0.0.1", "localhost"))

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin or origin == "null":
            return origin != "null"
        port = self.app.port
        return origin.lower() in (f"http://127.0.0.1:{port}", f"http://localhost:{port}")

    def _read_body(self) -> bytes:
        """The request body, read once. _dispatch reads it before any early error response: answering without
        draining it makes Windows reset the connection and the client never sees the status."""
        if getattr(self, "_body", None) is not None:
            return self._body
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "Bad Content-Length")
        if n < 0 or n > MAX_BODY:
            self.close_connection = True
            raise ApiError(413, "Request body too large")
        self._body = self.rfile.read(n) if n else b""
        return self._body

    def _client(self) -> str:
        return self.client_address[0]

    # ------------------------------------------------------------ session helpers
    def _session(self) -> tuple[dict | None, dict | None, str | None]:
        """→ (session, user, token). The user's role is read from users.json on every request."""
        token = self._cookies().get(COOKIE)
        s = self.app.sessions.get(token)
        if not s:
            return None, None, None
        u = self.app.users.get(s["username"])
        if not u or not u.get("active"):
            self.app.sessions.delete(token)
            return None, None, None
        return s, {"username": u["username"], "role": u["role"]}, token

    def _session_cookie(self, token: str) -> str:
        return f"{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={self.app.sessions.ttl_s}"

    def _clear_cookie(self) -> str:
        return f"{COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"

    def _session_payload(self, s: dict, user: dict) -> dict:
        return {
            "authenticated": True, "setup_required": False, "user": user, "csrf": s["csrf"],
            "ns": self.app.session_ns(s), "ns_explicit": s.get("ns") in paths.NAMESPACES,
            "ns_default": self.app.default_ns(),
            "expires_at": datetime.fromtimestamp(s["expires_ts"], timezone.utc).isoformat(timespec="seconds"),
            "version": VERSION,
        }

    # ------------------------------------------------------------ dispatch
    def _dispatch(self, method: str) -> None:
        self._body = None
        try:
            if method not in ("GET", "HEAD"):
                self._read_body()
            if not self._host_ok():
                return self._error(421, "Unexpected Host header")
            url = urlsplit(self.path)
            path = unquote(url.path)
            if path.startswith("/api/") or path == "/api":
                return self._api(method, path, url.query)
            if method not in ("GET", "HEAD"):
                return self._error(405, "Method not allowed")
            return self._static(path)
        except ApiError as e:
            self._error(e.status, e.message)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception:  # noqa: BLE001
            self.app.log_error(f"{method} {self.path}\n{traceback.format_exc()}")
            try:
                self._error(500, "Internal error")
            except OSError:
                pass

    # ------------------------------------------------------------ static
    def _static(self, path: str) -> None:
        if path in ("/", "/index.html"):
            return self._file(WEB_DIR / "index.html", WEB_DIR)
        if path == "/favicon.ico":
            return self._file(WEB_DIR / "favicon.svg", WEB_DIR)
        if path.startswith("/web/"):
            return self._file(WEB_DIR / path[len("/web/"):], WEB_DIR)
        if path.startswith("/plugins/"):
            rest = path[len("/plugins/"):]
            pid, _, sub = rest.partition("/")
            p = self.app.by_id.get(pid)
            if not p or not sub.startswith("web/"):
                return self._error(404, "Not found")
            return self._file(p.dir / sub, p.dir / "web")
        return self._error(404, "Not found")

    def _file(self, f: Path, root: Path) -> None:
        try:
            fp = f.resolve()
            rp = root.resolve()
        except OSError:
            return self._error(404, "Not found")
        if not (fp == rp or str(fp).startswith(str(rp) + os.sep)) or not fp.is_file():
            return self._error(404, "Not found")
        ct = CONTENT_TYPES.get(fp.suffix.lower()) or mimetypes.guess_type(fp.name)[0] or "application/octet-stream"
        self._send(200, fp.read_bytes(), ct)

    # ------------------------------------------------------------ API
    def _api(self, method: str, path: str, qs: str) -> None:
        sub = path[len("/api"):].rstrip("/") or "/"
        query_all = parse_qs(qs, keep_blank_values=True)
        query = {k: v[0] for k, v in query_all.items()}
        session, user, token = self._session()

        if method not in ("GET", "HEAD") and not self._origin_ok():
            raise ApiError(403, "Cross-origin request refused")

        core = {
            ("GET", "/session"): self._api_session, ("POST", "/login"): self._api_login,
            ("POST", "/logout"): self._api_logout, ("POST", "/setup"): self._api_setup,
            ("GET", "/health"): self._api_health,
        }
        h = core.get((method if method != "HEAD" else "GET", sub))
        if h:
            return h(session, user, token, query)

        # Everything below needs a session.
        if not session:
            raise ApiError(401, "Sign in required")
        if method not in ("GET", "HEAD"):
            if not csrf_ok(session["csrf"], self.headers.get("X-CSRF-Token")):
                raise ApiError(403, "Missing or invalid CSRF token")

        authed = {
            ("POST", "/session/ns"): self._api_set_ns, ("GET", "/plugins"): self._api_plugins,
            ("GET", "/events"): self._api_events, ("GET", "/audit"): self._api_audit,
            ("GET", "/status"): self._api_status,
        }
        h = authed.get((method if method != "HEAD" else "GET", sub))
        if h:
            return h(session, user, token, query)

        pid, _, rest = sub.lstrip("/").partition("/")
        plugin = self.app.by_id.get(pid)
        if not plugin:
            raise ApiError(404, "Not found")
        return self._api_plugin(plugin, method, "/" + rest if rest else "", session, user, query, query_all)

    def _ns_for(self, session: dict | None, query: dict) -> str:
        q = query.get("ns")
        if q:
            if q not in paths.NAMESPACES:
                raise ApiError(400, "ns must be real or mock")
            return q
        return self.app.session_ns(session)

    # ---- core routes
    def _api_session(self, session, user, token, query):
        if session:
            return self._json(200, self._session_payload(session, user))
        pre = self._cookies().get(PRE_COOKIE)
        out_cookies = []
        if not pre or len(pre) < 20:
            pre = secrets.token_urlsafe(32)
            out_cookies.append(f"{PRE_COOKIE}={pre}; HttpOnly; SameSite=Strict; Path=/api")
        return self._json(200, {"authenticated": False, "setup_required": self.app.users.empty(), "csrf": pre,
                                "version": VERSION}, cookies_out=out_cookies)

    def _pre_csrf_ok(self) -> bool:
        return csrf_ok(self._cookies().get(PRE_COOKIE), self.headers.get("X-CSRF-Token"))

    def _body_json(self) -> dict:
        raw = self._read_body()
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "Request body is not valid JSON")
        if not isinstance(data, dict):
            raise ApiError(400, "Request body must be a JSON object")
        return data

    def _login_response(self, username: str, status: int = 200):
        u = self.app.users.get(username)
        token, s = self.app.sessions.create(username)
        user = {"username": u["username"], "role": u["role"]}
        return self._json(status, self._session_payload(s, user), cookies_out=[self._session_cookie(token)])

    def _api_setup(self, session, user, token, query):
        if self._client() != "127.0.0.1":
            raise ApiError(403, "Setup is only available from 127.0.0.1")
        if not self._pre_csrf_ok():
            raise ApiError(403, "Missing or invalid CSRF token")
        data = self._body_json()
        with self.app.users.lock:
            if not self.app.users.empty():
                raise ApiError(409, "Setup is already done")
            pw, pw2 = data.get("password"), data.get("confirm", data.get("password"))
            if pw != pw2:
                raise ApiError(400, "Passwords do not match")
            u = self.app.users.create(data.get("username"), pw, "owner", by="setup")
        self.app.audit.append("setup.owner_created", {"username": u["username"]}, u, plugin="core", client=self._client())
        self.app.audit.append("login", {"via": "setup"}, u, plugin="core", client=self._client())
        self.app.users.touch_login(u["username"])
        return self._login_response(u["username"], 201)

    def _api_login(self, session, user, token, query):
        if not self._pre_csrf_ok():
            raise ApiError(403, "Missing or invalid CSRF token")
        data = self._body_json()
        username = str(data.get("username") or "").strip().lower()
        password = data.get("password") or ""
        keys = (f"ip:{self._client()}", f"user:{username}")
        wait = self.app.limiter.blocked_for(*keys)
        if wait:
            self.app.audit.append("login.blocked", {"username": username, "retry_after_s": wait}, None,
                                  plugin="core", client=self._client())
            return self._json(429, {"error": f"Too many failed sign-ins. Try again in {wait} s."},
                              headers={"Retry-After": str(wait)})
        u = self.app.users.authenticate(username, password if isinstance(password, str) else "")
        if not u:
            self.app.limiter.failure(*keys)
            self.app.audit.append("login.failed", {"username": username}, None, plugin="core", client=self._client())
            raise ApiError(401, "Wrong username or password, or the account is disabled")
        self.app.limiter.success(*keys)
        self.app.users.touch_login(u["username"])
        self.app.audit.append("login", {}, public_user(u), plugin="core", client=self._client())
        return self._login_response(u["username"])

    def _api_logout(self, session, user, token, query):
        if not session:
            return self._json(200, {"ok": True}, cookies_out=[self._clear_cookie()])
        if not csrf_ok(session["csrf"], self.headers.get("X-CSRF-Token")):
            raise ApiError(403, "Missing or invalid CSRF token")
        self.app.sessions.delete(token)
        self.app.audit.append("logout", {}, user, plugin="core", client=self._client())
        return self._json(200, {"ok": True}, cookies_out=[self._clear_cookie()])

    def _api_health(self, session, user, token, query):
        out = {"ok": True, "version": VERSION, "setup_required": self.app.users.empty(),
               "uptime_s": int(time.time() - self.app.started)}
        if session:
            out["plugins"] = len(self.app.plugins)
            out["invalid_plugins"] = self.app.invalid_plugins if user["role"] == "owner" else len(self.app.invalid_plugins)
            out["api_errors"] = {p.id: p.api_error for p in self.app.plugins if p.api_error}
        return self._json(200, out)

    def _api_set_ns(self, session, user, token, query):
        data = self._body_json()
        ns = data.get("ns")
        if ns not in paths.NAMESPACES:
            raise ApiError(400, "ns must be real or mock")
        self.app.sessions.set_ns(token, ns)
        return self._json(200, {"ns": ns})

    def _api_plugins(self, session, user, token, query):
        role = user["role"]
        visible = [p.public(role) for p in self.app.plugins if role in p.roles]
        return self._json(200, {"plugins": visible})

    def _api_status(self, session, user, token, query):
        ns = self._ns_for(session, query)
        return self._json(200, {"ns": ns, "runner": {n: runner_ctl.status(n) for n in paths.NAMESPACES}})

    def _api_audit(self, session, user, token, query):
        if user["role"] != "owner":
            raise ApiError(403, "Only the owner can read the audit log")
        try:
            limit = int(query.get("limit") or 0) or None
        except ValueError:
            raise ApiError(400, "limit must be an integer")
        rows = self.app.audit.query(user=query.get("user") or None, action=query.get("action") or None,
                                    date_from=query.get("from") or None, date_to=query.get("to") or None, limit=limit)
        if query.get("format") == "csv":
            body = sanitize_text(self.app.audit.to_csv(rows)).encode("utf-8")
            stamp = datetime.now().strftime("%Y%m%d-%H%M")
            return self._send(200, body, "text/csv; charset=utf-8",
                              {"Content-Disposition": f'attachment; filename="audit-{stamp}.csv"'})
        users = sorted({r.get("user") for r in self.app.audit.query()} - {None})
        actions = sorted({r.get("action") for r in self.app.audit.query()} - {None})
        return self._json(200, {"entries": rows, "users": users, "actions": actions, "total": len(rows)})

    def _api_events(self, session, user, token, query):
        sub = self.app.bus.subscribe(user["role"])
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(b"retry: 3000\n\n" + sse_comment("connected"))
            for ns in paths.NAMESPACES:  # initial snapshot so the status bar is right immediately
                st = read_json(paths.state_path(ns), default=None)
                if isinstance(st, dict):
                    self.wfile.write(sse_format("runner.progress", dict(progress_payload(st), ns=ns)))
            self.wfile.flush()
            last = time.monotonic()
            while not self.app.stopping.is_set():
                try:
                    seq, topic, data = sub.q.get(timeout=1.0)
                    self.wfile.write(sse_format(topic, data, seq))
                    self.wfile.flush()
                    last = time.monotonic()
                except queue.Empty:
                    if time.monotonic() - last >= 15:
                        if not self.app.sessions.get(token):
                            break  # session ended (logout/expiry): close the stream
                        self.wfile.write(sse_comment())
                        self.wfile.flush()
                        last = time.monotonic()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            self.app.bus.unsubscribe(sub)
            self.close_connection = True

    # ---- plugin routes
    def _api_plugin(self, plugin, method, sub, session, user, query, query_all):
        role = user["role"]
        if role not in plugin.roles:
            raise ApiError(403, f"Your role ({role}) cannot use {plugin.manifest['name']}")
        if plugin.api_error:
            raise ApiError(503, f"{plugin.manifest['name']} API failed to load: {plugin.api_error}")
        route, params, exists = plugin.router.match("GET" if method == "HEAD" else method, sub)
        if not route:
            raise ApiError(405 if exists else 404, "Method not allowed" if exists else "Not found")
        if route.roles is not None and role not in route.roles:
            raise ApiError(403, f"Your role ({role}) cannot do this")
        if (method not in ("GET", "HEAD") and role in plugin.readonly_roles
                and not (route.roles is not None and role in route.roles)):
            raise ApiError(403, f"{plugin.manifest['name']} is read-only for your role ({role})")
        body = self._read_body() if method not in ("GET", "HEAD") else b""
        req = Request(method=method, path=sub or "/", params=params, query=query, query_all=query_all, body=body,
                      headers={k: v for k, v in self.headers.items()}, user=dict(user),
                      ns=self._ns_for(session, query), plugin=plugin.id, client=self._client())
        try:
            result = route.handler(req)
        except ApiError:
            raise
        except Exception:  # noqa: BLE001
            self.app.log_error(f"plugin {plugin.id} {method} {sub}\n{traceback.format_exc()}")
            raise ApiError(500, f"Internal error in plugin {plugin.id}")
        return self._result(result)

    def _result(self, result) -> None:
        if isinstance(result, Response):
            body = result.body.encode("utf-8") if isinstance(result.body, str) else (result.body or b"")
            if any(result.content_type.startswith(t) for t in TEXTUAL):
                body = sanitize_text(body.decode("utf-8", "replace")).encode("utf-8")
            return self._send(result.status, body, result.content_type, result.headers)
        if result is None:
            return self._send(204, b"", "application/json")
        if isinstance(result, (dict, list)):
            return self._json(200, result)
        if isinstance(result, str):
            return self._send(200, sanitize_text(result).encode("utf-8"), "text/plain; charset=utf-8")
        if isinstance(result, bytes):
            return self._send(200, result, "application/octet-stream")
        return self._json(200, result)


def main(port: int = 8765, data_dir: Path | None = None) -> int:
    try:
        app = App(data_dir)
        app.start(port, background=False)
    except OSError as e:
        print(f"Cannot listen on 127.0.0.1:{port}: {e}", file=sys.stderr)
        return 1
    n = len(app.plugins)
    print(f"Agents vs. Gates — Console  http://127.0.0.1:{app.port}  ({n} plugin{'s' if n != 1 else ''}; "
          f"data: {sanitize_text(str(app.data_dir))})", flush=True)
    for bad in app.invalid_plugins:
        print(f"  skipped plugin {bad['folder']}: {'; '.join(bad['errors'])}")
    for p in app.plugins:
        if p.api_error:
            print(f"  plugin {p.id}: API failed to load: {p.api_error}")
    if app.users.empty():
        print("  First run: open the URL above to create the owner account.", flush=True)
    try:
        app.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.stop()
    return 0
