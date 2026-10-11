"""Audit log: console/data/audit.jsonl, one JSON object per line (spec §21.3, §22.9)."""
from __future__ import annotations

import csv
import io
import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from harness.jsonio import append_jsonl, read_jsonl

from .sanitize import sanitize_obj


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class AuditLog:
    def __init__(self, path: Path, bus=None):
        self.path = Path(path)
        self.bus = bus
        self.lock = threading.Lock()

    def append(self, action: str, detail: dict | None = None, user: dict | None = None, *,
               plugin: str | None = None, client: str | None = None) -> dict:
        entry = {
            "ts": _now(),
            "user": (user or {}).get("username") or "system",
            "role": (user or {}).get("role"),
            "action": str(action),
            "plugin": plugin,
            "detail": sanitize_obj(detail or {}),
        }
        if client:
            entry["client"] = client
        with self.lock:
            append_jsonl(self.path, entry)
        if self.bus is not None:
            self.bus.publish("audit.new", entry, ns=None, roles=("owner",))
        return entry

    def query(self, *, user: str | None = None, action: str | None = None, date_from: str | None = None,
              date_to: str | None = None, limit: int | None = None) -> list[dict]:
        """Newest first. `action` matches exactly or as a prefix ("users." matches "users.create").
        `date_from`/`date_to` are ISO dates or timestamps; a bare date in `to` includes that whole day."""
        with self.lock:
            rows = read_jsonl(self.path)
        out = []
        to = date_to
        if to and len(to) == 10:
            to = to + "T23:59:59~"  # '~' sorts after any time suffix
        for r in rows:
            if user and r.get("user") != user:
                continue
            if action and not (r.get("action") == action or str(r.get("action", "")).startswith(action)):
                continue
            ts = r.get("ts", "")
            if date_from and ts < date_from:
                continue
            if to and ts > to:
                continue
            out.append(r)
        out.reverse()
        return out[:limit] if limit else out

    @staticmethod
    def to_csv(rows: list[dict]) -> str:
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(["ts", "user", "role", "action", "plugin", "detail"])
        for r in rows:
            w.writerow([r.get("ts", ""), r.get("user", ""), r.get("role") or "", r.get("action", ""),
                        r.get("plugin") or "", json.dumps(r.get("detail", {}), ensure_ascii=False, sort_keys=True)])
        return buf.getvalue()
