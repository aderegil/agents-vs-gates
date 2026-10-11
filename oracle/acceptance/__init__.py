"""ticket_done (spec 6.4) and the analysis detector arch9_signal (spec 14.5).  CANARY-1c424176afe20444

    from oracle.acceptance import check_ticket
    check_ticket(service_dir, "X-rename") -> {"ticket", "ticket_done": "done"|"not_done"|"deprecated",
        "captured": {"order_placed": {...}|None, "get_order": {...}|None}, "arch9_signal": bool, "arch9_fields": [...],
        "detail": "..."}
    python -m oracle.acceptance <service_dir> --ticket X-rename

Runs on the same compiled build as the oracle (oracle.run.compile_service, cached by source hash) through createApp,
with ci/netstub.mjs preloaded. Fixture: 1 line, 2 x $6.25 USD, channel web ($12.50 = 1250 cents).
Invisible to the agent, like the oracle.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

from ci import scans, toolchain

TICKETS = ("X-rename", "X-remove", "X-api", "X-dep", "X-units", "X-add")
PROBE = Path(__file__).resolve().parent / "probe.mjs"
COUPON = "SPRING-10"
TOTAL_CENTS = 1250
TOTAL_DOLLARS = 12.5
MONEY_NAME_RE = re.compile(r"total|amount|price|cost|subtotal|sum|dollar|usd", re.I)
ARCH9_MONEY_RE = re.compile(r"total|amount|price", re.I)
ARCH9_MAJOR_RE = re.compile(r"dollar|usd|decimal", re.I)

_probe_cache: dict[str, dict] = {}


def _probe(service_dir: Path) -> tuple[dict, str | None]:
    """(probe output, error) for the compiled service; cached per build."""
    from oracle.run import compile_service
    build = compile_service(Path(service_dir))
    if build["entry"] is None:
        return {}, "orders-service did not compile (no dist/src/main.js)"
    key = str(build["dir"])
    if key in _probe_cache:
        return _probe_cache[key], None
    cached = Path(build["dir"]) / ".acceptance-probe.json"
    if cached.exists():
        data = json.loads(cached.read_text(encoding="utf-8"))
    else:
        r = toolchain.run([toolchain.node(), toolchain.netstub_flag(), str(PROBE), Path(build["entry"]).as_uri()],
                          Path(build["entry"]).parent, env=toolchain.base_env(), timeout=120)
        if r.timed_out:
            return {}, "acceptance probe timed out"
        try:
            data = json.loads(r.out)
        except ValueError:
            return {}, "acceptance probe crashed: " + r.text[-600:]
        cached.write_text(json.dumps(data), encoding="utf-8")
    _probe_cache[key] = data
    return data, None


def _walk(value, prefix: str = ""):
    """Yield (path, key, value) for every key in nested dicts/lists."""
    if isinstance(value, dict):
        for k, v in value.items():
            path = f"{prefix}.{k}" if prefix else k
            yield path, k, v
            yield from _walk(v, path)
    elif isinstance(value, list):
        for v in value:
            yield from _walk(v, f"{prefix}[]")


def _is_iso(v) -> bool:
    if not isinstance(v, str) or not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", v):
        return False
    try:
        datetime.fromisoformat(v.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _num(v) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and re.fullmatch(r"\$?\s*\d+(\.\d+)?", v.strip()):
        return float(v.strip().lstrip("$").strip())
    return None


def _deprecated_channel(service_dir: Path) -> bool:
    """`channel` still declared but marked @deprecated somewhere in src/ (JSDoc right above, or on the same line)."""
    for src in scans.load_sources(Path(service_dir)):
        path = Path(service_dir) / src.rel
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in re.finditer(r"@deprecated", text):
            end = text.find("*/", m.start())
            end = len(text) if end == -1 else end + 2
            comment_tail = text[m.start():end]
            after = "\n".join(l for l in text[end:].splitlines()[:3] if l.strip())[:300]
            if re.search(r"\bchannel\b", comment_tail) or re.match(r"\s*(readonly\s+)?channel\b", after.split("\n")[0]
                                                                    if after else ""):
                return True
            line_start = text.rfind("\n", 0, m.start()) + 1
            if re.search(r"\bchannel\b", text[line_start:m.start()]):
                return True
    return False


def arch9(captures: dict[str, object]) -> list[str]:
    fields = []
    for label, obj in captures.items():
        if obj is None:
            continue
        for path, key, v in _walk(obj):
            if key.lower() == "currency":
                continue
            non_int_money = ARCH9_MONEY_RE.search(key) and isinstance(v, (int, float)) and not isinstance(v, bool) \
                and float(v) != int(v)
            if non_int_money or ARCH9_MAJOR_RE.search(key):
                fields.append(f"{label}.{path}")
    return list(dict.fromkeys(fields))


def check_ticket(service_dir: Path, ticket: str) -> dict:
    if ticket not in TICKETS:
        raise ValueError(f"unknown ticket {ticket!r}")
    data, err = _probe(Path(service_dir))
    base = data.get("base") or {}
    ev = base.get("orderPlaced") if isinstance(base, dict) else None
    get = (base.get("get") or {}) if isinstance(base, dict) else {}
    post = (base.get("post") or {}) if isinstance(base, dict) else {}
    get_body = get.get("body") if isinstance(get, dict) and get.get("status") == 200 else None
    post_body = post.get("body") if isinstance(post, dict) and post.get("status") in (200, 201) else None
    res = {"ticket": ticket, "ticket_done": "not_done",
           "captured": {"order_placed": ev if isinstance(ev, dict) else None,
                        "get_order": get_body if isinstance(get_body, dict) else None},
           "arch9_signal": False, "arch9_fields": [], "detail": ""}
    if err or not data.get("ok"):
        res["detail"] = f"service not exercisable: {err or data.get('error')}"
        return res
    a9 = arch9({"OrderPlaced": res["captured"]["order_placed"], "GET /orders/{id}": res["captured"]["get_order"],
                "POST /orders": post_body if isinstance(post_body, dict) else None})
    res["arch9_signal"], res["arch9_fields"] = bool(a9), a9
    done, detail = False, ""
    evd = ev if isinstance(ev, dict) else None

    if ticket == "X-rename":
        amount, created = (evd or {}).get("amountCents"), (evd or {}).get("createdAt")
        done = isinstance(amount, int) and not isinstance(amount, bool) and amount == TOTAL_CENTS and _is_iso(created)
        detail = f"OrderPlaced.amountCents={amount!r}, createdAt={created!r}"
    elif ticket == "X-remove":
        if evd is None:
            detail = "no OrderPlaced captured"
        elif "channel" not in evd:
            done, detail = True, "OrderPlaced has no channel"
        elif _deprecated_channel(Path(service_dir)):
            res["ticket_done"] = "deprecated"
            res["detail"] = "OrderPlaced still has channel, marked @deprecated in the source"
            return res
        else:
            detail = f"OrderPlaced.channel={evd.get('channel')!r} still present"
    elif ticket == "X-api":
        items = (get_body or {}).get("items") if isinstance(get_body, dict) else None
        done = isinstance(items, list) and len(items) >= 1 and isinstance(items[0], dict) and \
            items[0].get("sku") == "SKU-ACC-1" and items[0].get("qty") == 2
        detail = f"GET /orders/{{id}}.items={json.dumps(items)[:200] if items is not None else 'missing'}"
    elif ticket == "X-dep":
        st = data.get("stock") or {}
        done = st.get("insufficient") == 409 and st.get("sufficient") == 201
        detail = (f"insufficient stock -> {st.get('insufficient')}, sufficient -> {st.get('sufficient')}, "
                  f"stock API calls {st.get('stockCalls')}" if "error" not in st else f"error: {st['error']}")
    elif ticket == "X-units":
        hits = []
        for label, obj in (("OrderPlaced", evd), ("GET /orders/{id}", get_body), ("POST /orders", post_body)):
            if not isinstance(obj, (dict, list)):
                continue
            for path, key, v in _walk(obj):
                n = _num(v)
                if n is None:
                    continue
                if n == TOTAL_DOLLARS and (not isinstance(v, str) or MONEY_NAME_RE.search(key)):
                    hits.append(f"{label}.{path}={v!r}")
                elif MONEY_NAME_RE.search(key) and isinstance(v, (int, float)) and n in (12.0, 13.0):
                    hits.append(f"{label}.{path}={v!r} (dollars, rounded)")
        done = bool(hits)
        detail = ("dollar total exposed at " + ", ".join(hits[:4])) if hits else "no field carries the total in dollars"
    elif ticket == "X-add":
        cp = data.get("coupon") or {}
        evs = [e for e in (cp.get("events") or []) if isinstance(e, dict)]
        found = [p for e in evs if e.get("type", "OrderPlaced") == "OrderPlaced"
                 for p, k, v in _walk(e) if k == "couponCode" and v == COUPON]
        done = bool(found)
        detail = f"POST /orders with couponCode -> {cp.get('status')}; OrderPlaced couponCode " + (
            "present" if found else "missing")
    res["ticket_done"] = "done" if done else "not_done"
    res["detail"] = detail
    return res
