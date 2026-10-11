"""Remove Windows user-profile paths from anything the console sends (contract: never return C:\\Users\\<name>)."""
from __future__ import annotations

import re

# Matches C:\Users\name, C:\\Users\\name (JSON-escaped) and C:/Users/name, any case.
_USERS = re.compile(r"(?i)[A-Z]:(?:\\\\|\\|/)Users(?:\\\\|\\|/)[^\\/\s\"'<>|:*?]+")


def sanitize_text(text: str) -> str:
    return _USERS.sub("~", text)


def sanitize_obj(obj):
    if isinstance(obj, str):
        return sanitize_text(obj)
    if isinstance(obj, dict):
        return {sanitize_text(k) if isinstance(k, str) else k: sanitize_obj(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize_obj(v) for v in obj]
    return obj
