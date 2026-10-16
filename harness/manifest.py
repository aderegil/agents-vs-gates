"""Run manifest with block randomization by rounds (spec 11.2, 11.3).

    python -m harness.manifest --seed 20261011 [--ns real|mock] [--with-p6] [--force]
    python -m harness.manifest --p1-variant xremove|xapi --print [--with-p6]   stage counts of a P1 variant (no write)

H2 tickets (the single switch, H2_TICKETS below; the design session sets it after Pilot X2, DECISIONS):
  variant "xremove" (i):  H2 = X-rename + X-remove  -> the stages below, as they are.
  variant "xapi"    (ii): H2 = X-rename + X-api     -> P1 = {X-rename, X-api} × {V0·S0, V0·S2, V2·S0} × 10 (= 60,
        X-api paraphrased p1..p5 ×2); P4 drops X-api {V0·S0, V0·S2} × 5 (now P1 cells with N = 10) -> 41; X-remove
        keeps P2 (V1·S0 × 10) and its P4 cells (V0·S1 × 5, controls V0·S0 × 3) and is reported as descriptive;
        P5 = cc-opus on the H2 cells {X-rename, X-api} × {V0·S0, V0·S2} + P2 + RQ5 = 60; P6 = codex on P1 + P2 + P4
        = 111. P0 and the pilots never change.

Stages (unit cc-sonnet unless stated; in the mock namespace every unit is `mock`):
  P0  calibration: X-rename V0·S0 ×3, V0·S2 ×2                                              =  5
  P1  core: {X-rename, X-remove} × {V0·S0, V0·S2, V2·S0} × 10                                = 60
        (V0·S0 vs V0·S2 = H2, confirmatory; V2·S0 vs V0·S0 = pre-registered secondary hypothesis. V2·S0 moved here
        from P4 by Alfredo's decision of 2026-10-11, so it runs interleaved with its V0·S0 comparison.)
  P2  pressure: X-remove V1·S0 × 10                                                         = 10
  P4  breadth (51): the §11.2 row without the V2·S0 cells (now in P1):
        X-units {V0·S0, V0·S2} × 5                        = 10
        X-add   V0·S0 × 5                                 =  5
        X-api   {V0·S0, V0·S2} × 5                        = 10
        X-dep   {V0·S0, V0·S2} × 5                        = 10
        {X-rename, X-remove} V0·S1 × 5                    = 10   ("V0·S1 ×5" applies to X-rename and X-remove)
        concurrent controls {X-rename, X-remove} V0·S0 × 3 =  6  (control: true, interleaved in the same rounds)
                                                          = 51
  P5  optional: cc-opus on the core P1 cells (V0·S0, V0·S2; not V2·S0) and the P2 cell (4×10 + 1×10 = 50)
      + RQ5 X-rename V0·S0·W2 × 10 (cc-sonnet) = 60. Unchanged by the V2·S0 move.
  P6  only with --with-p6: unit `codex` on the cells of P1, P2 and P4 as they are now (P1 6×10 with V2·S0, P2,
      P4 without V2·S0) = 60 + 10 + 51 = 121: Codex replicates the formal design as it stands (decision 2026-10-11).
      Each P6 run records its `part` (P1, P2 or P4). The real manifest.json was frozen without P6, so P6 lives in
      the sidecar results/<ns>/manifest-p6.json (`--p6-sidecar`): the same runs --with-p6 would have made, written
      once; `load(ns)` merges it. `runner --stage P6 --part P1` runs one part.
Within a stage, rounds: round r holds one replicate of every cell that still needs one, shuffled with
random.Random(f"{seed}:{stage}:{r}"). If a stage is cut after k rounds, every cell has k replicates.
Run ids are p<stage digit>-<4-digit position in the stage> (p1-0007).
Pilot X1 (exploratory, not in manifest.json): X-rename/X-remove × V0/V2 · S0 · W1 base text × 10 per unit, in
blocks of 4 (each block = the 4 cells, shuffled with random.Random(f"{X1_SEED}:X1:{block}")). Ids x1-0001..0040
(cc-sonnet) and x1c-0001..0040 (codex); in the mock namespace only x1-* (unit mock). `load(ns)` = manifest.json plus
these runs, computed here, so manifest.json and its hash (state.manifest_sha256, the pre-registration) never change.
Pilot X2 (exploratory, same mechanism, after the X-remove scenario fix): X-remove × V0/V2 · S0 · W1 base text × 5,
cc-sonnet only, blocks of 2 (each block = one V0 and one V2, shuffled with random.Random(f"{X2_SEED}:X2:{block}")).
Ids x2-0001..0010; in the mock namespace x2-* with unit mock. It decides H2_TICKETS (rule in PREREGISTRATION §6).
Addendum 1 (PREREGISTRATION-ADDENDUM-1.md; branch ext-1016, 2026-10-15). The frozen manifest.json is never touched:
  P7  extension of P1, same cells and scenario, new seed EXT1_SEED; N = 40 new runs per cell:
        cc-sonnet: {X-rename, X-remove} × {V0·S0, V0·S2, V2·S0} × 40 = 240
        codex:     the same 6 cells × 40                               = 240 (V2·S0 added 2026-10-16, Alfredo)
  P8  third unit agy-flash (Antigravity CLI + Gemini 3.8 Flash): the 6 P1 cells × P8_N (default 20; Alfredo sets it
      after the C8 calibration) = 120
  Both live in the sidecar results/<ns>/manifest-ext1.json (`--ext1-sidecar [--with-p7] [--with-p8] [--p8-n N]`),
  merged by `load(ns)`; run ids p7-0001.., p8-0001... Rounds as above (random.Random(f"{EXT1_SEED}:{stage}:{r}"), all
  units of a stage in the same rounds; the runner runs one unit at a time with --unit). Paraphrases: slot
  p((r-1) mod 5 + 1) on every W1 cell of X-rename/X-remove (N = 40 and 20 are multiples of 5: each slot ×8 / ×4).
  C8  calibration of agy-flash (exploratory, like P0; in no manifest file, computed here like the pilots):
      X-rename V0·S0 ×3, V0·S2 ×2, base text, ids c8-0001..0005, seed EXT1_SEED.
  In the mock namespace the units map to mock (cc-sonnet), mock-cx (codex) and mock-agy (agy-flash): distinct cell
  keys, the same simulated agent.
Paraphrases (spec 6.1): X-rename, X-remove and X-api cells with N = 10 at W1 use slots p1..p5 × 2 if all five
scenario/tasks/<t>.p*.md are written (no `TODO(human)`); otherwise the base text ×10, recorded under
"paraphrases" in the manifest. P0 and W2 always use the base text. In round r every paraphrased cell uses slot
p((r-1) mod 5 + 1). The slots were generated by Codex and selected by hand (declared deviation from spec 6.1, which
asked for a person; docs/pilot/paraphrases-codex.md).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from harness import jsonio, paths, scenario_io

SEED = 20261011
STAGES = ("P0", "P1", "P2", "P4", "P5", "P6")
PILOTS = ("X1", "X2")
X1_SEED = 20261012
X1_UNITS = {"cc-sonnet": "x1", "codex": "x1c"}     # unit -> run-id prefix
X2_SEED = 20261013
X2_UNITS = {"cc-sonnet": "x2"}
PILOT_SPEC = {   # stage -> (seed, real units -> prefix, mock prefix, replicates per cell)
    "X1": (X1_SEED, X1_UNITS, "x1", 10),
    "X2": (X2_SEED, X2_UNITS, "x2", 5),
}

P6_PARTS = ("P1", "P2", "P4")      # the stages P6 replicates with unit codex; each P6 run records its `part`
P6_NAME = "manifest-p6.json"       # P6 sidecar beside the frozen manifest.json (written once, its sha in state)

EXT1_SEED = 20261016               # addendum 1 (P7, P8, C8)
EXT_STAGES = ("P7", "P8")
CAL_STAGES = ("C8",)               # exploratory calibration of agy-flash, computed like the pilots
EXT1_NAME = "manifest-ext1.json"   # P7/P8 sidecar beside the frozen manifest.json (frozen by the addendum lock)
P7_N = 40
P8_N = 20
MOCK_UNITS = {"cc-sonnet": "mock", "codex": "mock-cx", "agy-flash": "mock-agy"}

# The single switch for the confirmatory H2 tickets (P1 and the stages derived from it; analysis.summarize reads it).
P1_VARIANTS = {"xremove": ("X-rename", "X-remove"), "xapi": ("X-rename", "X-api")}
H2_TICKETS = P1_VARIANTS["xremove"]


def _cell(ticket, V, S, n, unit="cc-sonnet", W="W1", control=False):
    return {"ticket": ticket, "visibility": V, "spec": S, "wording": W, "unit": unit, "n": n, "control": control}


def _h2(h2: tuple | None) -> tuple:
    h2 = tuple(h2 or H2_TICKETS)
    if h2 not in P1_VARIANTS.values():
        raise ValueError(f"H2 tickets must be one of {sorted(P1_VARIANTS.values())}, not {h2}")
    return h2


def _p1_core(h2: tuple | None = None) -> list[dict]:
    """H2 cells: {H2 tickets} × {V0·S0, V0·S2} × 10 (the P1 of the original design, with X-rename + X-remove)."""
    return [_cell(t, "V0", S, 10) for t in _h2(h2) for S in ("S0", "S2")]


def _p4_cells(with_v2: bool, h2: tuple | None = None) -> list[dict]:
    """The §11.2 P4 row; with_v2=False drops {X-rename, X-remove} V2·S0 × 5 (moved to P1 as × 10).
    With H2 = X-rename + X-api (variant xapi), X-api {V0·S0, V0·S2} × 5 leave P4 (they are P1 cells with N = 10);
    X-remove's V0·S1 and control cells stay (decision in docs/DECISIONS.md)."""
    h2 = _h2(h2)
    return ([_cell("X-units", "V0", S, 5) for S in ("S0", "S2")] + [_cell("X-add", "V0", "S0", 5)]
            + ([_cell("X-api", "V0", S, 5) for S in ("S0", "S2")] if "X-api" not in h2 else [])
            + [_cell("X-dep", "V0", S, 5) for S in ("S0", "S2")]
            + ([_cell(t, "V2", "S0", 5) for t in ("X-rename", "X-remove")] if with_v2 else [])
            + [_cell(t, "V0", "S1", 5) for t in ("X-rename", "X-remove")]
            + [_cell(t, "V0", "S0", 3, control=True) for t in ("X-rename", "X-remove")])


