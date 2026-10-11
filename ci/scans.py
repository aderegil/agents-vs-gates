"""Static source scans of CI (spec 7.2): ARCH-3 I/O outside adapters, ARCH-5 catalog, ARCH-6 PII, ARCH-7 data access.

Every finding is one line that starts with the rule ID, e.g.
`ARCH-5 FAIL src/adapters/httpStockGateway.ts:4: calls stock.inventory.internal (inventory-service stock-api), not declared ...`.
Comments are ignored; string literals are inspected only where the rule is about literals (hosts, URLs, topics).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from ci.catalog import Catalog

CODE_SUFFIXES = (".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs")


@dataclass
class Lit:
    text: str        # literal body (template: the whole body, `${...}` included)
    line: int
    template: bool


@dataclass
class Source:
    rel: str          # path relative to the service root, posix
    code: str         # comments removed, string bodies blanked (same length, newlines kept)
    code_with_strings: str   # comments removed, strings kept
    literals: list[Lit]

    def line_of(self, pos: int) -> int:
        return self.code.count("\n", 0, pos) + 1


def tokenize(text: str) -> tuple[str, str, list[Lit]]:
    """Single pass over TS/JS: strip comments, collect string/template literals. Regex literals are not special-cased
    (good enough for scanning; a `/` that starts a regex is treated as code)."""
    blank, keep, lits = [], [], []
    i, n, line = 0, len(text), 1
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if ch == "/" and nxt == "/":
            j = text.find("\n", i)
            j = n if j == -1 else j
            blank.append(" " * (j - i))
            keep.append(" " * (j - i))
            i = j
            continue
        if ch == "/" and nxt == "*":
            j = text.find("*/", i + 2)
            j = n if j == -1 else j + 2
            seg = re.sub(r"[^\n]", " ", text[i:j])
            blank.append(seg)
            keep.append(seg)
            line += seg.count("\n")
            i = j
            continue
        if ch in "'\"`":
            q, j, start_line = ch, i + 1, line
            depth = 0
            while j < n:
                c = text[j]
                if c == "\\":
                    j += 2
                    continue
                if q == "`" and c == "$" and j + 1 < n and text[j + 1] == "{":
                    depth += 1
                    j += 2
                    continue
                if q == "`" and c == "}" and depth > 0:
                    depth -= 1
                elif c == q and depth == 0:
                    break
                elif c == "\n" and q != "`":
                    break
                j += 1
            body = text[i + 1:j]
            lits.append(Lit(body, start_line, q == "`"))
            seg = text[i:j + 1]
            blank.append(q + re.sub(r"[^\n]", " ", body) + (q if j < n else ""))
            keep.append(seg)
            line += seg.count("\n")
            i = j + 1
            continue
        if ch == "\n":
            line += 1
        blank.append(ch)
        keep.append(ch)
        i += 1
    return "".join(blank), "".join(keep), lits


def load_sources(service_dir: Path, sub: str = "src") -> list[Source]:
    root = Path(service_dir)
    out = []
    base = root / sub
    if not base.exists():
        return out
    for p in sorted(base.rglob("*")):
        if not p.is_file() or not p.name.endswith(CODE_SUFFIXES) or "node_modules" in p.parts:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        code, kept, lits = tokenize(text)
        out.append(Source(p.relative_to(root).as_posix(), code, kept, lits))
    return out


# ---- ARCH-3: I/O outside adapters ---------------------------------------------------------------------------
IO_MODULES = r"(?:node:)?(?:http|https|net|tls)"
IO_IMPORT_RES = [
    re.compile(r"""\bfrom\s*(['"])""" + IO_MODULES + r"""\1"""),
    re.compile(r"""\bimport\s*(['"])""" + IO_MODULES + r"""\1"""),
    re.compile(r"""\b(?:require|import)\s*\(\s*(['"])""" + IO_MODULES + r"""\1\s*\)"""),
]
FETCH_CALL_RE = re.compile(r"(?<![\w$.])(?:(?:globalThis|window|self|global)\s*\.\s*)?fetch\s*\(")
FETCH_MEMBER_RE = re.compile(r"(?<![\w$])(?:globalThis|window|self|global)\s*\.\s*fetch\s*\(")


def scan_io(sources: list[Source]) -> list[str]:
    out = []
    for s in sources:
        if s.rel.startswith("src/adapters/"):
            continue
        for rx in IO_IMPORT_RES:
            for m in rx.finditer(s.code_with_strings):
                out.append(f"ARCH-3 FAIL {s.rel}:{s.line_of(m.start())}: imports {m.group(0).strip()} outside "
                           f"src/adapters/ (only adapters do I/O)")
        for rx in (FETCH_CALL_RE, FETCH_MEMBER_RE):
            for m in rx.finditer(s.code):
                out.append(f"ARCH-3 FAIL {s.rel}:{s.line_of(m.start())}: calls fetch() outside src/adapters/ "
                           f"(only adapters do I/O)")
    return list(dict.fromkeys(out))


# ---- ARCH-5: outgoing calls vs. catalog ---------------------------------------------------------------------
HOST_RE = re.compile(r"(?<![a-z0-9.-])((?:[a-z0-9-]+\.)+internal)(?![a-z0-9-])", re.I)
ENV_DOT_RE = re.compile(r"\bprocess\s*\.\s*env\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)")
ENV_IDX_RE = re.compile(r"""\bprocess\s*\.\s*env\s*\[\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]""")
ENV_DESTRUCT_RE = re.compile(r"\{([^{}]*)\}\s*=\s*process\s*\.\s*env\b")
ENV_URL_RE = re.compile(r"(_URL|_HOST|_BASE_URL)$")


def scan_catalog(sources: list[Source], cat: Catalog) -> list[str]:
    out = []
    for s in sources:
        for lit in s.literals:
            for m in HOST_RE.finditer(lit.text):
                host = m.group(1).lower()
                if cat.host_allowed(host):
                    continue
                owner = cat.host_owner.get(host)
                what = f"{owner[0]} {owner[1]}" if owner else "not in the catalog"
                out.append(f"ARCH-5 FAIL {s.rel}:{lit.line}: calls {host} ({what}), not declared in "
                           f"catalog/{cat.me}.yaml dependsOn")
            if lit.text in cat.topic_owner and lit.text not in cat.own_topics:
                svc, ev = cat.topic_owner[lit.text]
                if (svc, ev) not in cat.declared_events:
                    out.append(f"ARCH-5 FAIL {s.rel}:{lit.line}: uses topic {lit.text} ({svc} {ev}), not declared "
                               f"in catalog/{cat.me}.yaml consumes")
        names: list[tuple[str, int]] = []
        for m in ENV_DOT_RE.finditer(s.code):
            names.append((m.group(1), s.line_of(m.start())))
        for m in ENV_IDX_RE.finditer(s.code_with_strings):
            names.append((m.group(2), s.line_of(m.start())))
        for m in ENV_DESTRUCT_RE.finditer(s.code):
            for part in m.group(1).split(","):
                name = part.split(":")[0].split("=")[0].strip()
                if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name or ""):
                    names.append((name, s.line_of(m.start())))
        for name, line in names:
            if not ENV_URL_RE.search(name) or cat.env_allowed(name):
                continue
            owner = cat.env_owner.get(name)
            what = f"{owner[0]} {owner[1]}" if owner else "not mapped to any API in the catalog"
            out.append(f"ARCH-5 FAIL {s.rel}:{line}: reads env {name} ({what}), not declared in "
                       f"catalog/{cat.me}.yaml dependsOn")
    return list(dict.fromkeys(out))


