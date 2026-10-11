"""Run manifest with block randomization by rounds (spec 11.2, 11.3).

    python -m harness.manifest --seed 20261011 [--ns real|mock] [--with-p6] [--force]

Stages (unit cc-sonnet unless stated; in the mock namespace every unit is `mock`):
  P0  calibration: X-rename V0·S0 ×3, V0·S2 ×2                                              =  5
  P1  core: {X-rename, X-remove} × {V0·S0, V0·S2} × 10                                       = 40
  P2  pressure: X-remove V1·S0 × 10                                                         = 10
  P4  breadth (61), exactly as the §11.2 row reads:
        X-units {V0·S0, V0·S2} × 5                        = 10
        X-add   V0·S0 × 5                                 =  5
        X-api   {V0·S0, V0·S2} × 5                        = 10
        X-dep   {V0·S0, V0·S2} × 5                        = 10
        {X-rename, X-remove} V2·S0 × 5                    = 10
        {X-rename, X-remove} V0·S1 × 5                    = 10   ("V0·S1 ×5" applies to the same two tickets as V2)
        concurrent controls {X-rename, X-remove} V0·S0 × 3 =  6  (control: true, interleaved in the same rounds)
                                                          = 61
  P5  optional: cc-opus on the P1 and P2 cells (4×10 + 1×10 = 50) + RQ5 X-rename V0·S0·W2 × 10 (cc-sonnet) = 60
  P6  only with --with-p6: the P1, P2 and P4 cells with unit `codex` (same N)
Within a stage, rounds: round r holds one replicate of every cell that still needs one, shuffled with
random.Random(f"{seed}:{stage}:{r}"). If a stage is cut after k rounds, every cell has k replicates.
Run ids are p<stage digit>-<4-digit position in the stage> (p1-0007).
Pilot X1 (exploratory, not in manifest.json): X-rename/X-remove × V0/V2 · S0 · W1 base text × 10 per unit, in
blocks of 4 (each block = the 4 cells, shuffled with random.Random(f"{X1_SEED}:X1:{block}")). Ids x1-0001..0040
(cc-sonnet) and x1c-0001..0040 (codex); in the mock namespace only x1-* (unit mock). `load(ns)` = manifest.json plus
these runs, computed here, so manifest.json and its hash (state.manifest_sha256, the pre-registration) never change.
Paraphrases (spec 6.1): X-rename, X-remove and X-api cells with N = 10 at W1 use slots p1..p5 × 2 if all five
scenario/tasks/<t>.p*.md are written by a person (no `TODO(human)`); otherwise the base text ×10, recorded under
"paraphrases" in the manifest. P0 and W2 always use the base text.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

from harness import jsonio, paths, scenario_io

SEED = 20261011
STAGES = ("P0", "P1", "P2", "P4", "P5", "P6")
PILOTS = ("X1",)
X1_SEED = 20261012
X1_UNITS = {"cc-sonnet": "x1", "codex": "x1c"}     # unit -> run-id prefix


def _cell(ticket, V, S, n, unit="cc-sonnet", W="W1", control=False):
    return {"ticket": ticket, "visibility": V, "spec": S, "wording": W, "unit": unit, "n": n, "control": control}


def stage_cells(stage: str) -> list[dict]:
    if stage == "P0":
        return [_cell("X-rename", "V0", "S0", 3), _cell("X-rename", "V0", "S2", 2)]
    if stage == "P1":
        return [_cell(t, "V0", S, 10) for t in ("X-rename", "X-remove") for S in ("S0", "S2")]
    if stage == "P2":
        return [_cell("X-remove", "V1", "S0", 10)]
    if stage == "P4":
        return ([_cell("X-units", "V0", S, 5) for S in ("S0", "S2")] + [_cell("X-add", "V0", "S0", 5)]
                + [_cell("X-api", "V0", S, 5) for S in ("S0", "S2")]
                + [_cell("X-dep", "V0", S, 5) for S in ("S0", "S2")]
                + [_cell(t, "V2", "S0", 5) for t in ("X-rename", "X-remove")]
                + [_cell(t, "V0", "S1", 5) for t in ("X-rename", "X-remove")]
                + [_cell(t, "V0", "S0", 3, control=True) for t in ("X-rename", "X-remove")])
    if stage == "P5":
        return ([dict(c, unit="cc-opus") for c in stage_cells("P1") + stage_cells("P2")]
                + [_cell("X-rename", "V0", "S0", 10, W="W2")])
    if stage == "P6":
        return [dict(c, unit="codex") for s in ("P1", "P2", "P4") for c in stage_cells(s)]
    raise ValueError(stage)


def cell_key(c: dict) -> str:
    return f"{c['ticket']}|{c['visibility']}|{c['spec']}|{c['wording']}|{c['unit']}"


def paraphrase_status() -> dict:
    return {t: scenario_io.paraphrases_ready(t) if paths.TASKS.exists() else False for t in scenario_io.PARAPHRASED}


def generate(seed: int = SEED, ns: str = "real", with_p6: bool = False) -> dict:
    para = paraphrase_status()
    runs = []
    for stage in STAGES:
        if stage == "P6" and not with_p6:
            continue
        cells = stage_cells(stage)
        if ns == "mock":
            cells = [dict(c, unit="mock") for c in cells]
        pos = 0
        for r in range(1, max(c["n"] for c in cells) + 1):
            todo = [c for c in cells if c["n"] >= r]
            random.Random(f"{seed}:{stage}:{r}").shuffle(todo)
            for c in todo:
                pos += 1
                p = None
                if (stage != "P0" and c["wording"] == "W1" and c["n"] == 10 and c["ticket"] in scenario_io.PARAPHRASED
                        and para.get(c["ticket"])):
                    p = f"p{(r - 1) % 5 + 1}"
                run = {"run_id": f"p{stage[1]}-{pos:04d}", "stage": stage, "unit": c["unit"], "ticket": c["ticket"],
                       "wording": c["wording"], "paraphrase": p, "visibility": c["visibility"], "spec": c["spec"],
                       "replicate": r, "round": r, "cell": cell_key(c)}
                if c["control"]:
                    run["control"] = True
                runs.append(run)
    return {
        "schema": "manifest/1", "seed": seed, "namespace": ns,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "paraphrases": {t: ("p1..p5 x2" if ok else "base text x10 (paraphrase files missing or TODO(human))")
                        for t, ok in para.items()},
        "stage_counts": {s: sum(1 for r in runs if r["stage"] == s) for s in STAGES if any(r["stage"] == s for r in runs)},
        "runs": runs,
    }


def pilot_cells(stage: str) -> list[dict]:
    if stage == "X1":
        return [_cell(t, V, "S0", 10) for t in ("X-rename", "X-remove") for V in ("V0", "V2")]
    raise ValueError(stage)


def pilot_runs(ns: str) -> list[dict]:
    """X1: one block of the 4 cells per replicate, shuffled per block; base ticket text (no paraphrases)."""
    units = {"mock": "x1"} if ns == "mock" else X1_UNITS
    runs = []
    for unit, prefix in units.items():
        cells = [dict(c, unit=unit) for c in pilot_cells("X1")]
        pos = 0
        for b in range(1, 11):
            block = list(cells)
            random.Random(f"{X1_SEED}:X1:{b}").shuffle(block)
            for c in block:
                pos += 1
                runs.append({"run_id": f"{prefix}-{pos:04d}", "stage": "X1", "unit": unit, "ticket": c["ticket"],
                             "wording": "W1", "paraphrase": None, "visibility": c["visibility"], "spec": c["spec"],
                             "replicate": b, "round": b, "cell": cell_key(c), "pilot": True})
    return runs


def with_pilots(m: dict, ns: str) -> dict:
    known = {r["run_id"] for r in m.get("runs", [])}
    extra = [r for r in pilot_runs(ns) if r["run_id"] not in known]
    return dict(m, runs=list(m.get("runs", [])) + extra, pilots={"X1": {"seed": X1_SEED, "runs": len(extra)}})


def load(ns: str) -> dict | None:
    """results/<ns>/manifest.json plus the pilot runs (X1). None when there is no manifest.json."""
    m = jsonio.read_json(paths.manifest_path(ns))
    return with_pilots(m, ns) if m is not None else None


def validate(manifest: dict) -> list[str]:
    import jsonschema
    schema = json.loads((paths.CONTRACTS / "manifest.schema.json").read_text(encoding="utf-8"))
    return [e.message for e in jsonschema.Draft7Validator(schema).iter_errors(manifest)]


def sha256(path) -> str | None:
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


def ensure(ns: str, seed: int = SEED) -> dict:
    """Load results/<ns>/manifest.json (plus the pilot runs); the mock namespace generates it on first use."""
    m = jsonio.read_json(paths.manifest_path(ns))
    if m is None and ns == "mock":
        m = generate(seed, "mock")
        jsonio.write_json_atomic(paths.manifest_path(ns), m)
    return with_pilots(m, ns) if m is not None else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m harness.manifest")
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--ns", choices=["real", "mock"], default="real")
    ap.add_argument("--with-p6", action="store_true", help="also generate the P6 (codex) copies")
    ap.add_argument("--force", action="store_true", help="overwrite an existing manifest (never after the freeze)")
    ap.add_argument("--print", action="store_true", help="print the stage counts and do not write")
    a = ap.parse_args(argv)
    m = generate(a.seed, a.ns, a.with_p6)
    errs = validate(m)
    if errs:
        print("manifest does not match the contract schema:", errs[:3], file=sys.stderr)
        return 1
    if a.print:
        print(json.dumps(m["stage_counts"]))
        return 0
    out = paths.manifest_path(a.ns)
    if out.exists() and not a.force:
        print(f"{out} exists; pass --force to overwrite (the real manifest is frozen with the pre-registration)",
              file=sys.stderr)
        return 2
    if a.ns == "real" and paths.PREREG_LOCK.exists():
        print("PREREGISTRATION.lock exists: the real manifest is frozen", file=sys.stderr)
        return 2
    jsonio.write_json_atomic(out, m)
    print(f"wrote {out}: {m['stage_counts']}  paraphrases: {m['paraphrases']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