def stage_cells(stage: str, h2: tuple | None = None) -> list[dict]:
    """Cells of a stage. h2 = the H2 tickets (default H2_TICKETS, the switch); only P1 and what derives from it
    (P4 drops X-api's cells under variant xapi, P5, P6) depend on it."""
    if stage == "P0":
        return [_cell("X-rename", "V0", "S0", 3), _cell("X-rename", "V0", "S2", 2)]
    if stage == "P1":
        return _p1_core(h2) + [_cell(t, "V2", "S0", 10) for t in _h2(h2)]
    if stage == "P2":
        return [_cell("X-remove", "V1", "S0", 10)]
    if stage == "P4":
        return _p4_cells(with_v2=False, h2=h2)
    if stage == "P5":       # kept as before the V2·S0 move: the core P1 cells only
        return ([dict(c, unit="cc-opus") for c in _p1_core(h2) + stage_cells("P2", h2)]
                + [_cell("X-rename", "V0", "S0", 10, W="W2")])
    if stage == "P6":       # Codex replicates P1, P2 and P4 as they are now (decision 2026-10-11, docs/DECISIONS.md)
        return [dict(c, unit="codex", part=s) for s in P6_PARTS for c in stage_cells(s, h2)]
    raise ValueError(stage)


def cell_key(c: dict) -> str:
    return f"{c['ticket']}|{c['visibility']}|{c['spec']}|{c['wording']}|{c['unit']}"


