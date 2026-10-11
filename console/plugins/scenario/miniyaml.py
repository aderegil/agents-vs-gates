"""A minimal YAML reader for the subset the architecture catalog uses (Python has no YAML library in the stdlib).

Supported: block mappings, block sequences (also at the same indent as their key), flow sequences `[a, b]` and flow
mappings `{ k: v }` (nested, and spanning several lines), quoted and plain scalars, ints, floats, true/false/null,
`#` comments, and a sequence item that opens an inline mapping (`- k: v` followed by more keys).
Not supported (and rejected with YamlError rather than guessed): anchors, tags, multi-line scalars (| >), documents.
"""
from __future__ import annotations

import re


class YamlError(ValueError):
    pass


_INT = re.compile(r"^[-+]?\d+$")
_FLOAT = re.compile(r"^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$")


def _strip_comment(line: str) -> str:
    """Remove a `# …` comment that is outside quotes and preceded by whitespace (or starts the line)."""
    quote = None
    for i, ch in enumerate(line):
        if quote:
            if ch == "\\" and quote == '"':
                continue
            if ch == quote:
                quote = None
        elif ch in "'\"":
            if i == 0 or line[i - 1] in " \t[{,:-":
                quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[:i]
    return line


def _balance(s: str) -> int:
    """Open flow brackets minus closed ones, ignoring quoted text."""
    depth, quote = 0, None
    for i, ch in enumerate(s):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
    return depth


def _scalar(tok: str):
    tok = tok.strip()
    if tok == "" or tok in ("~", "null", "Null", "NULL"):
        return None
    if tok[0] in "'\"":
        if len(tok) < 2 or tok[-1] != tok[0]:
            raise YamlError(f"unterminated quoted scalar: {tok!r}")
        body = tok[1:-1]
        if tok[0] == "'":
            return body.replace("''", "'")
        return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), body)
    if tok in ("true", "True", "TRUE"):
        return True
    if tok in ("false", "False", "FALSE"):
        return False
    if tok[0] in "&*!|>%@`":
        raise YamlError(f"unsupported YAML construct: {tok!r}")
    if _INT.match(tok):
        return int(tok)
    if _FLOAT.match(tok):
        return float(tok)
    return tok


class _Flow:
    """Recursive-descent reader for one flow collection or scalar held in a single string."""

    def __init__(self, s: str):
        self.s, self.i = s, 0

    def ws(self):
        while self.i < len(self.s) and self.s[self.i] in " \t\r\n":
            self.i += 1

    def value(self):
        self.ws()
        if self.i >= len(self.s):
            raise YamlError("unexpected end of flow value")
        ch = self.s[self.i]
        if ch == "[":
            return self.seq()
        if ch == "{":
            return self.map()
        return self.scalar(",]}")

    def scalar(self, stops: str):
        self.ws()
        start = self.i
        if self.i < len(self.s) and self.s[self.i] in "'\"":
            q = self.s[self.i]
            self.i += 1
            while self.i < len(self.s):
                c = self.s[self.i]
                if c == "\\" and q == '"':
                    self.i += 2
                    continue
                if c == q:
                    if q == "'" and self.s[self.i + 1:self.i + 2] == "'":
                        self.i += 2
                        continue
                    self.i += 1
                    break
                self.i += 1
            else:
                raise YamlError("unterminated quoted scalar")
            return _scalar(self.s[start:self.i])
        while self.i < len(self.s) and self.s[self.i] not in stops:
            self.i += 1
        return _scalar(self.s[start:self.i])

    def seq(self):
        self.i += 1  # [
        out = []
        while True:
            self.ws()
            if self.i >= len(self.s):
                raise YamlError("unterminated flow sequence")
            if self.s[self.i] == "]":
                self.i += 1
                return out
            out.append(self.value())
            self.ws()
            if self.i < len(self.s) and self.s[self.i] == ",":
                self.i += 1
            elif self.i < len(self.s) and self.s[self.i] != "]":
                raise YamlError(f"expected ',' or ']' at {self.s[self.i:self.i + 12]!r}")

    def map(self):
        self.i += 1  # {
        out = {}
        while True:
            self.ws()
            if self.i >= len(self.s):
                raise YamlError("unterminated flow mapping")
            if self.s[self.i] == "}":
                self.i += 1
                return out
            key = self.scalar(":,}")
            self.ws()
            if self.i < len(self.s) and self.s[self.i] == ":":
                self.i += 1
                out[str(key)] = self.value()
            else:
                out[str(key)] = None
            self.ws()
            if self.i < len(self.s) and self.s[self.i] == ",":
                self.i += 1
            elif self.i < len(self.s) and self.s[self.i] != "}":
                raise YamlError(f"expected ',' or '}}' at {self.s[self.i:self.i + 12]!r}")


