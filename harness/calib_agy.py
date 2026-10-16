"""C8 — calibration of the agy-flash unit (addendum 1): 5 real runs like P0, reported apart, never analysed as results.

  python -m harness.calib_agy --dry-run              what would run (no call)
  python -m harness.calib_agy --i-am-authorized      for each pending C8 run: quota readout, the run (runner, 1 worker),
                                                     quota readout; then the report. Alfredo's 🔒. Needs smoke-agy.json.
  python -m harness.calib_agy --report               rewrite the report from the archived C8 records (no call)

Writes results/<ns>/calibration-agy.md (Spanish, short: tokens per run, duration, whether it ended well, how much of
the Google AI Pro quota each run used, whether the quota holds 120 runs before 23 Oct, and the API-key cost for
reference) and results/<ns>/calibration-agy.json (the numbers and the raw quota readouts).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from harness import jsonio, manifest, paths
from harness.adapters import agy

DEADLINE = date(2026, 10, 23)          # P8 has to finish before this day (the numbers are due unblinded on 24 Oct)
WINDOW_H = 5                           # Google AI Pro quota window (renews every 5 hours; weekly cap not published)


def quota_home() -> Path:
    return paths.avg_root() / "cfg" / "quota-agy"


def _records(ns: str) -> list[dict]:
    out = []
    for r in manifest.calibration_runs(ns):
        rec = jsonio.read_json(paths.run_dir(ns, r["run_id"]) / "record.json")
        if rec:
            out.append(rec)
    return out


def _thinking(rec: dict) -> int:
    return sum(int((s.get("usage_extra") or {}).get("thinking_tokens") or 0) for s in rec.get("sessions", []))


def _total_reported(rec: dict) -> int:
    return sum(int((s.get("usage_extra") or {}).get("total_tokens") or 0) for s in rec.get("sessions", []))


def gemini_buckets(snap: dict) -> dict:
    """{"5h": remaining, "weekly": remaining} (fractions) of the "Gemini Models" group of a `/usage` readout (live
    shape, smoke 2026-10-16: data.command.data.groups[].buckets[] with window and remaining_fraction)."""
    groups = ((((snap or {}).get("data") or {}).get("command") or {}).get("data") or {}).get("groups") or []
    out = {}
    for g in groups:
        if "gemini models" in str(g.get("name", "")).lower():
            for b in g.get("buckets") or []:
                if b.get("window") in ("5h", "weekly") and isinstance(b.get("remaining_fraction"), (int, float)):
                    out[b["window"]] = float(b["remaining_fraction"])
    return out


def _quota_used(q: dict) -> dict:
    """{"5h": used, "weekly": used}: fraction of each Gemini window one run used (before - after). Readouts without
    the live shape fall back to the first remaining-looking field, counted as the 5-hour window."""
    b, a = gemini_buckets(q.get("before") or {}), gemini_buckets(q.get("after") or {})
    if b and a:
        return {w: round(b[w] - a[w], 4) for w in b if w in a}
    b, a = agy.quota_percents(q.get("before") or {}), agy.quota_percents(q.get("after") or {})
    for k in b:
        if k in a and "remaining" in k.lower():
            scale = 100.0 if max(b[k], a[k]) > 1.0 else 1.0
            return {"5h": round((b[k] - a[k]) / scale, 4)}
    return {}


def summarize(ns: str = "real", prices: dict | None = None, today: date | None = None) -> dict:
    recs = _records(ns)
    quota = (jsonio.read_json(paths.ns_dir(ns) / "calibration-agy.json") or {}).get("quota", {})
    if prices is None:
        prices = json.loads((paths.REPO / "harness" / "prices.json").read_text(encoding="utf-8"))
    p = (prices.get("models") or {}).get("gemini-3.8-flash-medium") or {}
    rows = []
    for rec in recs:
        t = rec.get("totals") or {}
        rows.append({"run_id": rec["run_id"], "cell": rec["cell"], "outcome": rec["outcome"],
                     "ok": rec["outcome"] != "infra_failure", "turns": t.get("turns", 0),
                     "minutes": round(rec.get("duration_ms", 0) / 60000, 2),
                     "agent_minutes": round(sum(s.get("duration_ms", 0) for s in rec.get("sessions", [])) / 60000, 2),
                     "input": t.get("input_tokens", 0), "output": t.get("output_tokens", 0),
                     "thinking": _thinking(rec), "cache_read": t.get("cache_read_tokens", 0),
                     "total_reported": _total_reported(rec), "sessions": len(rec.get("sessions", [])),
                     "quota_used": _quota_used(quota.get(rec["run_id"]) or {}).get("5h"),
                     "weekly_used": _quota_used(quota.get(rec["run_id"]) or {}).get("weekly")})
    good = [r for r in rows if r["ok"]]
    out = {"runs": len(rows), "ok": len(good), "rows": rows, "deadline": DEADLINE.isoformat()}
    if not good:
        return out
    # does input_tokens include the cached tokens? total = in + out(+thinking) -> included; + cache -> separate
    incl = all(r["total_reported"] in (0, r["input"] + r["output"]) for r in good)
    out["cache_in_input"] = incl
    avg = {k: statistics.mean(r[k] for r in good) for k in ("input", "output", "thinking", "cache_read", "minutes",
                                                            "turns")}
    out["avg"] = {k: round(v, 2) for k, v in avg.items()}
    out["max"] = {k: max(r[k] for r in good) for k in ("input", "output", "minutes", "turns")}
    price_in, price_out = p.get("input_per_mtok", 0.75), p.get("output_per_mtok", 3.75)
    billable_in = avg["input"] + (0 if incl else avg["cache_read"])
    per_run = (billable_in * price_in + avg["output"] * price_out) / 1e6
    out["api_cost_per_run_usd"] = round(per_run, 4)
    out["api_cost_120_usd"] = round(per_run * 120, 2)
    out["hours_120"] = {w: round(avg["minutes"] * 120 / w / 60, 1) for w in (1, 2, 3)}
    used = [r["quota_used"] for r in good if r["quota_used"] is not None]
    today = today or datetime.now(timezone.utc).date()
    windows_left = max(0, (DEADLINE - today).days) * 24 // WINDOW_H
    if used and statistics.mean(used) > 0:
        per_window = int(1 / statistics.mean(used))
        out["quota"] = {"used_per_run": round(statistics.mean(used), 4), "runs_per_window": per_window,
                        "windows_needed_120": -(-120 // max(1, per_window)), "windows_until_deadline": windows_left}
    else:
        out["quota"] = {"used_per_run": None, "windows_until_deadline": windows_left}
    weekly = [r["weekly_used"] for r in good if r.get("weekly_used") is not None]
    last = [gemini_buckets((quota.get(r["run_id"]) or {}).get("after") or {}) for r in s_rows_sorted(out)]
    left = next((x["weekly"] for x in reversed(last) if "weekly" in x), None)
    if weekly:
        out["quota"]["weekly_used_per_run"] = round(statistics.mean(weekly), 4)
        out["quota"]["weekly_needed_120"] = round(statistics.mean(weekly) * 120, 3)
        out["quota"]["weekly_left"] = left
    return out


def s_rows_sorted(s: dict) -> list[dict]:
    return sorted(s.get("rows") or [], key=lambda r: r["run_id"])


def render(s: dict) -> str:
    L = [f"# Calibración de agy-flash (C8) — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')} UTC", ""]
    if not s.get("runs"):
        return "\n".join(L + ["Todavía no hay corridas C8 archivadas."]) + "\n"
    L.append(f"**{s['ok']} de {s['runs']}** corridas terminaron bien (sin falla de infraestructura). "
             "Son calibración: no son resultados.")
    L += ["", "| Corrida | Celda | Resultado | Turnos | Min | Tokens entrada | Salida (incl. thinking) | Thinking | "
              "Cuota 5 h | Cuota semanal |", "|---|---|---|---|---|---|---|---|---|---|"]
    pct = lambda v: "—" if v is None else f"{v * 100:.1f} %"  # noqa: E731
    for r in s["rows"]:
        L.append(f"| {r['run_id']} | {r['cell'].split('|')[1]}·{r['cell'].split('|')[2]} | {r['outcome']} | "
                 f"{r['turns']} | {r['minutes']} | {r['input']:,} | {r['output']:,} | {r['thinking']:,} | "
                 f"{pct(r['quota_used'])} | {pct(r.get('weekly_used'))} |")
    if not s.get("avg"):
        return "\n".join(L) + "\n"
    a, q = s["avg"], s["quota"]
    L += ["", "## Para decidir si arranca P8 (N = 20 por celda, 120 corridas, ya fijado en el addendum)", "",
          f"- **Tokens por corrida (promedio):** {a['input']:,.0f} de entrada, {a['output']:,.0f} de salida "
          f"(de ellos {a['thinking']:,.0f} de thinking).",
          f"- **Duración:** {a['minutes']} min por corrida con CI y oráculo; 120 corridas ≈ {s['hours_120'][1]} h con "
          f"1 worker, {s['hours_120'][3]} h con 3.",
          ]
    if q.get("used_per_run") is not None:
        fits = q["windows_needed_120"] <= q["windows_until_deadline"]
        L.append(f"- **Cuota de Google AI Pro:** cada corrida usó ≈ {q['used_per_run'] * 100:.1f} % de la ventana de "
                 f"{WINDOW_H} h → ≈ {q['runs_per_window']} corridas por ventana; 120 piden ≈ {q['windows_needed_120']} "
                 f"ventanas y quedan ≈ {q['windows_until_deadline']} antes del 23 oct: "
                 f"**{'alcanza' if fits else 'no alcanza'}**.")
    if q.get("weekly_used_per_run") is not None:
        wl = q.get("weekly_left")
        wfits = wl is not None and q["weekly_needed_120"] <= wl
        L.append(f"- **Tope semanal de Gemini** (se renueva el 23 oct): cada corrida usó ≈ "
                 f"{q['weekly_used_per_run'] * 100:.2f} %; 120 piden ≈ {q['weekly_needed_120'] * 100:.0f} % y quedan "
                 f"{'—' if wl is None else f'{wl * 100:.0f} %'}: **{'alcanza' if wfits else 'no alcanza'}**"
                 + ("" if wfits else " (P8 pararía por cuota en la última ronda completa, regla del addendum)") + ".")
    else:
        L.append("- **Cuota de Google AI Pro:** la lectura de `/usage` no dio una cifra comparable; ver "
                 "calibration-agy.json (lecturas crudas).")
    L += [f"- **Referencia con API key** (Flash USD 0.75 / 3.75 por millón): ≈ USD {s['api_cost_per_run_usd']} por "
          f"corrida, ≈ USD {s['api_cost_120_usd']} las 120"
          + ("" if s.get("cache_in_input") else " (tokens de caché cobrados como entrada: cota alta)") + ".",
          "", "**Decides tú:** ¿arranca P8? (sí / no). N no cambia: lo fija el addendum."]
    return "\n".join(L) + "\n"


def write_report(ns: str = "real") -> Path:
    s = summarize(ns)
    side = paths.ns_dir(ns) / "calibration-agy.json"
    data = jsonio.read_json(side) or {}
    data["summary"] = s
    jsonio.write_json_atomic(side, data)
    out = paths.ns_dir(ns) / "calibration-agy.md"
    out.write_text(render(s), encoding="utf-8", newline="\n")
    return out


def _snapshot() -> dict:
    home = quota_home()
    agy.prepare_home(home, home)
    from harness import sanitize
    snap, _ = sanitize.clean_obj(agy.quota_snapshot(home))
    return snap


def run_live(ns: str = "real", workers: int = 1) -> int:
    from harness import runner
    side = paths.ns_dir(ns) / "calibration-agy.json"
    data = jsonio.read_json(side) or {}
    quota = data.setdefault("quota", {})
    code = 0
    state = jsonio.read_json(paths.state_path(ns)) or {}
    for r in manifest.calibration_runs(ns):
        st = (state.get("runs", {}).get(r["run_id"]) or {}).get("status", "pending")
        if st not in ("pending", "infra_failure"):
            continue
        before = _snapshot()
        code = runner.main(["--stage", "C8", "--max-runs", "1", "--workers", str(workers), "--ns", ns])
        quota[r["run_id"]] = {"before": before, "after": _snapshot()}
        jsonio.write_json_atomic(side, data)
        state = jsonio.read_json(paths.state_path(ns)) or {}
        if code != 0:
            print(f"runner stopped with exit {code}; report written with what ran", file=sys.stderr)
            break
    out = write_report(ns)
    print(out.read_text(encoding="utf-8"))
    return code


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m harness.calib_agy")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--i-am-authorized", action="store_true")
    g.add_argument("--report", action="store_true")
    ap.add_argument("--ns", choices=["real", "mock"], default="real")
    a = ap.parse_args(argv)
    if a.dry_run:
        from harness import runner
        return runner.main(["--stage", "C8", "--dry-run", "--ns", a.ns])
    if a.report:
        print(write_report(a.ns).read_text(encoding="utf-8"))
        return 0
    return run_live(a.ns)


if __name__ == "__main__":
    sys.exit(main())