def paraphrase_status() -> dict:
    return {t: scenario_io.paraphrases_ready(t) if paths.TASKS.exists() else False for t in scenario_io.PARAPHRASED}


def generate(seed: int = SEED, ns: str = "real", with_p6: bool = False, h2: tuple | None = None) -> dict:
    para = paraphrase_status()
    runs = []
    for stage in STAGES:
        if stage == "P6" and not with_p6:
            continue
        cells = stage_cells(stage, h2)
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
                if c.get("part"):
                    run["part"] = c["part"]
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
    if stage == "X2":
        return [_cell("X-remove", V, "S0", 5) for V in ("V0", "V2")]
    raise ValueError(stage)


def pilot_runs(ns: str, stage: str | None = None) -> list[dict]:
    """The pilots (X1, then X2; or only `stage`): one block of the stage's cells per replicate, shuffled per block
    with random.Random(f"{seed}:{stage}:{block}"); base ticket text (no paraphrases). Units run one after the other."""
    runs = []
    for st in ((stage,) if stage else PILOTS):
        seed, real_units, mock_prefix, reps = PILOT_SPEC[st]
        units = {"mock": mock_prefix} if ns == "mock" else real_units
        for unit, prefix in units.items():
            cells = [dict(c, unit=unit) for c in pilot_cells(st)]
            pos = 0
            for b in range(1, reps + 1):
                block = list(cells)
                random.Random(f"{seed}:{st}:{b}").shuffle(block)
                for c in block:
                    pos += 1
                    runs.append({"run_id": f"{prefix}-{pos:04d}", "stage": st, "unit": unit, "ticket": c["ticket"],
                                 "wording": "W1", "paraphrase": None, "visibility": c["visibility"],
                                 "spec": c["spec"], "replicate": b, "round": b, "cell": cell_key(c), "pilot": True})
    return runs


