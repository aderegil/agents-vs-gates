"""Scenario plugin API (spec §22.7): read-only view of the committed `scenario/` folder (Meridian Retail).

GET /api/scenario/repos     flat file listing of scenario/repos/* (node_modules, dist, .ci-build, .git excluded)
GET /api/scenario/file?path=<repo>/<file>   one file, confined to scenario/repos (no traversal, no symlinks), capped
GET /api/scenario/rules     the ARCH-n table parsed from architecture/ARCHITECTURE-RULES.md (+ ADRs, PII baseline)
GET /api/scenario/catalog   services, APIs, events + producers/consumers (catalog YAMLs, via miniyaml) and a graph
GET /api/scenario/tickets   base ticket texts, the W2 wording and paraphrases p1..p5 with their status
GET /api/scenario/contexts  S0/S1/S2 with word counts and the fairness rule (§5.7)
GET /api/scenario/broker    consumer contracts (architecture/broker/*.json) and the field-usage matrix

Nothing here writes, spawns or calls a model. Canary lines (CANARY-…) are shown in the viewers (internal console) but
never counted as words in Tickets / Contexts.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from console.core.plugin_api import ApiError

from . import miniyaml

EXCLUDED_DIRS = {"node_modules", "dist", ".ci-build", ".git"}
MAX_FILE_BYTES = 512 * 1024
FAIRNESS_LIMIT = 0.20          # S1 and S2 added sections within ±20 % of each other (§5.7)
FAIRNESS_NEAR = 0.15           # amber from here up to the limit
CANARY = re.compile(r"CANARY-[0-9a-fA-F]+")
TICKET_ORDER = ["X-rename", "X-remove", "X-api", "X-dep", "X-units", "X-add"]
TICKET_NOTES = {"X-add": "control"}
LANGS = {".ts": "ts", ".tsx": "ts", ".js": "ts", ".mjs": "ts", ".cjs": "ts", ".json": "json", ".yaml": "yaml",
         ".yml": "yaml", ".md": "md"}


def scenario_root(ctx) -> Path:
    return Path(ctx.repo) / "scenario"


# --------------------------------------------------------------------------------------------- file confinement

def lang_of(name: str) -> str:
    return LANGS.get(Path(name).suffix.lower(), "text")


def _is_link(p: Path) -> bool:
    """Symlink or Windows junction (Path.is_junction is 3.12+)."""
    try:
        if p.is_symlink():
            return True
        j = getattr(p, "is_junction", None)
        return bool(j and j())
    except OSError:
        return True


def safe_repo_file(repos: Path, rel: str) -> Path:
    """Resolve `rel` (a '/'-separated path below scenario/repos) or raise ApiError. Strict on purpose: no absolute
    paths, drive letters, backslashes, '..', NUL, ':' (NTFS streams), excluded folders, links of any kind."""
    if not isinstance(rel, str) or not rel or len(rel) > 400:
        raise ApiError(400, "path is required")
    if "\x00" in rel or "\\" in rel or ":" in rel or rel.startswith("/"):
        raise ApiError(400, "invalid path")
    parts = rel.split("/")
    for part in parts:
        if part in ("", ".", "..") or part != part.strip() or part.endswith("."):
            raise ApiError(400, "invalid path")
        if part.lower() in EXCLUDED_DIRS:
            raise ApiError(404, "not found")
    root = repos.resolve()
    cur = repos
    for part in parts:
        cur = cur / part
        if _is_link(cur):
            raise ApiError(400, "links are not followed")
    try:
        resolved = cur.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ApiError(404, "not found")
    try:
        resolved.relative_to(root)
    except ValueError:
        raise ApiError(400, "invalid path")
    if not resolved.is_file():
        raise ApiError(404, "not found")
    return resolved


def list_repos(repos: Path) -> list[dict]:
    """[{name, files:[{path, size}]}] — walk without following links, skipping excluded folders."""
    out = []
    if not repos.is_dir():
        return out
    for repo in sorted(p for p in repos.iterdir() if p.is_dir() and not _is_link(p) and p.name not in EXCLUDED_DIRS):
        files = []
        for dirpath, dirnames, filenames in os.walk(repo, followlinks=False):
            dirnames[:] = sorted(d for d in dirnames
                                 if d.lower() not in EXCLUDED_DIRS and not _is_link(Path(dirpath) / d))
            for fn in sorted(filenames):
                fp = Path(dirpath) / fn
                if _is_link(fp):
                    continue
                try:
                    size = fp.stat().st_size
                except OSError:
                    continue
                files.append({"path": fp.relative_to(repos).as_posix(), "size": size, "lang": lang_of(fn)})
        files.sort(key=lambda f: f["path"].lower())
        out.append({"name": repo.name, "files": files})
    return out


def read_text_capped(path: Path) -> dict:
    size = path.stat().st_size
    with open(path, "rb") as f:
        data = f.read(MAX_FILE_BYTES + 1)
    truncated = len(data) > MAX_FILE_BYTES
    data = data[:MAX_FILE_BYTES]
    if b"\x00" in data[:8192]:
        raise ApiError(415, "binary file")
    text = data.decode("utf-8", errors="replace").replace("\r\n", "\n")
    return {"size": size, "truncated": truncated, "content": text, "lines": text.count("\n") + (0 if text.endswith("\n") or not text else 1)}


# --------------------------------------------------------------------------------------------- text helpers

def count_words(text: str) -> int:
    """Whitespace-separated tokens, ignoring any line that carries a canary."""
    return sum(len(line.split()) for line in text.splitlines() if not CANARY.search(line))


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")


# --------------------------------------------------------------------------------------------- rules

def _split_row(line: str) -> list[str]:
    """Split a markdown table row on pipes that are not escaped (`\\|`) and not inside backticks."""
    cells, cur, in_code, i = [], [], False, 0
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    while i < len(line):
        ch = line[i]
        if ch == "\\" and line[i + 1:i + 2] == "|":
            cur.append("|")
            i += 2
            continue
        if ch == "`":
            in_code = not in_code
        if ch == "|" and not in_code:
            cells.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        i += 1
    cells.append("".join(cur).strip())
    return cells


def parse_rules(md: str) -> list[dict]:
    rules, header = [], None
    for line in md.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = _split_row(line)
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c) and any(cells):
            continue
        if header is None:
            header = [c.strip().lower() for c in cells]
            continue
        row = dict(zip(header, cells))
        rid = row.get("id", "")
        if not re.fullmatch(r"ARCH-\d+", rid):
            continue
        rules.append({"id": rid, "n": int(rid.split("-")[1]), "rule": row.get("rule", ""), "owner": row.get("owner", ""),
                      "enforced_by": row.get("enforced by", "")})
    return rules


def added_section(base: str, full: str) -> tuple[str, bool]:
    """(text S_n adds over S0, whether S_n literally starts with S0)."""
    b, f = base.rstrip(), full.rstrip()
    if f.startswith(b):
        return f[len(b):].strip("\n"), True
    # fall back to a line diff: keep lines of `full` that are not in `base`
    base_lines = set(base.splitlines())
    return "\n".join(ln for ln in full.splitlines() if ln not in base_lines).strip("\n"), False


def fairness(s1_words: int, s2_words: int) -> dict:
    """The §5.7 rule: S1 and S2 added sections must be within ±20 % of each other (spread measured against the
    shorter one, the stricter reading). pass < 15 %, warn 15–20 %, fail > 20 %."""
    lo, hi = min(s1_words, s2_words), max(s1_words, s2_words)
    spread = (hi - lo) / lo if lo else (0.0 if hi == 0 else float("inf"))
    if spread > FAIRNESS_LIMIT:
        tone, label = "fail", "Unfair"
    elif spread >= FAIRNESS_NEAR:
        tone, label = "warn", "Near the limit"
    else:
        tone, label = "pass", "Fair"
    return {"s1_added": s1_words, "s2_added": s2_words, "spread": None if spread == float("inf") else round(spread, 4),
            "limit": FAIRNESS_LIMIT, "near": FAIRNESS_NEAR, "tone": tone, "label": label, "ok": tone != "fail"}


# --------------------------------------------------------------------------------------------- catalog

def load_catalog(dirpath: Path) -> dict:
    services, errors = [], []
    for p in sorted(dirpath.glob("*.y*ml")):
        try:
            d = miniyaml.load(_read(p))
            if not isinstance(d, dict) or not d.get("name"):
                raise miniyaml.YamlError("no 'name'")
        except miniyaml.YamlError as e:
            errors.append({"file": p.name, "error": str(e)})
            continue
        prov = d.get("provides") or {}
        services.append({
            "name": d["name"], "owner": d.get("owner"), "file": p.name,
            "apis": [dict(a) for a in (prov.get("apis") or [])],
            "events": [dict(e) for e in (prov.get("events") or [])],
            "depends_on": [dict(x) for x in (d.get("dependsOn") or [])],
            "consumes": [dict(x) for x in (d.get("consumes") or [])],
        })
    return {"services": services, "errors": errors}


_HTTP = re.compile(r"^(GET|POST|PUT|PATCH|DELETE)\b")


def build_graph(services: list[dict], broker_contracts: list[dict]) -> dict:
    """Bipartite graph: service nodes and contract (API/event) nodes; provides / dependsOn / consumes edges.
    `in_broker` on a use-edge: the broker holds a consumer contract for it (events: same contract name; APIs: a REST
    contract of that consumer against the API's provider)."""
    nodes, edges, warnings = [], [], []
    broker_pairs = {(c["consumer"], c["contract"]) for c in broker_contracts}
    broker_rest = {(c["consumer"], c["provider"]) for c in broker_contracts if _HTTP.match(c["contract"])}
    contract_owner: dict[tuple[str, str], str] = {}
    for s in services:
        nodes.append({"id": f"svc:{s['name']}", "kind": "service", "label": s["name"], "owner": s["owner"],
                      "file": s["file"]})
    for s in services:
        for a in s["apis"]:
            cid = f"api:{a['name']}"
            contract_owner[("api", a["name"])] = s["name"]
            nodes.append({"id": cid, "kind": "api", "label": a["name"], "provider": s["name"], "version": a.get("version"),
                          "host": a.get("host")})
            edges.append({"from": f"svc:{s['name']}", "to": cid, "type": "provides"})
        for e in s["events"]:
            cid = f"evt:{e['name']}"
            contract_owner[("event", e["name"])] = s["name"]
            nodes.append({"id": cid, "kind": "event", "label": e["name"], "provider": s["name"], "version": e.get("version"),
                          "topic": e.get("topic")})
            edges.append({"from": f"svc:{s['name']}", "to": cid, "type": "provides"})
    for s in services:
        for d in s["depends_on"]:
            api = d.get("api")
            if ("api", api) not in contract_owner:
                warnings.append(f"{s['name']} dependsOn {api}, which no catalog entry provides")
                continue
            prov = contract_owner[("api", api)]
            if d.get("service") and d["service"] != prov:
                warnings.append(f"{s['name']} dependsOn {api} of {d['service']}, but {prov} provides it")
            edges.append({"from": f"api:{api}", "to": f"svc:{s['name']}", "type": "dependsOn",
                          "in_broker": (s["name"], prov) in broker_rest})
        for c in s["consumes"]:
            ev = c.get("event")
            if ("event", ev) not in contract_owner:
                warnings.append(f"{s['name']} consumes {ev}, which no catalog entry provides")
                continue
            prov = contract_owner[("event", ev)]
            if c.get("service") and c["service"] != prov:
                warnings.append(f"{s['name']} consumes {ev} from {c['service']}, but {prov} provides it")
            edges.append({"from": f"evt:{ev}", "to": f"svc:{s['name']}", "type": "consumes",
                          "in_broker": (s["name"], ev) in broker_pairs})
    return {"nodes": nodes, "edges": edges, "warnings": warnings}


# --------------------------------------------------------------------------------------------- broker

def load_broker(dirpath: Path) -> dict:
    contracts, errors = [], []
    for p in sorted(dirpath.glob("*.json")):
        try:
            d = json.loads(_read(p))
            req = d["requires"]
            if not isinstance(req, dict):
                raise ValueError("requires must be an object")
            contracts.append({
                "file": p.name, "consumer": d["consumer"], "provider": d["provider"], "contract": d["contract"],
                "deployed_version": d.get("deployedVersion"), "canary": d.get("_canary"),
                "requires": [{"field": k, "type": v} for k, v in req.items()],
            })
        except (ValueError, KeyError, TypeError) as e:
            errors.append({"file": p.name, "error": f"{type(e).__name__}: {e}"})
    groups: dict[tuple[str, str], list[dict]] = {}
    for c in contracts:
        groups.setdefault((c["provider"], c["contract"]), []).append(c)
    matrix = []
    for (provider, contract), cs in groups.items():
        consumers = sorted(c["consumer"] for c in cs)
        fields: dict[str, list[dict]] = {}
        for c in sorted(cs, key=lambda c: c["consumer"]):
            for r in c["requires"]:
                fields.setdefault(r["field"], []).append({"consumer": c["consumer"], "type": r["type"]})
        matrix.append({"provider": provider, "contract": contract, "consumers": consumers,
                       "fields": [{"field": f, "by": by} for f, by in fields.items()]})
    return {"contracts": contracts, "matrix": matrix, "errors": errors}


# --------------------------------------------------------------------------------------------- tickets

def load_tickets(tasks: Path) -> dict:
    def entry(p: Path, kind: str, **extra) -> dict:
        text = _read(p).strip()
        todo = "TODO(human)" in text
        return {"kind": kind, "file": p.name, "text": text, "todo": todo, "words": 0 if todo else count_words(text),
                "status": "todo" if todo and kind == "paraphrase" else "text", **extra}

    ids = {m.group(1) for p in tasks.glob("X-*.md") if (m := re.match(r"^(X-[a-z]+)(?:\.[^.]+)?\.md$", p.name))}
    ordered = [i for i in TICKET_ORDER if i in ids] + sorted(ids - set(TICKET_ORDER))
    tickets, written, expected = [], 0, 0
    for tid in ordered:
        base = tasks / f"{tid}.md"
        t = {"id": tid, "note": TICKET_NOTES.get(tid), "base": entry(base, "base") if base.exists() else None,
             "w2": None, "paraphrases": []}
        w2 = tasks / f"{tid}.W2.md"
        if w2.exists():
            t["w2"] = entry(w2, "w2")
        for n in range(1, 10):
            p = tasks / f"{tid}.p{n}.md"
            if p.exists():
                e = entry(p, "paraphrase", n=n)
                t["paraphrases"].append(e)
                expected += 1
                written += 0 if e["todo"] else 1
        tickets.append(t)
    return {"tickets": tickets, "paraphrases_expected": expected, "paraphrases_written": written,
            "todo_marker": "TODO(human)"}


# --------------------------------------------------------------------------------------------- contexts

def load_contexts(ctxdir: Path, readme: Path) -> dict:
    texts = {k: _read(ctxdir / f"{k}.md") for k in ("S0", "S1", "S2") if (ctxdir / f"{k}.md").exists()}
    if "S0" not in texts:
        return {"contexts": [], "fairness": None, "readme_equal": None}
    rd = _read(readme) if readme.exists() else None
    norm = lambda s: "\n".join(x.rstrip() for x in s.strip().splitlines())  # noqa: E731
    equal = rd is not None and norm(rd) == norm(texts["S0"])
    out = []
    for k, text in texts.items():
        if k == "S0":
            added, extends = "", True
            base = text
        else:
            added, extends = added_section(texts["S0"], text)
            base = texts["S0"].rstrip("\n") if extends else text
        out.append({
            "id": k, "text": text, "base_text": base, "added_text": added, "extends_s0": extends,
            "words": count_words(text), "lines": len(text.rstrip().splitlines()),
            "added_words": count_words(added), "arch_ids": sorted(set(re.findall(r"ARCH-\d+", text)) - (
                set(re.findall(r"ARCH-\d+", texts["S0"])) if k != "S0" else set()), key=lambda s: int(s[5:])),
            "canary_lines": sum(1 for ln in text.splitlines() if CANARY.search(ln)),
        })
    by = {c["id"]: c for c in out}
    fair = fairness(by["S1"]["added_words"], by["S2"]["added_words"]) if "S1" in by and "S2" in by else None
    return {"contexts": out, "fairness": fair, "readme_equal": equal, "readme_present": rd is not None}


# --------------------------------------------------------------------------------------------- register

def register(router, ctx):
    root = scenario_root(ctx)
    repos = root / "repos"
    arch = repos / "architecture"

    def get_repos(req):
        listing = list_repos(repos)
        owners = {s["name"]: s["owner"] for s in load_catalog(arch / "catalog")["services"]} if (arch / "catalog").is_dir() else {}
        for r in listing:
            r["owner"] = owners.get(r["name"])
            r["bytes"] = sum(f["size"] for f in r["files"])
        return {"repos": listing, "max_bytes": MAX_FILE_BYTES,
                "excluded": sorted(EXCLUDED_DIRS - {".git"}) + [".git"]}

    def get_file(req):
        rel = req.query.get("path", "")
        p = safe_repo_file(repos, rel)
        d = read_text_capped(p)
        d.update({"path": rel, "lang": lang_of(p.name), "max_bytes": MAX_FILE_BYTES,
                  "canary_lines": sum(1 for ln in d["content"].splitlines() if CANARY.search(ln))})
        return d

    def get_rules(req):
        p = arch / "ARCHITECTURE-RULES.md"
        if not p.exists():
            raise ApiError(404, "ARCHITECTURE-RULES.md not found")
        text = _read(p)
        rules = parse_rules(text)
        s2 = load_contexts(root / "context" / "orders-service", repos / "orders-service" / "README.md")
        carried = {c["id"]: set(re.findall(r"ARCH-\d+", c["added_text"])) for c in s2["contexts"]}
        for r in rules:
            r["in_s1"] = r["id"] in carried.get("S1", set())
            r["in_s2"] = r["id"] in carried.get("S2", set())
        title = next((ln[2:].strip() for ln in text.splitlines() if ln.startswith("# ")), "Architecture rules")
        adrs = []
        for a in sorted((arch / "adr").glob("*.md")) if (arch / "adr").is_dir() else []:
            h1 = next((ln[2:].strip() for ln in _read(a).splitlines() if ln.startswith("# ")), a.stem)
            adrs.append({"file": a.name, "title": h1, "path": f"architecture/adr/{a.name}"})
        pii = None
        if (arch / "pii-baseline.json").exists():
            try:
                pii = json.loads(_read(arch / "pii-baseline.json"))
            except ValueError:
                pii = None
        return {"title": title, "rules": rules, "adrs": adrs, "pii_baseline": pii,
                "source": "architecture/ARCHITECTURE-RULES.md"}

    def get_broker(req):
        if not (arch / "broker").is_dir():
            return {"contracts": [], "matrix": [], "errors": []}
        return load_broker(arch / "broker")

    def get_catalog(req):
        cat = load_catalog(arch / "catalog") if (arch / "catalog").is_dir() else {"services": [], "errors": []}
        broker = get_broker(req)
        graph = build_graph(cat["services"], broker["contracts"])
        # per-contract summary: provider and consumers, with broker coverage
        contracts = []
        for n in graph["nodes"]:
            if n["kind"] == "service":
                continue
            users = [e for e in graph["edges"] if e["from"] == n["id"] and e["type"] != "provides"]
            contracts.append({**n, "consumers": [{"service": e["to"][4:], "via": e["type"], "in_broker": e["in_broker"]} for e in users]})
        return {"services": cat["services"], "contracts": contracts, "graph": graph, "errors": cat["errors"]}

    def get_tickets(req):
        d = root / "tasks"
        return load_tickets(d) if d.is_dir() else {"tickets": [], "paraphrases_expected": 0, "paraphrases_written": 0,
                                                   "todo_marker": "TODO(human)"}

    def get_contexts(req):
        d = load_contexts(root / "context" / "orders-service", repos / "orders-service" / "README.md")
        d["source"] = "scenario/context/orders-service"
        return d

    router.get("/repos", get_repos)
    router.get("/file", get_file)
    router.get("/rules", get_rules)
    router.get("/catalog", get_catalog)
    router.get("/tickets", get_tickets)
    router.get("/contexts", get_contexts)
    router.get("/broker", get_broker)
