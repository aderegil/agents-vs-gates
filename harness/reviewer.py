"""RQ4 reviewer study (spec 12): one tool-less call per PR × condition (R-S0, R-S2, R-C) (+ 3× repeats in R-S0 and
R-C for the repeat subsample).

  python -m harness.reviewer --ns mock --mock [--seed 20261011]       deterministic mock reviewer (tests, demo)
  python -m harness.reviewer --ns real --unit cc-sonnet [--limit N]   real calls (P3; needs the pre-registration lock)
  python -m harness.reviewer --print-argv                              show the exact argv of one call

Input: results/<ns>/reviews/pr_set.json (analysis.build_pr_set). Output: results/<ns>/reviews/reviews.jsonl
(one row per review; resumable: existing review_ids are skipped) and prompts/<review_id>.sha256 (prompt hashes).
Prompt templates are the frozen files harness/texts/reviewer_prompt.md and reviewer_contracts_block.md.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from harness import authenv, gitutil, jsonio, paths, sanitize, scenario_io

TEXTS = paths.REPO / "harness" / "texts"
CONDITIONS = ("R-S0", "R-S2", "R-C")
RESPONSE_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["verdict", "reasons"],
                   "properties": {"verdict": {"enum": ["approve", "request_changes"]},
                                  "reasons": {"type": "array", "items": {"type": "string"}, "maxItems": 5}}}
CALLS = 0


def reviews_dir(ns: str) -> Path:
    return paths.ns_dir(ns) / "reviews"


def broker_contracts() -> str:
    """All broker JSONs (canary keys stripped), each preceded by its file name."""
    broker = paths.REPOS / "architecture" / "broker"
    parts = []
    for p in sorted(broker.glob("*.json")) if broker.exists() else []:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.pop("_canary", None)
        parts.append(f"{p.name}\n{json.dumps(data, indent=2)}")
    return "\n\n".join(parts)


def build_prompt(*, condition: str, ticket_text: str, diff: str, changed_files: str) -> str:
    tpl = (TEXTS / "reviewer_prompt.md").read_text(encoding="utf-8").rstrip("\n")
    ctx = scenario_io.context_text("S0" if condition == "R-S0" else "S2").rstrip("\n")
    block = ""
    if condition == "R-C":
        block = (TEXTS / "reviewer_contracts_block.md").read_text(encoding="utf-8").replace(
            "{contracts}", broker_contracts())
    # single-pass substitution: a diff may itself contain "{ticket}" etc.
    vals = {"{context_file}": ctx, "{contracts_block}": block, "{ticket}": ticket_text, "{diff}": diff.rstrip("\n"),
            "{changed_files}": changed_files.rstrip("\n")}
    import re
    return re.sub("|".join(re.escape(k) for k in vals), lambda m: vals[m.group(0)], tpl)


def pr_material(ns: str, run_id: str) -> dict:
    """Diff of gen (base..gen) and full content of the changed files at gen, from the archived run."""
    d = paths.run_dir(ns, run_id)
    rec = jsonio.read_json(d / "record.json")
    diff = (d / "diffs" / "gen.diff").read_text(encoding="utf-8") if (d / "diffs" / "gen.diff").exists() else ""
    files = []
    bundle = d / "workspace.bundle"
    if bundle.exists():
        with tempfile.TemporaryDirectory(prefix="avg-rev-") as tmp:
            clone = Path(tmp) / "c"
            gitutil.git(Path(tmp), "clone", "-q", str(bundle), str(clone))
            for st, path, _old in gitutil.name_status(clone, "base", "gen"):
                if st == "D":
                    files.append(f"--- {path} (deleted)")
                    continue
                content = gitutil.show(clone, "gen", path) or ""
                content, _ = sanitize.clean(content)
                files.append(f"--- {path}\n{content.rstrip()}")
    return {"record": rec, "diff": diff, "changed_files": "\n\n".join(files)}


def build_argv(unit: dict) -> list[str]:
    from harness.adapters import claude_code
    return [claude_code.claude_exe(), "-p", "--model", unit["model"], "--effort", unit.get("effort") or "medium",
            "--tools", "", "--output-format", "json", "--json-schema", json.dumps(RESPONSE_SCHEMA, separators=(",", ":")),
            *claude_code.isolation_flags()]


def call_real(unit: dict, prompt: str, cfg: Path) -> dict:
    """One real reviewer call (stdin prompt, empty temp cwd, isolated config). Only via the CLI with a lock."""
    global CALLS
    from harness.adapters import claude_code
    claude_code.prepare_cfg(cfg)
    CALLS += 1
    t0 = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="avg-review-") as cwd:
        p = subprocess.run(build_argv(unit), input=prompt, cwd=cwd, env=claude_code.build_env(cfg),
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    out = {"duration_ms": int((time.monotonic() - t0) * 1000), "verdict": None, "reasons": [], "usage": {},
           "cost_usd": None, "error": None}
    try:
        res = json.loads(p.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        out["error"] = f"unparseable output (exit {p.returncode}): {sanitize.clean(p.stderr[-300:])[0]}"
        return out
    so = res.get("structured_output")
    if so is None:
        try:
            so = json.loads(res.get("result") or "")
        except ValueError:
            so = None
    if isinstance(so, dict) and so.get("verdict") in ("approve", "request_changes"):
        out["verdict"], out["reasons"] = so["verdict"], [str(r) for r in so.get("reasons", [])][:5]
    else:
        out["error"] = "no structured verdict"
    out["usage"] = {k: int((res.get("usage") or {}).get(k) or 0) for k in
                    ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")}
    out["cost_usd"] = res.get("total_cost_usd")
    return out


MOCK_P_CATCH = {"R-S0": 0.3, "R-S2": 0.6, "R-C": 0.9}
MOCK_P_FALSE_ALARM = 0.1


def call_mock(pr: dict, condition: str, rep: int, seed: int) -> dict:
    """Deterministic pseudo-random verdicts: catch probability rises with information (R-S0 < R-S2 < R-C)."""
    rng = random.Random(f"{seed}|{pr['pr_id']}|{condition}|{rep}")
    bad = pr["category"] in ("breaking", "semantic")
    rc = rng.random() < (MOCK_P_CATCH[condition] if bad else MOCK_P_FALSE_ALARM)
    cons = ", ".join(pr.get("affected_consumers") or []) or "a consumer"
    reasons = ([f"(mock) The change to the published contract may break {cons}." if condition != "R-S0"
                else "(mock) Renaming or removing fields of a published event is risky."] if rc
               else ["(mock) The change is small and matches the ticket."])
    return {"duration_ms": 0, "verdict": "request_changes" if rc else "approve", "reasons": reasons,
            "usage": {"input_tokens": 3000 + rng.randrange(1500), "output_tokens": 120 + rng.randrange(80),
                      "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}, "cost_usd": 0.0, "error": None}


def plan(pr_set: dict) -> list[tuple[dict, str, int]]:
    jobs = []
    for pr in pr_set["prs"]:
        for cond in CONDITIONS:
            reps = 3 if (pr.get("repeat_subsample") and cond in ("R-S0", "R-C")) else 1
            jobs += [(pr, cond, rep) for rep in range(1, reps + 1)]
    return jobs


def run(ns: str, *, mock: bool, unit_name: str = "cc-sonnet", seed: int = 20261011, limit: int | None = None) -> dict:
    rdir = reviews_dir(ns)
    pr_set = jsonio.read_json(rdir / "pr_set.json")
    if not pr_set:
        raise SystemExit(f"{rdir / 'pr_set.json'} missing: run `python -m analysis.build_pr_set --ns {ns}` first")
    units = json.loads(paths.UNITS.read_text(encoding="utf-8"))
    unit = dict(units.get(unit_name, {}), name=unit_name)
    out_path = rdir / "reviews.jsonl"
    done = {r["review_id"] for r in jsonio.read_jsonl(out_path)}
    material_cache: dict[str, dict] = {}
    n_new = 0
    for pr, cond, rep in plan(pr_set):
        rid = f"{pr['pr_id']}-{cond}-{rep}"
        if rid in done:
            continue
        if limit is not None and n_new >= limit:
            break
        mat = material_cache.get(pr["run_id"]) or material_cache.setdefault(pr["run_id"], pr_material(ns, pr["run_id"]))
        rec = mat["record"] or {}
        prompt = build_prompt(condition=cond, ticket_text=rec.get("ticket_text") or
                              scenario_io.ticket_text(pr["ticket"], rec.get("wording", "W1"), rec.get("paraphrase")),
                              diff=mat["diff"], changed_files=mat["changed_files"])
        res = call_mock(pr, cond, rep, seed) if mock else call_real(unit, prompt, paths.cfg_dir("real", 1).parent / "reviewer")
        row = {"review_id": rid, "pr_id": pr["pr_id"], "run_id": pr["run_id"], "condition": cond, "rep": rep,
               "reviewer_unit": "mock" if mock else unit_name, "mock": mock,
               "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               **res}
        row, _ = sanitize.clean_obj(row)
        jsonio.append_jsonl(out_path, row)
        n_new += 1
    return {"new": n_new, "total": len(done) + n_new, "planned": len(plan(pr_set))}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m harness.reviewer")
    ap.add_argument("--ns", choices=["real", "mock"], default="mock")
    ap.add_argument("--mock", action="store_true", help="deterministic mock reviewer (no model calls)")
    ap.add_argument("--unit", default="cc-sonnet")
    ap.add_argument("--seed", type=int, default=20261011)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--print-argv", action="store_true")
    a = ap.parse_args(argv)
    units = json.loads(paths.UNITS.read_text(encoding="utf-8"))
    if a.print_argv:
        print(json.dumps(build_argv(dict(units[a.unit], name=a.unit)), indent=1))
        return 0
    if not a.mock:
        if a.ns != "real":
            print("real reviewer calls go to the real namespace (--ns real)", file=sys.stderr)
            return 2
        from harness import prereg
        ok, problems = prereg.verify()
        if not ok:
            print("refused: pre-registration lock missing or changed: " + "; ".join(problems[:5]), file=sys.stderr)
            return 2
        if not authenv.oauth_token():
            print("refused: no CLAUDE_CODE_OAUTH_TOKEN in C:\\avg\\.env", file=sys.stderr)
            return 2
    print(json.dumps(run(a.ns, mock=a.mock, unit_name=a.unit, seed=a.seed, limit=a.limit)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