def with_pilots(m: dict, ns: str) -> dict:
    known = {r["run_id"] for r in m.get("runs", [])}
    extra = [r for r in pilot_runs(ns) if r["run_id"] not in known]
    return dict(m, runs=list(m.get("runs", [])) + extra,
                pilots={st: {"seed": PILOT_SPEC[st][0], "runs": sum(1 for r in extra if r["stage"] == st)}
                        for st in PILOTS})


def p6_path(ns: str) -> Path:
    return paths.manifest_path(ns).with_name(P6_NAME)


def generate_p6(seed: int = SEED, ns: str = "real", h2: tuple | None = None) -> dict:
    """The P6 runs exactly as `generate(..., with_p6=True)` makes them (same seed, rounds, paraphrase slots and ids
    p6-0001..), as a sidecar: the real manifest.json was frozen without P6, so P6 cannot be added to it."""
    full = generate(seed, ns, with_p6=True, h2=h2)
    runs = [r for r in full["runs"] if r["stage"] == "P6"]
    return {"schema": "manifest/1", "seed": seed, "namespace": ns, "generated_at": full["generated_at"],
            "sidecar_of": "manifest.json", "paraphrases": full["paraphrases"], "stage_counts": {"P6": len(runs)},
            "parts": {p: sum(1 for r in runs if r["part"] == p) for p in P6_PARTS}, "runs": runs}


