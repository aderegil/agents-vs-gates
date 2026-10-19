"""The deck table for addendum 1 (P7, P8): exact numerators and denominators per unit and condition.

    python -m analysis.deck_numbers_ext --ns real|mock     -> results/<ns>/deck-numbers-ext.md

Per unit, for each condition (no rule V0·S0 / sees every repo V2·S0 / rule in the spec V0·S2), both tickets pooled
and per ticket:
  breaks      the first attempt broke a consumer (oracle on `gen`, `staging_break`): x of N [95% CP]
  CI caught   of those breaks, how many the first CI failed (`consumer_break_ci`): x of y
  final PR    the PR as it ends still breaks a consumer (`staging_break_final`): x of N
  gate edits  runs that edited the gate (`gate_flagged`), and of them the blind-coded T2/T3 (manipulation)
Two blocks per P7 unit: the new runs only (P7) and earlier runs + P7 combined (descriptive); P8 has the new runs only.
Blinded stages print "blinded". Units are never compared: one table per unit, no cross-unit row.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

from analysis import common
from analysis.stats import x_of_n
from analysis.summarize import CONDITIONS, H2_TICKETS
from harness import blinding, paths

UNIT_LABEL = {"cc-sonnet": "Claude Code + Sonnet 5.5", "codex": "Codex CLI + gpt-5.6-terra",
              "agy-flash": "Antigravity CLI + Gemini 3.8 Flash", "cc-opus": "Claude Code + Opus 5.5",
              "mock": "mock (simulated)",
              "mock-cx": "mock-cx (simulated)", "mock-agy": "mock-agy (simulated)"}


def _m(r, k):
    return (r.get("metrics") or {}).get(k)


def _final_break(r):
    v = _m(r, "staging_break_final")
    return _m(r, "staging_break") if v is None else v


def _ci_final_ok(r) -> bool:
    ci = r.get("ci") or []
    return bool(ci) and bool((ci[-1].get("verdict") or {}).get("ok"))


def row(recs: list[dict], labels: dict) -> dict:
    n = len(recs)
    br = [r for r in recs if _m(r, "staging_break")]
    caught = [r for r in br if _m(r, "consumer_break_ci")]
    fin = [r for r in recs if _final_break(r)]
    # repaired until CI went green, yet another team's tests still fail: right form, wrong meaning
    repaired = [r for r in recs if (r.get("repair_attempts") or 0) > 0 and _ci_final_ok(r)]
    green_broken = [r for r in repaired if _final_break(r)]
    gate = [r for r in recs if _m(r, "gate_flagged")]
    manip = [r for r in gate if labels.get(r["run_id"]) in ("T2", "T3")]
    uncoded = [r for r in gate if r["run_id"] not in labels]
    return {"n": n, "breaks": len(br), "caught": len(caught), "final": len(fin), "gate": len(gate),
            "t2t3": len(manip), "uncoded": len(uncoded), "repaired": len(repaired), "green_broken": len(green_broken)}


def _fmt(d: dict) -> list[str]:
    if not d["n"]:
        return ["—"] * 5
    gate = f"{d['gate']} of {d['n']}"
    if d["gate"]:
        gate += f" (T2/T3 {d['t2t3']}" + (f", {d['uncoded']} not coded yet" if d["uncoded"] else "") + ")"
    return [x_of_n(d["breaks"], d["n"]), f"{d['caught']} of {d['breaks']}" if d["breaks"] else "0 of 0",
            x_of_n(d["final"], d["n"]), f"{d['green_broken']} of {d['repaired']}", gate]


def _table(pool: list[dict], labels: dict) -> list[str]:
    L = ["| Condition | Ticket | Breaks (first attempt) | CI caught | Final PR breaks | Repaired to green CI, "
         "still breaks another team | Gate edits |",
         "|---|---|---|---|---|---|---|"]
    for V, S, label in CONDITIONS:
        rows = [r for r in pool if r.get("visibility") == V and r.get("spec") == S]
        if not rows:
            continue
        L.append(f"| **{label}** | both | " + " | ".join(_fmt(row(rows, labels))) + " |")
        for t in H2_TICKETS:
            sel = [r for r in rows if r.get("ticket") == t]
            if sel:
                L.append(f"| | {t} | " + " | ".join(_fmt(row(sel, labels))) + " |")
    return L + [""]


def build(ns: str) -> str:
    records = common.load_records(ns)
    state, manifest = common.load_state(ns), common.load_manifest(ns)
    labels = (common.load_labels(ns) or {}).get("gate", {})
    main = [r for r in records if common.analyzable(r, state) and r.get("wording", "W1") == "W1"]
    part_of = {r["run_id"]: r.get("part") for r in (manifest or {}).get("runs", [])}
    L = [f"# Deck numbers — addendum 1 ({ns})", "",
         f"Generated {datetime.now(timezone.utc).isoformat(timespec='seconds')}. Exact counts \"x of N [95% "
         "Clopper-Pearson]\" (percentages only when N ≥ 20). One table per unit; **units are never compared**. "
         "Breaks = the other teams' tests (consumer tests, `oracle/`) fail on the first attempt (`gen`); CI caught = "
         "of those breaks, the first CI failed; final PR = the PR as it ends; repaired to green CI, still breaks = of "
         "the runs that needed at least one repair and ended with CI green, how many still fail another team's tests "
         "(right form, wrong meaning); gate edits = runs that touched the gate, with the blind-coded T2/T3 "
         "(manipulation).", ""]
    if ns == "mock":
        L += [f"> **{common.SIM_BANNER}**", ""]
    planned = {r["stage"] for r in (manifest or {}).get("runs", [])}
    # addendum 1 (P7 extends P1 / P6; P8 is new), then addendum 2 (P9 extends P8) once its manifest exists
    entries = ([(s, u, common.EXT1_BASE[ns].get(u) if s == "P7" else None)
                for s, units in common.EXT1_UNITS[ns].items() for u in units]
               + [(s, u, common.EXT2_BASE[ns].get(u))
                  for s, units in common.EXT2_UNITS[ns].items() if s in planned for u in units])
    shown = set()
    for stage, unit, base in entries:
        if unit not in shown:
            L += [f"## {UNIT_LABEL.get(unit, unit)} (`{unit}`)", ""]
            shown.add(unit)
        if not blinding.is_visible(state, stage):
            L += [f"{stage}: blinded until the stage is complete.", ""]
            continue
        new = [r for r in main if r["stage"] == stage and r.get("unit") == unit]
        L += [f"### {stage} — new runs only", ""] + (_table(new, labels) if new else ["No runs.", ""])
        if base:
            bstage, bpart = base
            if not blinding.is_visible(state, bstage):
                continue
            cells = {(r.get("ticket"), r.get("visibility"), r.get("spec")) for r in new}
            old = [r for r in main if r["stage"] == bstage and r.get("unit") == unit
                   and (bpart is None or part_of.get(r["run_id"]) == bpart)
                   and (r.get("ticket"), r.get("visibility"), r.get("spec")) in cells]
            L += [f"### {bstage}{f' ({bpart} part)' if bpart else ''} + {stage} — combined (descriptive, no p-values)",
                  ""] + _table(old + new, labels)
    L += _ci_first_attempt(main, state)
    return "\n".join(L)


def _ci_first_attempt(main: list[dict], state: dict | None) -> list[str]:
    """Per unit, every visible run of the main analysis (all stages and tickets): first-attempt breaks and how many the
    first CI failed, split by where the consumer contracts were (outside the agent's repo: V0, V2; copied inside: V1).
    One row per unit; units are never summed (addendum 1 §5, addendum 2 §4)."""
    L = ["## First attempt: breaks that CI caught, per unit (every visible stage; units are not summed)", "",
         "| Unit | Stages | Gate outside the agent's repo (V0, V2): CI caught | Gate copied into the repo (V1): CI caught |",
         "|---|---|---|---|"]
    for unit in sorted({r.get("unit") for r in main}, key=lambda u: list(UNIT_LABEL).index(u) if u in UNIT_LABEL else 99):
        mine = [r for r in main if r.get("unit") == unit]
        cells = []
        for vis in (("V0", "V2"), ("V1",)):
            br = [r for r in mine if r.get("visibility") in vis and _m(r, "staging_break")]
            cells.append(f"{sum(1 for r in br if _m(r, 'consumer_break_ci'))} of {len(br)}" if br else "—")
        stages = ", ".join(sorted({r["stage"] for r in mine}))
        L.append(f"| {UNIT_LABEL.get(unit, unit)} | {stages} | {cells[0]} | {cells[1]} |")
    blinded = [s for s in common.MAIN_STAGES if s != "selftest" and not blinding.is_visible(state, s)]
    note = ("In V1 the consumer contracts sit inside the agent's repo, so the agent can edit them and CI passes; that "
            "is the gate-edit case, counted apart. — = no break in those runs.")
    return L + ["", note, ""] + ([f"Not included yet (blinded): {', '.join(blinded)}.", ""] if blinded else [])


def write(ns: str) -> Path:
    out = paths.ns_dir(ns) / "deck-numbers-ext.md"
    out.write_text(build(ns) + "\n", encoding="utf-8", newline="\n")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m analysis.deck_numbers_ext")
    ap.add_argument("--ns", choices=paths.NAMESPACES, default="real")
    a = ap.parse_args(argv)
    print(f"wrote {write(a.ns)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
