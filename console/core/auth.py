"""Local users, password hashing, sessions and login rate limiting (spec §21.3).

users.json    {"schema": "users/1", "users": [{username, role, active, salt, hash, iterations, created_at, updated_at, ...}]}
sessions.json {"schema": "sessions/1", "sessions": {sha256(token): {username, csrf, created_at, expires_at, ns}}}

Only the SHA-256 of a session token is stored on disk, so the file alone does not let anyone resume a session;
the browser holds the token in the HttpOnly cookie `avg_session`.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from harness.jsonio import read_json, write_json_atomic

from .plugin_api import ROLES, ApiError

ITERATIONS = 310_000
SESSION_TTL_S = 12 * 3600
MIN_PASSWORD = 10
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hash_password(password: str, salt: bytes | None = None, iterations: int = ITERATIONS) -> dict:
    salt = salt if salt is not None else secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return {"salt": salt.hex(), "hash": dk.hex(), "iterations": iterations, "algo": "pbkdf2-sha256"}


def verify_password(password: str, rec: dict) -> bool:
    try:
        salt = bytes.fromhex(rec["salt"])
        it = int(rec.get("iterations", ITERATIONS))
        expected = bytes.fromhex(rec["hash"])
    except (KeyError, ValueError, TypeError):
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, it)
    return hmac.compare_digest(dk, expected)


# A hash to burn the same CPU time when the username does not exist (no user enumeration by timing).
_DUMMY = hash_password("not-a-real-password", salt=b"\x00" * 16)


def validate_username(username) -> str:
    if not isinstance(username, str) or not USERNAME_RE.match(username):
        raise ApiError(400, "Username: 2–32 characters, lowercase letters, digits, '.', '_' or '-'")
    return username


def validate_password(password) -> str:
    if not isinstance(password, str) or len(password) < MIN_PASSWORD:
        raise ApiError(400, f"Password: at least {MIN_PASSWORD} characters")
    if len(password) > 256:
        raise ApiError(400, "Password: at most 256 characters")
    return password


def validate_role(role) -> str:
    if role not in ROLES:
        raise ApiError(400, f"Role must be one of {', '.join(ROLES)}")
    return role


def public_user(u: dict) -> dict:
    return {k: u.get(k) for k in ("username", "role", "active", "created_at", "updated_at", "created_by", "last_login_at")}


class UserStore:
    def __init__(self, path: Path, iterations: int = ITERATIONS):
        self.path = Path(path)
        self.iterations = iterations
        self.lock = threading.RLock()

    # -- persistence
    def _load(self) -> list[dict]:
        data = read_json(self.path, default=None) or {}
        return list(data.get("users", []))

    def _save(self, users: list[dict]) -> None:
        write_json_atomic(self.path, {"schema": "users/1", "users": users})

    # -- queries
    def all(self) -> list[dict]:
        with self.lock:
            return self._load()

    def get(self, username: str) -> dict | None:
        with self.lock:
            for u in self._load():
                if u.get("username") == username:
                    return u
        return None

    def empty(self) -> bool:
        return not self.all()

    def active_owners(self, users: list[dict] | None = None) -> list[dict]:
        return [u for u in (users if users is not None else self.all()) if u.get("role") == "owner" and u.get("active")]

    # -- authentication
    def authenticate(self, username: str, password: str) -> dict | None:
        u = self.get(username) if isinstance(username, str) else None
        if not u:
            verify_password(password or "", _DUMMY)
            return None
        ok = verify_password(password or "", u)
        if not ok or not u.get("active"):
            return None
        return u

    # -- changes (each returns the public user)
    def create(self, username: str, password: str, role: str, by: str | None = None) -> dict:
        validate_username(username)
        validate_password(password)
        validate_role(role)
        with self.lock:
            users = self._load()
            if any(u.get("username") == username for u in users):
                raise ApiError(409, f"User {username} already exists")
            ts = now_iso()
            u = {"username": username, "role": role, "active": True, **hash_password(password, iterations=self.iterations),
                 "created_at": ts, "updated_at": ts, "created_by": by}
            users.append(u)
            self._save(users)
            return public_user(u)

    def _update(self, username: str, fn) -> dict:
        with self.lock:
            users = self._load()
            for u in users:
                if u.get("username") == username:
                    fn(u, users)
                    u["updated_at"] = now_iso()
                    self._save(users)
                    return public_user(u)
        raise ApiError(404, f"No user {username}")

    def set_role(self, username: str, role: str) -> dict:
        validate_role(role)

        def fn(u, users):
            if u["role"] == "owner" and role != "owner" and u.get("active") and len(self.active_owners(users)) <= 1:
                raise ApiError(409, "At least one active owner must remain")
            u["role"] = role
        return self._update(username, fn)

    def set_password(self, username: str, password: str) -> dict:
        validate_password(password)

        def fn(u, users):
            u.update(hash_password(password, iterations=self.iterations))
        return self._update(username, fn)

    def set_active(self, username: str, active: bool) -> dict:
        def fn(u, users):
            if not active and u["role"] == "owner" and u.get("active") and len(self.active_owners(users)) <= 1:
                raise ApiError(409, "At least one active owner must remain")
            u["active"] = bool(active)
        return self._update(username, fn)

    def touch_login(self, username: str) -> None:
        with self.lock:
            users = self._load()
            for u in users:
                if u.get("username") == username:
                    u["last_login_at"] = now_iso()
                    self._save(users)
                    return


def _token_key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class SessionStore:
    """In memory, mirrored to sessions.json so a console restart does not log everyone out."""

    def __init__(self, path: Path | None, ttl_s: int = SESSION_TTL_S):
        self.path = Path(path) if path else None
        self.ttl_s = ttl_s
        self.lock = threading.RLock()
        self.sessions: dict[str, dict] = {}
        if self.path:
            data = read_json(self.path, default=None) or {}
            now = time.time()
            self.sessions = {k: v for k, v in (data.get("sessions") or {}).items()
                             if isinstance(v, dict) and v.get("expires_ts", 0) > now}

    def _save(self) -> None:
        if self.path:
            write_json_atomic(self.path, {"schema": "sessions/1", "sessions": self.sessions})

    def create(self, username: str, ns: str | None = None) -> tuple[str, dict]:
        token = secrets.token_urlsafe(32)
        now = time.time()
        s = {"username": username, "csrf": secrets.token_urlsafe(32), "created_ts": now,
             "expires_ts": now + self.ttl_s, "ns": ns}
        with self.lock:
            self.sessions[_token_key(token)] = s
            self._purge()
            self._save()
        return token, dict(s)

    def get(self, token: str | None) -> dict | None:
        if not token:
            return None
        key = _token_key(token)
        with self.lock:
            s = self.sessions.get(key)
            if not s:
                return None
            if s["expires_ts"] <= time.time():
                del self.sessions[key]
                self._save()
                return None
            return dict(s, key=key)

    def set_ns(self, token: str, ns: str) -> None:
        with self.lock:
            s = self.sessions.get(_token_key(token))
            if s:
                s["ns"] = ns
                self._save()

    def delete(self, token: str | None) -> None:
        if not token:
            return
        with self.lock:
            if self.sessions.pop(_token_key(token), None) is not None:
                self._save()

    def delete_user(self, username: str) -> int:
        with self.lock:
            keys = [k for k, s in self.sessions.items() if s.get("username") == username]
            for k in keys:
                del self.sessions[k]
            if keys:
                self._save()
            return len(keys)

    def _purge(self) -> None:
        now = time.time()
        for k in [k for k, s in self.sessions.items() if s.get("expires_ts", 0) <= now]:
            del self.sessions[k]


def csrf_ok(expected: str | None, given: str | None) -> bool:
    if not expected or not given:
        return False
    return hmac.compare_digest(expected.encode("utf-8"), given.encode("utf-8"))


class RateLimiter:
    """At most `max_failures` failed logins per key in `window_s` seconds; then refuse until the window clears."""

    def __init__(self, max_failures: int = 5, window_s: int = 300):
        self.max_failures = max_failures
        self.window_s = window_s
        self.fail: dict[str, list[float]] = {}
        self.lock = threading.Lock()

    def _recent(self, key: str, now: float) -> list[float]:
        xs = [t for t in self.fail.get(key, []) if now - t < self.window_s]
        self.fail[key] = xs
        return xs

    def blocked_for(self, *keys: str) -> int:
        now = time.time()
        with self.lock:
            wait = 0
            for k in keys:
                xs = self._recent(k, now)
                if len(xs) >= self.max_failures:
                    wait = max(wait, int(self.window_s - (now - xs[0])) + 1)
            return wait

    def failure(self, *keys: str) -> None:
        now = time.time()
        with self.lock:
            for k in keys:
                self._recent(k, now).append(now)

    def success(self, *keys: str) -> None:
        with self.lock:
            for k in keys:
                self.fail.pop(k, None)