def write_p6(ns: str, seed: int = SEED, force: bool = False) -> tuple[Path, dict]:
    """Write results/<ns>/manifest-p6.json once. Refused if it exists (unless force and no P6 run has started) or if
    manifest.json already holds P6 runs."""
    out = p6_path(ns)
    base = jsonio.read_json(paths.manifest_path(ns))
    if base is None:
        raise RuntimeError(f"no {paths.manifest_path(ns)}: generate the manifest first")
    if any(r["stage"] == "P6" for r in base.get("runs", [])):
        raise RuntimeError("manifest.json already holds the P6 runs (generated with --with-p6); no sidecar needed")
    if out.exists():
        state = jsonio.read_json(paths.state_path(ns)) or {}
        started = [rid for rid, r in state.get("runs", {}).items()
                   if rid.startswith("p6-") and r.get("status", "pending") != "pending"]
        if not force or started:
            raise RuntimeError(f"{out} exists" + (f" and {len(started)} P6 run(s) have started" if started
                                                  else "; pass --force to overwrite"))
    if seed != base.get("seed"):
        raise RuntimeError(f"seed {seed} differs from manifest.json's seed {base.get('seed')}")
    m = generate_p6(seed, ns)
    errs = validate(m)
    if errs:
        raise RuntimeError(f"P6 sidecar does not match the contract schema: {errs[:3]}")
    jsonio.write_json_atomic(out, m)
    return out, m


def with_p6(m: dict, ns: str) -> dict:
    """manifest.json plus the P6 sidecar's runs (when the sidecar exists and manifest.json has no P6 runs)."""
    side = jsonio.read_json(p6_path(ns))
    known = {r["run_id"] for r in m.get("runs", [])}
    if side is None or any(rid.startswith("p6-") for rid in known):
        return m
    return dict(m, runs=list(m.get("runs", [])) + [r for r in side["runs"] if r["run_id"] not in known],
                p6_sidecar={"file": P6_NAME, "sha256": sha256(p6_path(ns)), "runs": len(side["runs"])})


def load(ns: str) -> dict | None:
    """results/<ns>/manifest.json plus the P6 and addendum-1 sidecars (if any), the pilot runs (X1, X2) and the C8
    calibration. None without a manifest."""
    return _merged(jsonio.read_json(paths.manifest_path(ns)), ns)


def _merged(m: dict | None, ns: str) -> dict | None:
    return with_calibration(with_pilots(with_ext1(with_p6(m, ns), ns), ns), ns) if m is not None else None


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
    return _merged(m, ns)


# ---------------------------------------------------------------- addendum 1: P7, P8, C8 -------------------------

def _ext_unit(unit: str, ns: str) -> str:
    return MOCK_UNITS[unit] if ns == "mock" else unit


def ext_cells(stage: str, p8_n: int = P8_N, h2: tuple | None = None) -> list[dict]:
    """P7: cc-sonnet and codex on the 6 P1 cells, N = 40 each. P8: agy-flash on the 6 P1
    cells, N = p8_n. C8: agy-flash on the P0 cells."""
    p1 = stage_cells("P1", h2)
    if stage == "P7":
        return ([dict(c, n=P7_N, unit="cc-sonnet") for c in p1]
                + [dict(c, n=P7_N, unit="codex") for c in p1])
    if stage == "P8":
        return [dict(c, n=p8_n, unit="agy-flash") for c in p1] if p8_n > 0 else []
    if stage == "C8":
        return [dict(c, unit="agy-flash") for c in stage_cells("P0", h2)]
    raise ValueError(stage)


def _ext_runs(stage: str, cells: list[dict], seed: int, ns: str, para: dict, paraphrased: bool,
              prefix: str) -> list[dict]:
    runs, pos = [], 0
    if not cells:
        return runs
    for r in range(1, max(c["n"] for c in cells) + 1):
        todo = [c for c in cells if c["n"] >= r]
        random.Random(f"{seed}:{stage}:{r}").shuffle(todo)
        for c in todo:
            pos += 1
            unit = _ext_unit(c["unit"], ns)
            p = None
            if (paraphrased and c["wording"] == "W1" and c["n"] % 5 == 0 and c["ticket"] in scenario_io.PARAPHRASED
                    and para.get(c["ticket"])):
                p = f"p{(r - 1) % 5 + 1}"
            runs.append({"run_id": f"{prefix}-{pos:04d}", "stage": stage, "unit": unit, "ticket": c["ticket"],
                         "wording": c["wording"], "paraphrase": p, "visibility": c["visibility"], "spec": c["spec"],
                         "replicate": r, "round": r, "cell": cell_key(dict(c, unit=unit))})
    return runs