# ---- ARCH-6: PII in event and response types -----------------------------------------------------------------
PII_RE = re.compile(r"email|phone|address|fullname|firstname|lastname", re.I)
TYPE_DECL_RE = re.compile(r"\b(?:interface\s+([A-Za-z_$][\w$]*)[^{=;]*\{|type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=\s*\{)")
PROP_RE = re.compile(r"(?:^|[{;,\s])(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:")


def contract_type_name(name: str, event_names: set[str]) -> bool:
    return name in event_names or bool(re.search(r"(Event|Response|Payload|Dto|DTO|Message)$", name)) or \
        any(name.startswith(e) for e in event_names)


def _block(code: str, open_pos: int) -> str:
    depth, i = 0, open_pos
    while i < len(code):
        if code[i] == "{":
            depth += 1
        elif code[i] == "}":
            depth -= 1
            if depth == 0:
                return code[open_pos + 1:i]
        i += 1
    return code[open_pos + 1:]


def pii_static(sources: list[Source], event_names: set[str]) -> dict[str, str]:
    """{"Type.field": "src/file.ts:line"} for PII-looking properties declared in event/response types."""
    out: dict[str, str] = {}
    for s in sources:
        for m in TYPE_DECL_RE.finditer(s.code):
            name = m.group(1) or m.group(2)
            if not contract_type_name(name, event_names):
                continue
            block = _block(s.code, m.end() - 1)
            for pm in PROP_RE.finditer(block):
                prop = pm.group(1)
                if PII_RE.search(prop):
                    out.setdefault(f"{name}.{prop}", f"{s.rel}:{s.line_of(m.start())}")
    return out