def _inline(text: str):
    text = text.strip()
    if text[:1] in ("[", "{"):
        f = _Flow(text)
        v = f.value()
        f.ws()
        if f.i != len(text):
            raise YamlError(f"trailing text after flow value: {text[f.i:]!r}")
        return v
    return _scalar(text)


def _split_key(content: str):
    """`key: rest` -> (key, rest) or None when the line is not a mapping entry."""
    quote = None
    for i, ch in enumerate(content):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"" and i == 0:
            quote = ch
        elif ch == ":" and (i + 1 == len(content) or content[i + 1] in " \t"):
            key = content[:i].strip()
            if key[:1] in "'\"":
                key = str(_scalar(key))
            return key, content[i + 1:].strip()
        elif ch in "[{" and i == 0:
            return None
    return None


def _logical_lines(text: str):
    """[(indent, content)] without blanks/comments; flow collections that span lines are joined into one."""
    raw = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿").split("\n")
    out, i = [], 0
    while i < len(raw):
        line = _strip_comment(raw[i]).rstrip()
        i += 1
        if not line.strip():
            continue
        if "\t" in line[:len(line) - len(line.lstrip())]:
            raise YamlError(f"tab indentation on line {i}")
        indent = len(line) - len(line.lstrip(" "))
        content = line.strip()
        while _balance(content) > 0:
            if i >= len(raw):
                raise YamlError("unterminated flow collection")
            nxt = _strip_comment(raw[i]).strip()
            i += 1
            content += " " + nxt
        out.append((indent, content))
    return out


def load(text: str):
    lines = _logical_lines(text)
    if not lines:
        return None
    value, pos = _block(lines, 0, lines[0][0])
    if pos != len(lines):
        raise YamlError(f"unexpected content: {lines[pos][1]!r}")
    return value


def _block(lines, pos, indent):
    content = lines[pos][1]
    if content == "-" or content.startswith("- "):
        return _sequence(lines, pos, indent)
    if _split_key(content) is not None:
        return _mapping(lines, pos, indent)
    return _inline(content), pos + 1


def _mapping(lines, pos, indent):
    out = {}
    while pos < len(lines):
        ind, content = lines[pos]
        if ind < indent:
            break
        if ind > indent:
            raise YamlError(f"bad indentation near {content!r}")
        if content == "-" or content.startswith("- "):
            break
        kv = _split_key(content)
        if kv is None:
            raise YamlError(f"expected 'key: value', got {content!r}")
        key, rest = kv
        if key in out:
            raise YamlError(f"duplicate key {key!r}")
        pos += 1
        if rest:
            out[key] = _inline(rest)
        elif pos < len(lines) and (lines[pos][0] > indent or
                                   (lines[pos][0] == indent and (lines[pos][1] == "-" or lines[pos][1].startswith("- ")))):
            out[key], pos = _block(lines, pos, lines[pos][0])
        else:
            out[key] = None
    return out, pos


def _sequence(lines, pos, indent):
    out = []
    while pos < len(lines):
        ind, content = lines[pos]
        if ind != indent or not (content == "-" or content.startswith("- ")):
            if ind > indent:
                raise YamlError(f"bad indentation near {content!r}")
            break
        rest = content[1:].strip()
        if not rest:
            pos += 1
            if pos < len(lines) and lines[pos][0] > indent:
                val, pos = _block(lines, pos, lines[pos][0])
            else:
                val = None
            out.append(val)
        elif _split_key(rest) is not None and rest[:1] not in "[{":
            # `- k: v` opens a block mapping whose keys are aligned two columns right of the dash
            inner = indent + (len(content) - len(rest))
            lines[pos] = (inner, rest)
            val, pos = _mapping(lines, pos, inner)
            out.append(val)
        else:
            out.append(_inline(rest))
            pos += 1
    return out, pos