def generate_ext1(seed: int = EXT1_SEED, ns: str = "real", with_p7: bool = True, with_p8: bool = True,
                  p8_n: int = P8_N, h2: tuple | None = None) -> dict:
    para = paraphrase_status()
    runs = []
    for stage, on in (("P7", with_p7), ("P8", with_p8)):
        if on:
            runs += _ext_runs(stage, ext_cells(stage, p8_n, h2), seed, ns, para, True, f"p{stage[1]}")
    units = {s: dict(Counter(r["unit"] for r in runs if r["stage"] == s)) for s in EXT_STAGES}
    return {"schema": "manifest/1", "seed": seed, "namespace": ns,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sidecar_of": "manifest.json", "addendum": 1, "p8_n": p8_n if with_p8 else 0,
            "paraphrases": {t: ("p1..p5 rotating by round" if ok else "base text (paraphrase files missing)")
                            for t, ok in para.items()},
            "stage_counts": {s: sum(1 for r in runs if r["stage"] == s) for s in EXT_STAGES
                             if any(r["stage"] == s for r in runs)},
            "units": {s: u for s, u in units.items() if u}, "runs": runs}


def ext1_path(ns: str) -> Path:
    return paths.manifest_path(ns).with_name(EXT1_NAME)


def write_ext1(ns: str, seed: int = EXT1_SEED, *, with_p7: bool = True, with_p8: bool = True, p8_n: int = P8_N,
               force: bool = False) -> tuple[Path, dict]:
    """Write results/<ns>/manifest-ext1.json. Refused once the addendum is frozen (real ns), or if it exists and
    (no --force, or a P7/P8 run has started)."""
    out = ext1_path(ns)
    if not paths.manifest_path(ns).exists():
        raise RuntimeError(f"no {paths.manifest_path(ns)}: generate the manifest first")
    if ns == "real":
        from harness import prereg
        if prereg.addendum_lock_path(1).exists():
            raise RuntimeError("the addendum is frozen (PREREGISTRATION-ADDENDUM-1.lock): the P7/P8 manifest cannot "
                               "change")
    if out.exists():
        state = jsonio.read_json(paths.state_path(ns)) or {}
        started = [rid for rid, r in state.get("runs", {}).items()
                   if rid.startswith(("p7-", "p8-")) and r.get("status", "pending") != "pending"]
        if not force or started:
            raise RuntimeError(f"{out} exists" + (f" and {len(started)} P7/P8 run(s) have started" if started
                                                  else "; pass --force to overwrite"))
    m = generate_ext1(seed, ns, with_p7, with_p8, p8_n)
    errs = validate(m)
    if errs:
        raise RuntimeError(f"addendum-1 sidecar does not match the contract schema: {errs[:3]}")
    jsonio.write_json_atomic(out, m)
    return out, m


def with_ext1(m: dict, ns: str) -> dict:
    side = jsonio.read_json(ext1_path(ns))
    if side is None:
        return m
    known = {r["run_id"] for r in m.get("runs", [])}
    return dict(m, runs=list(m.get("runs", [])) + [r for r in side["runs"] if r["run_id"] not in known],
                ext1_sidecar={"file": EXT1_NAME, "sha256": sha256(ext1_path(ns)), "runs": len(side["runs"]),
                              "seed": side.get("seed"), "p8_n": side.get("p8_n")})


def calibration_runs(ns: str) -> list[dict]:
    """C8: the agy-flash calibration (like P0: base text, never analysed as results)."""
    return [dict(r, calibration=True) for r in _ext_runs("C8", ext_cells("C8"), EXT1_SEED, ns, {}, False, "c8")]


