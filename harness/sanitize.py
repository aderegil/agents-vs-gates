"""Sanitizer (spec 10.3, 10.7): canary scan, token redaction, user-path scrubbing. Applied before any artifact
(transcript, diffs, record, trace) is written.

    canary_hits(text, where) -> [{"canary", "origin", "where"}]
    clean(text) -> (text, token_exposed)          token -> [REDACTED], C:\\Users\\<name> -> ~
    clean_obj(obj) -> (obj, token_exposed)        same, recursively over JSON-able data
"""
from __future__ import annotations

import json
import re
from functools import lru_cache

from harness import authenv, paths

REDACTED = "[REDACTED]"
TOKEN_SHAPES = re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}|\bsk-[A-Za-z0-9]{32,}\b|\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b")
USER_PATH = re.compile(r"(?i)(?:\b[A-Z]:|/[a-z](?=/))?[\\/]+Users[\\/]+(?!Public\b|Default\b)[^\\/\s\"'`]+")


@lru_cache(maxsize=1)
def canaries() -> dict[str, str]:
    data = json.loads(paths.CANARIES.read_text(encoding="utf-8"))
    return {v: k for k, v in data["canaries"].items()}      # canary -> origin


def canary_hits(text: str, where: str) -> list[dict]:
    hits = []
    if not text or "CANARY-" not in text:
        return hits
    reg = canaries()
    for c in sorted(set(re.findall(r"CANARY-[0-9a-f]{16}", text))):
        hits.append({"canary": c, "origin": reg.get(c, "unknown"), "where": where})
    return hits


def _token() -> str | None:
    return authenv.oauth_token()


def clean(text: str, token: str | None = ...) -> tuple[str, bool]:
    if not text:
        return text, False
    tok = _token() if token is ... else token
    exposed = False
    if tok and len(tok) >= 8 and tok in text:
        text = text.replace(tok, REDACTED)
        exposed = True
    new = TOKEN_SHAPES.sub(REDACTED, text)
    exposed |= new != text
    return USER_PATH.sub("~", new), exposed


def clean_obj(obj, token: str | None = ...):
    tok = _token() if token is ... else token
    exposed = False

    def walk(o):
        nonlocal exposed
        if isinstance(o, str):
            s, e = clean(o, tok)
            exposed |= e
            return s
        if isinstance(o, list):
            return [walk(x) for x in o]
        if isinstance(o, dict):
            return {walk(k) if isinstance(k, str) else k: walk(v) for k, v in o.items()}
        return o

    return walk(obj), exposed
