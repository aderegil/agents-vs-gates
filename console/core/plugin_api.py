"""The plugin contract (docs/contracts/console-api.md §2): Router, Request, Response, ApiError, Ctx.

Plugins import from here only:

    from console.core.plugin_api import ApiError, Response

    def register(router, ctx):
        router.get("/stages", list_stages)
        router.post("/start", start, roles=["owner", "operator"])
        router.get("/{run_id}/diff", get_diff)
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

ROLES = ("owner", "operator", "presenter", "viewer")


class ApiError(Exception):
    """Raise from a handler to answer `{"error": message}` with `status`."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = int(status)
        self.message = str(message)


@dataclass
class Response:
    """Raw response for non-JSON bodies (files, SVG, CSV...)."""
    body: bytes | str = b""
    content_type: str = "application/octet-stream"
    status: int = 200
    headers: dict = field(default_factory=dict)


class Request:
    """What a handler receives. `query` maps each key to its first value; `query_all` keeps every value."""

    def __init__(self, *, method: str, path: str, params: dict, query: dict, query_all: dict, body: bytes,
                 headers: dict, user: dict | None, ns: str, plugin: str | None = None, client: str = "127.0.0.1"):
        self.method = method
        self.path = path
        self.params = params
        self.query = query
        self.query_all = query_all
        self.body = body
        self.headers = headers
        self.user = user
        self.ns = ns
        self.plugin = plugin
        self.client = client
        self._json: Any = ...

    @property
    def json(self) -> Any:
        """Parsed JSON body (None when empty). Malformed JSON → ApiError(400)."""
        if self._json is ...:
            if not self.body:
                self._json = None
            else:
                try:
                    self._json = json.loads(self.body.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    raise ApiError(400, "Request body is not valid JSON")
        return self._json


@dataclass
class Route:
    method: str
    pattern: str
    handler: Callable
    roles: list[str] | None
    regex: re.Pattern
    param_names: list[str]
    static_segments: int


_PARAM = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)(:path)?\}")


def compile_pattern(pattern: str) -> tuple[re.Pattern, list[str], int]:
    """'/{run_id}/diff' → regex. '{name}' matches one segment, '{name:path}' the rest of the path."""
    p = pattern.strip()
    if p and not p.startswith("/"):
        p = "/" + p
    p = p.rstrip("/")
    names: list[str] = []
    out = []
    pos = 0
    for m in _PARAM.finditer(p):
        out.append(re.escape(p[pos:m.start()]))
        names.append(m.group(1))
        out.append(f"(?P<{m.group(1)}>.+)" if m.group(2) else f"(?P<{m.group(1)}>[^/]+)")
        pos = m.end()
    out.append(re.escape(p[pos:]))
    static = len([s for s in p.split("/") if s and not _PARAM.search(s)])
    return re.compile("^" + "".join(out) + "/?$"), names, static


class Router:
    """Collects a plugin's routes. Paths are relative to /api/<plugin-id>; "" is the plugin root."""

    def __init__(self, plugin_id: str = ""):
        self.plugin_id = plugin_id
        self.routes: list[Route] = []

    def add(self, method: str, pattern: str, handler: Callable, roles: list[str] | None = None) -> None:
        if roles is not None:
            bad = [r for r in roles if r not in ROLES]
            if bad:
                raise ValueError(f"unknown roles {bad} on {method} {pattern}")
        regex, names, static = compile_pattern(pattern)
        self.routes.append(Route(method.upper(), pattern, handler, list(roles) if roles is not None else None,
                                 regex, names, static))

    def get(self, pattern: str, handler: Callable, roles: list[str] | None = None) -> None:
        self.add("GET", pattern, handler, roles)

    def post(self, pattern: str, handler: Callable, roles: list[str] | None = None) -> None:
        self.add("POST", pattern, handler, roles)

    def put(self, pattern: str, handler: Callable, roles: list[str] | None = None) -> None:
        self.add("PUT", pattern, handler, roles)

    def delete(self, pattern: str, handler: Callable, roles: list[str] | None = None) -> None:
        self.add("DELETE", pattern, handler, roles)

    def match(self, method: str, subpath: str) -> tuple[Route | None, dict, bool]:
        """→ (route, params, path_exists). path_exists=True with route=None means 405."""
        sub = subpath.rstrip("/")
        # Most specific first: more static segments, fewer params, then registration order.
        ordered = sorted(enumerate(self.routes), key=lambda ir: (-ir[1].static_segments, len(ir[1].param_names), ir[0]))
        path_exists = False
        for _, r in ordered:
            m = r.regex.match(sub)
            if not m:
                continue
            path_exists = True
            if r.method == method or (method == "HEAD" and r.method == "GET"):
                from urllib.parse import unquote
                return r, {k: unquote(v) for k, v in m.groupdict().items()}, True
        return None, {}, path_exists


class Ctx:
    """Per-plugin context. Built by the server; see docs/contracts/console-api.md §2."""

    def __init__(self, app, manifest: dict):
        self._app = app
        self.plugin = manifest
        self.plugin_id = manifest["id"]
        self.repo: Path = app.repo
        self.data_dir: Path = app.data_dir
        self.python: str = app.python
        # Core services, for core plugins (users) and anyone who needs them.
        self.users = app.users
        self.sessions = app.sessions

    def results_dir(self, ns: str) -> Path:
        from harness import paths
        return paths.ns_dir(ns)

    def can_write(self, req: Request) -> bool:
        if not req.user:
            return False
        return req.user.get("role") not in (self.plugin.get("readonly_roles") or [])

    def audit(self, action: str, detail: dict | None = None, user: dict | None = None) -> None:
        self._app.audit.append(action, detail or {}, user, plugin=self.plugin_id)

    def publish(self, topic: str, data: dict | None = None, ns: str | None = None) -> None:
        self._app.bus.publish(topic, data or {}, ns=ns)

    def spawn(self, argv: list[str], log_name: str) -> int:
        """Start a detached process (survives a console restart). stdout/stderr → <data_dir>/logs/<log_name>.log."""
        from console.core import runner_ctl
        return runner_ctl.spawn_detached(argv, log_name, data_dir=self.data_dir)

    def module_argv(self, module: str, *args: str) -> list[str]:
        """[python, -X, utf8, -m, module, *args] with the console's interpreter."""
        return [self.python, "-X", "utf8", "-m", module, *args]

    @property
    def runner(self):
        """console.core.runner_ctl (launch_runner, runner_alive, request_stop, schedule_resume, ...)."""
        from console.core import runner_ctl
        return runner_ctl


def default_python(repo: Path) -> str:
    venv = repo / ".venv" / "Scripts" / "python.exe"
    return str(venv) if venv.exists() else sys.executable