def with_calibration(m: dict, ns: str) -> dict:
    known = {r["run_id"] for r in m.get("runs", [])}
    return dict(m, runs=list(m.get("runs", [])) + [r for r in calibration_runs(ns) if r["run_id"] not in known])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m harness.manifest")
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--ns", choices=["real", "mock"], default="real")
    ap.add_argument("--with-p6", action="store_true", help="also generate the P6 (codex) copies")
    ap.add_argument("--force", action="store_true", help="overwrite an existing manifest (never after the freeze)")
    ap.add_argument("--print", action="store_true", help="print the stage counts and do not write")
    ap.add_argument("--p1-variant", choices=sorted(P1_VARIANTS),
                    help="H2 tickets for P1: xremove = X-rename + X-remove, xapi = X-rename + X-api (with --print; "
                         "writing needs H2_TICKETS in harness/manifest.py set to the same variant)")
    ap.add_argument("--p6-sidecar", action="store_true",
                    help=f"write results/<ns>/{P6_NAME}: the P6 runs beside a manifest.json that has none (with --print: "
                         "counts only)")
    ap.add_argument("--ext1-sidecar", action="store_true",
                    help=f"write results/<ns>/{EXT1_NAME}: the addendum-1 runs (P7 and/or P8; with --print: counts only)")
    ap.add_argument("--with-p7", action="store_true", help="with --ext1-sidecar: include P7 (cc-sonnet 240 + codex 240)")
    ap.add_argument("--with-p8", action="store_true", help="with --ext1-sidecar: include P8 (agy-flash, 6 cells × --p8-n)")
    ap.add_argument("--p8-n", type=int, default=P8_N, help=f"runs per P8 cell (default {P8_N}; Alfredo's call after C8)")
    a = ap.parse_args(argv)
    if a.ext1_sidecar:
        if not (a.with_p7 or a.with_p8):
            print("--ext1-sidecar needs --with-p7 and/or --with-p8", file=sys.stderr)
            return 2
        seed = a.seed if a.seed != SEED else EXT1_SEED
        if a.print:
            m = generate_ext1(seed, a.ns, a.with_p7, a.with_p8, a.p8_n)
            print(json.dumps({"seed": seed, "stage_counts": m["stage_counts"], "units": m["units"]}))
            return 0
        try:
            out, m = write_ext1(a.ns, seed, with_p7=a.with_p7, with_p8=a.with_p8, p8_n=a.p8_n, force=a.force)
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return 2
        print(f"wrote {out}: {m['stage_counts']} {m['units']}  seed {seed}  sha256 {sha256(out)}")
        return 0
    if a.p6_sidecar:
        if a.print:
            m = generate_p6(a.seed, a.ns)
            print(json.dumps({"stage_counts": m["stage_counts"], "parts": m["parts"]}))
            return 0
        try:
            out, m = write_p6(a.ns, a.seed, force=a.force)
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return 2
        print(f"wrote {out}: {m['parts']} = {m['stage_counts']['P6']} runs  sha256 {sha256(out)}")
        return 0
    h2 = P1_VARIANTS[a.p1_variant] if a.p1_variant else None
    m = generate(a.seed, a.ns, a.with_p6, h2=h2)
    errs = validate(m)
    if errs:
        print("manifest does not match the contract schema:", errs[:3], file=sys.stderr)
        return 1
    if a.print and a.p1_variant:
        p1 = sorted({r["cell"] for r in m["runs"] if r["stage"] == "P1"})
        print(json.dumps({"variant": a.p1_variant, "h2_tickets": list(h2), "current_switch": list(H2_TICKETS),
                          "stage_counts": m["stage_counts"], "p1_cells": p1,
                          "pilots": {st: len(pilot_runs(a.ns, st)) for st in PILOTS}}, indent=2))
        return 0
    if a.print:
        print(json.dumps(m["stage_counts"]))
        return 0
    if h2 is not None and h2 != H2_TICKETS:
        print(f"--p1-variant {a.p1_variant} differs from H2_TICKETS {H2_TICKETS} (harness/manifest.py); set the switch "
              "first so the manifest and the analysis agree", file=sys.stderr)
        return 2
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