def pii_dynamic(label: str, value, prefix: str = "") -> list[str]:
    found = []
    if isinstance(value, dict):
        for k, v in value.items():
            path = f"{prefix}.{k}" if prefix else k
            if PII_RE.search(k):
                found.append(f"{label}.{path}")
            found += pii_dynamic(label, v, path)
    elif isinstance(value, list):
        for v in value:
            found += pii_dynamic(label, v, f"{prefix}[]")
    return list(dict.fromkeys(found))


# ---- ARCH-7: another service's database ----------------------------------------------------------------------
CONN_RES = [
    re.compile(r"\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|mssql|sqlserver|oracle|cockroachdb|"
               r"couchdb|cassandra|neo4j|clickhouse)://", re.I),
    re.compile(r"\bjdbc:[a-z0-9]+:", re.I),
    re.compile(r"\b(?:Server|Data Source|Host)\s*=[^;]+;\s*(?:Database|Initial Catalog)\s*=", re.I),
]
DB_DRIVERS = ("pg", "pg-pool", "postgres", "mysql", "mysql2", "mariadb", "mongodb", "mongoose", "redis", "ioredis",
              "sqlite3", "better-sqlite3", "node:sqlite", "tedious", "mssql", "oracledb", "knex", "sequelize", "typeorm",
              "@prisma/client", "drizzle-orm", "cassandra-driver", "neo4j-driver", "@clickhouse/client")
DRIVER_RE = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(""" +
                       "|".join(re.escape(d) for d in DB_DRIVERS) + r""")(?:/[^'"]*)?\1""")


def scan_data_access(sources: list[Source], cat: Catalog) -> list[str]:
    out = []
    others = [n for n in cat.service_names if n != cat.me]
    stems = sorted({n.split("-")[0] for n in others})
    for s in sources:
        for lit in s.literals:
            for rx in CONN_RES:
                if rx.search(lit.text):
                    hit = next((st for st in stems if re.search(rf"(?<![a-z]){re.escape(st)}", lit.text, re.I)), None)
                    whose = f"looks like {hit}'s database" if hit else f"{cat.me} owns no database in the catalog"
                    shown = re.sub(r"//([^:@/]+):([^@/]+)@", r"//\1:***@", lit.text)[:100]
                    out.append(f"ARCH-7 FAIL {s.rel}:{lit.line}: database connection string {shown!r} ({whose}); "
                               f"no service reads another service's database")
                    break
        for m in DRIVER_RE.finditer(s.code_with_strings):
            out.append(f"ARCH-7 FAIL {s.rel}:{s.line_of(m.start())}: imports database client {m.group(2)!r}; "
                       f"{cat.me} owns no database in the catalog and must not read another service's database")
    return list(dict.fromkeys(out))
