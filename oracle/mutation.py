"""Mutation test: CI vs. oracle (spec 8.4). Deterministic, zero model calls.

    python -m oracle.mutation [--jobs N] [--only ID,ID]

Mutates the `OrderPlaced` (and a few `OrderCancelled`) events and the `GET /orders/{id}` response that the canonical
orders-service emits, through a wrapping publisher and handler (oracle/mutant_wrapper.mjs; the service code is not
touched). Each mutant runs CI's ARCH-4 and ARCH-8 (ci/verify-contracts.mjs against the central broker, as in V0) and
the three oracle suites. Writes results/mutation-matrix.md and results/mutation-matrix.json: a confusion matrix
(CI catches / misses × oracle catches / misses) with the mutants in each cell.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from ci import toolchain
from ci.run import ARCH_SRC, _is_rest
from harness import paths
from oracle import run as oracle_run

WRAPPER = Path(__file__).resolve().parent / "mutant_wrapper.mjs"

EVENT_FIELDS = {  # path -> rename target
    "orderId": "id", "customerId": "customer_id", "customerEmail": "email", "placedAt": "createdAt",
    "channel": "salesChannel", "currency": "currencyCode", "totalCents": "amountCents", "lines": "items",
    "lines[].sku": "productSku", "lines[].qty": "quantity", "lines[].unitPriceCents": "unitPrice",
}
REST_FIELDS = {
    "id": "orderId", "status": "state", "placedAt": "createdAt", "currency": "currencyCode",
    "totalCents": "amountCents", "lines": "items", "lines[].sku": "productSku", "lines[].name": "title",
    "lines[].qty": "quantity", "lines[].unitPriceCents": "unitPrice",
}


def _m(mid: str, family: str, target: str, desc: str, ops: list[dict], event: str = "OrderPlaced") -> dict:
    spec = {"target": target, "ops": ops}
    if target == "event":
        spec["event"] = event
    return {"id": mid, "family": family, "target": "none" if target == "none" else
            (event if target == "event" else "GET /orders/{id}"), "description": desc, "spec": spec}


def mutants() -> list[dict]:
    out = [_m("control", "control", "none", "no mutation (sanity control)", [])]
    for tgt, fields, tag in (("event", EVENT_FIELDS, "ev"), ("rest", REST_FIELDS, "rest")):
        for path, to in fields.items():
            out.append(_m(f"{tag}-rename-{path}", "rename", tgt, f"rename {path} -> {to}",
                          [{"op": "rename", "path": path, "to": to}]))
        for path in fields:
            out.append(_m(f"{tag}-remove-{path}", "remove", tgt, f"remove {path}", [{"op": "remove", "path": path}]))
    # change the type
    for mid, tgt, path, op, desc in [
        ("ev-type-orderId-number", "event", "orderId", {"op": "set", "value": 12345}, "orderId as a number"),
        ("ev-type-customerId-number", "event", "customerId", {"op": "set", "value": 42}, "customerId as a number"),
        ("ev-type-totalCents-string", "event", "totalCents", {"op": "map", "fn": "string"}, "totalCents as a string"),
        ("ev-type-qty-string", "event", "lines[].qty", {"op": "map", "fn": "string"}, "lines[].qty as a string"),
        ("ev-type-unitPrice-string", "event", "lines[].unitPriceCents", {"op": "map", "fn": "string"},
         "lines[].unitPriceCents as a string"),
        ("ev-type-currency-object", "event", "currency", {"op": "map", "fn": "wrap_object"}, "currency wrapped in an object"),
        ("ev-type-lines-object", "event", "lines", {"op": "map", "fn": "wrap_object"}, "lines wrapped in an object"),
        ("rest-type-id-number", "rest", "id", {"op": "set", "value": 12345}, "id as a number"),
        ("rest-type-totalCents-string", "rest", "totalCents", {"op": "map", "fn": "string"}, "totalCents as a string"),
        ("rest-type-qty-string", "rest", "lines[].qty", {"op": "map", "fn": "string"}, "lines[].qty as a string"),
        ("rest-type-unitPrice-string", "rest", "lines[].unitPriceCents", {"op": "map", "fn": "string"},
         "lines[].unitPriceCents as a string"),
        ("rest-type-status-boolean", "rest", "status", {"op": "map", "fn": "boolean"}, "status as a boolean"),
    ]:
        out.append(_m(mid, "type", tgt, desc, [{**op, "path": path}]))
    # optional / null
    for tgt, tag, fields in (("event", "ev", ["totalCents", "currency", "channel", "placedAt", "customerEmail", "lines",
                                              "lines[].sku"]),
                             ("rest", "rest", ["totalCents", "currency", "lines", "status", "lines[].name"])):
        for path in fields:
            out.append(_m(f"{tag}-null-{path}", "null", tgt, f"{path} = null",
                          [{"op": "set", "path": path, "value": None}]))
    # units
    for mid, tgt, path, fn, desc in [
        ("ev-units-total-x100", "event", "totalCents", "x100", "totalCents x100"),
        ("ev-units-total-div100", "event", "totalCents", "div100", "totalCents /100 (dollars)"),
        ("ev-units-total-round", "event", "totalCents", "round_div100", "totalCents in rounded dollars"),
        ("ev-units-total-floor", "event", "totalCents", "floor_div100", "totalCents in truncated dollars"),
        ("ev-units-price-div100", "event", "lines[].unitPriceCents", "div100", "lines[].unitPriceCents /100"),
        ("rest-units-total-x100", "rest", "totalCents", "x100", "totalCents x100"),
        ("rest-units-total-div100", "rest", "totalCents", "div100", "totalCents /100 (dollars)"),
        ("rest-units-total-round", "rest", "totalCents", "round_div100", "totalCents in rounded dollars"),
        ("rest-units-price-div100", "rest", "lines[].unitPriceCents", "div100", "lines[].unitPriceCents /100"),
        ("rest-units-price-round", "rest", "lines[].unitPriceCents", "round_div100",
         "lines[].unitPriceCents in rounded dollars"),
    ]:
        out.append(_m(mid, "units", tgt, desc, [{"op": "map", "path": path, "fn": fn}]))
    # date format
    for tgt, tag, fns in (("event", "ev", ["date_only", "epoch_ms", "epoch_s", "utc_string", "no_zone", "us_date"]),
                          ("rest", "rest", ["date_only", "epoch_ms", "utc_string"])):
        for fn in fns:
            out.append(_m(f"{tag}-date-{fn}", "date", tgt, f"placedAt as {fn}",
                          [{"op": "map", "path": "placedAt", "fn": fn}]))
    out.append(_m("cancel-date-date_only", "date", "event", "OrderCancelled.cancelledAt as date only",
                  [{"op": "map", "path": "cancelledAt", "fn": "date_only"}], event="OrderCancelled"))
    out.append(_m("cancel-rename-cancelledAt", "rename", "event", "OrderCancelled: rename cancelledAt -> createdAt",
                  [{"op": "rename", "path": "cancelledAt", "to": "createdAt"}], event="OrderCancelled"))
    out.append(_m("cancel-remove-cancelledAt", "remove", "event", "OrderCancelled: remove cancelledAt",
                  [{"op": "remove", "path": "cancelledAt"}], event="OrderCancelled"))
    # arrays
    for tgt, tag in (("event", "ev"), ("rest", "rest")):
        for fn in ("empty", "duplicate", "reverse"):
            out.append(_m(f"{tag}-array-lines-{fn}", "array", tgt, f"lines {fn}",
                          [{"op": "array", "path": "lines", "fn": fn}]))
    # currency
    for tgt, tag, vals in (("event", "ev", [("EUR", "set", "EUR"), ("lower", "map", "lower"), ("numeric", "set", "840"),
                                            ("symbol", "set", "$")]),
                           ("rest", "rest", [("EUR", "set", "EUR"), ("lower", "map", "lower")])):
        for name, op, val in vals:
            o = {"op": op, "path": "currency"}
            o["value" if op == "set" else "fn"] = val
            out.append(_m(f"{tag}-currency-{name}", "currency", tgt, f"currency -> {val}", [o]))
    # enum values and envelope
    out.append(_m("ev-enum-channel-upper", "type", "event", "channel upper-cased (WEB)",
                  [{"op": "map", "path": "channel", "fn": "upper"}]))
    out.append(_m("ev-enum-channel-online", "type", "event", "channel = online (not an allowed value)",
                  [{"op": "set", "path": "channel", "value": "online"}]))
    out.append(_m("ev-type-name", "rename", "event", "type OrderPlaced -> OrderCreated",
                  [{"op": "set", "path": "type", "value": "OrderCreated"}]))
    out.append(_m("ev-schemaVersion-4", "type", "event", "schemaVersion 3 -> 4",
                  [{"op": "set", "path": "schemaVersion", "value": 4}]))
    return out


def _run_ci_checks(wrapper: Path, env: dict, files: list[Path]) -> dict:
    argv = [toolchain.node(), toolchain.netstub_flag(), str(toolchain.CHECKER), "--main", str(wrapper), "--json"]
    for f in files:
        argv += ["--contract-file", str(f)]
    r = toolchain.run(argv, wrapper.parent, env=env, timeout=120)
    try:
        data = json.loads(r.out)
    except ValueError:
        return {"ARCH-4": "error", "ARCH-8": "error", "lines": [r.text[-400:]]}
    res = {}
    for rid in ("ARCH-4", "ARCH-8"):
        sts = [x["status"] for x in data.get("results") or [] if x.get("rule") == rid]
        res[rid] = "fail" if "fail" in sts else "error" if "error" in sts or not data["probe"]["ok"] else "pass"
    res["lines"] = [l for l in data.get("lines") or [] if " PASS " not in l]
    return res


def run_mutant(m: dict, wrapper: Path, target_url: str, modules: dict, files: list[Path]) -> dict:
    extra = {"AVG_MUTANT_TARGET": target_url, "AVG_MUTANT": json.dumps(m["spec"])}
    ci = _run_ci_checks(wrapper, toolchain.base_env(**extra), files)
    oracle = oracle_run.run_suites(wrapper, modules, extra)
    ci_caught = ci["ARCH-4"] != "pass" or ci["ARCH-8"] != "pass"
    oracle_failed = sorted(c for c, v in oracle["consumers"].items() if not v["ok"])
    return {**{k: m[k] for k in ("id", "family", "target", "description")}, "ops": m["spec"]["ops"],
            "ci": {"ARCH-4": ci["ARCH-4"], "ARCH-8": ci["ARCH-8"], "caught": ci_caught, "findings": ci["lines"][:6]},
            "oracle": {"caught": bool(oracle_failed), "failed": oracle_failed,
                       "messages": {c: oracle["consumers"][c]["message"][:300] for c in oracle_failed}}}


def cell(r: dict) -> str:
    return {(True, True): "both", (True, False): "ci_only", (False, True): "oracle_only",
            (False, False): "neither"}[(r["ci"]["caught"], r["oracle"]["caught"])]


def write_reports(results: list[dict], meta: dict) -> tuple[Path, Path]:
    root = paths.results_root()
    root.mkdir(parents=True, exist_ok=True)
    cells = {k: [r for r in results if cell(r) == k and r["id"] != "control"] for k in
             ("both", "ci_only", "oracle_only", "neither")}
    counts = {k: len(v) for k, v in cells.items()}
    families = sorted({r["family"] for r in results if r["id"] != "control"})
    by_family = {f: {k: sum(1 for r in v if r["family"] == f) for k, v in cells.items()} for f in families}
    data = {**meta, "counts": counts, "by_family": by_family, "cells": {k: [r["id"] for r in v] for k, v in cells.items()},
            "mutants": results}
    jpath = root / "mutation-matrix.json"
    jpath.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")

    n = sum(counts.values())
    L = ["# Mutation test: CI vs. staging oracle", "",
         f"Generated {meta['generated_at']} by `python -m oracle.mutation` (deterministic, 0 model calls). "
         f"{n} mutants of the canonical orders-service's `OrderPlaced` / `OrderCancelled` events and "
         f"`GET /orders/{{id}}` response, applied by a wrapping publisher and handler (service code untouched). "
         f"CI = ARCH-4 + ARCH-8 against the central broker; oracle = the three consumer suites. "
         f"Control mutant (no change): CI {'caught' if meta['control']['ci'] else 'passed'}, oracle "
         f"{'caught' if meta['control']['oracle'] else 'passed'}.", "",
         "## Confusion matrix", "",
         "| | Oracle catches | Oracle misses | Total |", "|---|---:|---:|---:|",
         f"| **CI catches** | {counts['both']} | {counts['ci_only']} | {counts['both'] + counts['ci_only']} |",
         f"| **CI misses** | {counts['oracle_only']} | {counts['neither']} | {counts['oracle_only'] + counts['neither']} |",
         f"| **Total** | {counts['both'] + counts['oracle_only']} | {counts['ci_only'] + counts['neither']} | {n} |", "",
         "## By family", "", "| Family | both | CI only | oracle only | neither |", "|---|---:|---:|---:|---:|"]
    for f in families:
        b = by_family[f]
        L.append(f"| {f} | {b['both']} | {b['ci_only']} | {b['oracle_only']} | {b['neither']} |")
    titles = {"both": "CI catches, oracle catches", "ci_only": "CI catches, oracle misses (CI stricter than the "
              "consumers' real needs)", "oracle_only": "CI misses, oracle catches (what CI does not see)",
              "neither": "CI misses, oracle misses (harmless to the deployed consumers)"}
    for k in ("oracle_only", "ci_only", "both", "neither"):
        L += ["", f"## {titles[k]} — {counts[k]}", ""]
        if not cells[k]:
            L.append("(none)")
            continue
        L += ["| Mutant | Family | Target | Change | CI | Oracle failed |", "|---|---|---|---|---|---|"]
        for r in cells[k]:
            ci_txt = ", ".join(f"{c} {r['ci'][c]}" for c in ("ARCH-4", "ARCH-8") if r["ci"][c] != "pass") or "pass"
            L.append(f"| `{r['id']}` | {r['family']} | {r['target']} | {r['description']} | {ci_txt} | "
                     f"{', '.join(r['oracle']['failed']) or '—'} |")
    mpath = root / "mutation-matrix.md"
    mpath.write_text("\n".join(L) + "\n", encoding="utf-8", newline="\n")
    return mpath, jpath


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m oracle.mutation")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--only", help="comma-separated mutant ids (debugging; does not write the report)")
    a = ap.parse_args(argv)
    t0 = time.monotonic()
    build = oracle_run.compile_service(paths.REPOS / "orders-service")
    if build["entry"] is None:
        print("canonical orders-service did not compile", file=sys.stderr)
        return 1
    modules = oracle_run.consumer_modules()
    work = Path(build["dir"]) / "mutation"
    work.mkdir(exist_ok=True)
    wrapper = work / "mutant_wrapper.mjs"
    shutil.copyfile(WRAPPER, wrapper)
    files = sorted((ARCH_SRC / "broker").glob("*.json"))
    files = [f for f in files if not _is_rest(f)] + [f for f in files if _is_rest(f)]
    todo = mutants()
    if a.only:
        keep = set(a.only.split(","))
        todo = [m for m in todo if m["id"] in keep or m["id"] == "control"]
    target_url = Path(build["entry"]).as_uri()
    with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as pool:
        results = list(pool.map(lambda m: run_mutant(m, wrapper, target_url, modules, files), todo))
    for r in results:
        print(f"{cell(r):<12} {r['id']:<34} CI {r['ci']['ARCH-4']}/{r['ci']['ARCH-8']}  oracle "
              f"{','.join(r['oracle']['failed']) or '-'}")
    control = next(r for r in results if r["id"] == "control")
    if control["ci"]["caught"] or control["oracle"]["caught"]:
        print("ERROR: the control mutant (no change) was caught; the harness is broken", file=sys.stderr)
        return 1
    if a.only:
        return 0
    meta = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "service_build": Path(build["dir"]).name, "suites_dir": str(oracle_run.suites_dir()),
            "control": {"ci": control["ci"]["caught"], "oracle": control["oracle"]["caught"]}}
    mpath, jpath = write_reports(results, meta)
    print(f"wrote {mpath} and {jpath} ({len(results) - 1} mutants, {time.monotonic() - t0:.0f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
