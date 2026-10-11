"""Reader for the architecture catalog (`catalog/*.yaml`, spec 5.6.2) without a YAML library.

The catalog uses a small YAML subset: `# comments`, top-level `key: value`, one level of nested `key: value` under a
mapping, block lists (`- item`), and flow collections (`{ a: b }`, `[x, y]`) that may span lines.
"""
from __future__ import annotations

import re
from pathlib import Path


class CatalogError(ValueError):
    pass


def _strip_comment(line: str) -> str:
    out, quote = [], None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1].isspace()):
            break
        out.append(ch)
    return "".join(out).rstrip()


class _Flow:
    def __init__(self, text: str):
        self.s, self.i = text, 0

    def ws(self) -> None:
        while self.i < len(self.s) and self.s[self.i].isspace():
            self.i += 1

    def value(self):
        self.ws()
        if self.i >= len(self.s):
            return None
        ch = self.s[self.i]
        if ch == "{":
            return self.mapping()
        if ch == "[":
            return self.seq()
        if ch in "\"'":
            end = self.s.index(ch, self.i + 1)
            v = self.s[self.i + 1:end]
            self.i = end + 1
            return v
        m = re.compile(r"[^,\]\}]*").match(self.s, self.i)
        self.i = m.end()
        return _scalar(m.group(0).strip())

    def mapping(self) -> dict:
        self.i += 1
        out = {}
        while True:
            self.ws()
            if self.s[self.i] == "}":
                self.i += 1
                return out
            m = re.compile(r"\s*([^:,\}]+?)\s*:").match(self.s, self.i)
            if not m:
                raise CatalogError(f"bad flow mapping near {self.s[self.i:self.i + 30]!r}")
            self.i = m.end()
            out[m.group(1).strip().strip("\"'")] = self.value()
            self.ws()
            if self.s[self.i] == ",":
                self.i += 1

    def seq(self) -> list:
        self.i += 1
        out = []
        while True:
            self.ws()
            if self.s[self.i] == "]":
                self.i += 1
                return out
            out.append(self.value())
            self.ws()
            if self.s[self.i] == ",":
                self.i += 1


def _scalar(v: str):
    if v == "" or v in ("~", "null"):
        return None
    if v in ("true", "false"):
        return v == "true"
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    return v.strip("\"'")


def _flow(text: str):
    return _Flow(text).value()


def parse(text: str) -> dict:
    lines = [l for l in (_strip_comment(x) for x in text.splitlines()) if l.strip()]
    # Join continuation lines of flow collections that span several lines.
    joined: list[str] = []
    depth = 0
    for l in lines:
        if depth > 0:
            joined[-1] += " " + l.strip()
        else:
            joined.append(l)
        depth += l.count("[") + l.count("{") - l.count("]") - l.count("}")
    root: dict = {}
    stack: list[tuple[int, object]] = [(-1, root)]
    last_key: dict[int, tuple[dict, str]] = {}
    for l in joined:
        indent = len(l) - len(l.lstrip())
        body = l.strip()
        while len(stack) > 1 and stack[-1][0] >= indent:
            stack.pop()
        parent = stack[-1][1]
        if body.startswith("- "):
            item = body[2:].strip()
            if isinstance(parent, dict):
                # a block list under the last key of this mapping
                owner, key = last_key[id(parent)]
                if not isinstance(owner.get(key), list):
                    owner[key] = []
                parent = owner[key]
                stack.append((indent - 1, parent))
            parent.append(_flow(item) if item[:1] in "[{" else _scalar(item))
            continue
        m = re.match(r"([^:]+):\s*(.*)$", body)
        if not m or not isinstance(parent, dict):
            raise CatalogError(f"cannot parse line {l!r}")
        key, rest = m.group(1).strip(), m.group(2).strip()
        if rest == "":
            parent[key] = {}
            last_key[id(parent)] = (parent, key)
            stack.append((indent, parent[key]))
            last_key[id(parent[key])] = (parent, key)
        else:
            parent[key] = _flow(rest) if rest[:1] in "[{" else _scalar(rest)
            last_key[id(parent)] = (parent, key)
    # Empty nested mappings that were really block lists were replaced in place; normalize empty dicts left over.
    return root


def load_dir(catalog_dir: Path) -> dict[str, dict]:
    out = {}
    for p in sorted(Path(catalog_dir).glob("*.yaml")):
        data = parse(p.read_text(encoding="utf-8"))
        out[data.get("name") or p.stem] = data
    return out


def _list(v) -> list:
    if isinstance(v, list):
        return [x for x in v if x is not None]
    return []


class Catalog:
    """Index of the catalog: hosts, env aliases and topics → (service, api/event)."""

    def __init__(self, services: dict[str, dict], me: str = "orders-service"):
        self.services, self.me = services, me
        self.host_owner: dict[str, tuple[str, str]] = {}
        self.env_owner: dict[str, tuple[str, str]] = {}
        self.topic_owner: dict[str, tuple[str, str]] = {}
        for name, s in services.items():
            prov = s.get("provides") or {}
            for api in _list(prov.get("apis")):
                if isinstance(api, dict):
                    if api.get("host"):
                        self.host_owner[str(api["host"]).lower()] = (name, str(api.get("name")))
                    for alias in _list(api.get("envAliases")):
                        self.env_owner[str(alias)] = (name, str(api.get("name")))
            for ev in _list(prov.get("events")):
                if isinstance(ev, dict) and ev.get("topic"):
                    self.topic_owner[str(ev["topic"])] = (name, str(ev.get("name")))
        mine = services.get(me) or {}
        self.declared_apis = {(str(d.get("service")), str(d.get("api"))) for d in _list(mine.get("dependsOn"))
                              if isinstance(d, dict)}
        self.declared_hosts = {str(d.get("host")).lower() for d in _list(mine.get("dependsOn"))
                               if isinstance(d, dict) and d.get("host")}
        self.declared_events = {(str(c.get("service")), str(c.get("event"))) for c in _list(mine.get("consumes"))
                                if isinstance(c, dict)}
        self.own_hosts = {h for h, (svc, _) in self.host_owner.items() if svc == me}
        self.own_topics = {t for t, (svc, _) in self.topic_owner.items() if svc == me}
        self.service_names = sorted(services)
        self.owners = sorted({str(s.get("owner")) for s in services.values() if s.get("owner")})

    def host_allowed(self, host: str) -> bool:
        host = host.lower()
        if host in self.own_hosts or host in self.declared_hosts:
            return True
        owner = self.host_owner.get(host)
        return owner is not None and owner in self.declared_apis

    def env_allowed(self, name: str) -> bool:
        owner = self.env_owner.get(name)
        return owner is not None and (owner[0] == self.me or owner in self.declared_apis)
