"""Minimal console client (stdlib) for `--check` and the tests: cookies, CSRF, JSON."""
from __future__ import annotations

import http.client
import json
from http import cookies


class Resp:
    def __init__(self, status: int, headers: list[tuple[str, str]], body: bytes):
        self.status = status
        self.headers = headers
        self.body = body

    def header(self, name: str) -> str | None:
        for k, v in self.headers:
            if k.lower() == name.lower():
                return v
        return None

    def headers_all(self, name: str) -> list[str]:
        return [v for k, v in self.headers if k.lower() == name.lower()]

    @property
    def json(self):
        try:
            return json.loads(self.body.decode("utf-8")) if self.body else None
        except ValueError:
            return None

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")


class Client:
    def __init__(self, port: int, host: str = "127.0.0.1", timeout: float = 300):
        self.port = port
        self.host = host
        self.timeout = timeout
        self.jar: dict[str, str] = {}
        self.csrf: str | None = None

    def request(self, method: str, path: str, body=None, headers: dict | None = None, csrf: bool = True) -> Resp:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        h = {"Host": f"{self.host}:{self.port}", "Accept": "application/json"}
        if self.jar:
            h["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.jar.items())
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        if method != "GET" and csrf and self.csrf:
            h["X-CSRF-Token"] = self.csrf
        h.update(headers or {})
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        resp = Resp(r.status, r.getheaders(), r.read())
        conn.close()
        for sc in resp.headers_all("Set-Cookie"):
            c = cookies.SimpleCookie()
            c.load(sc)
            for k, m in c.items():
                if m.value == "" or m.get("max-age") == "0":
                    self.jar.pop(k, None)
                else:
                    self.jar[k] = m.value
        return resp

    def get(self, path: str, **kw) -> Resp:
        return self.request("GET", path, **kw)

    def post(self, path: str, body=None, **kw) -> Resp:
        return self.request("POST", path, body if body is not None else {}, **kw)

    def session(self) -> dict:
        s = self.get("/api/session").json or {}
        self.csrf = s.get("csrf")
        return s

    def setup(self, username: str, password: str) -> Resp:
        self.session()
        r = self.post("/api/setup", {"username": username, "password": password, "confirm": password})
        if r.status in (200, 201):
            self.csrf = r.json["csrf"]
        return r

    def login(self, username: str, password: str) -> Resp:
        self.session()
        r = self.post("/api/login", {"username": username, "password": password})
        if r.status == 200:
            self.csrf = r.json["csrf"]
        return r

    def sse_first_bytes(self, path: str = "/api/events", limit: int = 4096, timeout: float = 5) -> bytes:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        h = {"Host": f"{self.host}:{self.port}", "Accept": "text/event-stream"}
        if self.jar:
            h["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.jar.items())
        conn.request("GET", path, headers=h)
        r = conn.getresponse()
        out = b""
        try:
            if r.status != 200:
                return f"HTTP {r.status}".encode()
            out = r.read1(limit) if hasattr(r, "read1") else r.read(64)
        finally:
            conn.close()
        return out
