"""record.json (spec 10.7; contract docs/contracts/record.schema.json). Validated before it is written."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from harness import jsonio, outcome as outcome_mod, paths, scenario_io

SCHEMA = paths.CONTRACTS / "record.schema.json"


@lru_cache(maxsize=1)
def _validator():
    import jsonschema
    return jsonschema.Draft7Validator(json.loads(SCHEMA.read_text(encoding="utf-8")))


def validate(rec: dict) -> list[str]:
    return [f"{'/'.join(map(str, e.absolute_path))}: {e.message}" for e in _validator().iter_errors(rec)]


def write(path: Path, rec: dict) -> None:
    errs = validate(rec)
    if errs:
        raise ValueError("record.json does not match the contract schema: " + "; ".join(errs[:5]))
    jsonio.write_json_atomic(path, rec)


@lru_cache(maxsize=1)
def _scenario_hash() -> str:
    return scenario_io.scenario_hash()


def _totals(sessions: list[dict]) -> dict:
    t = {"turns": 0, "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_creation_tokens": 0,
         "cost_usd_nominal": 0.0}
    for s in sessions:
        u = s.get("usage") or {}
        t["turns"] += s.get("num_turns") or 0
        t["input_tokens"] += u.get("input_tokens", 0)
        t["output_tokens"] += u.get("output_tokens", 0)
        t["cache_read_tokens"] += u.get("cache_read_input_tokens", 0)
        t["cache_creation_tokens"] += u.get("cache_creation_input_tokens", 0)
        t["cost_usd_nominal"] += s.get("cost_usd_nominal") or 0.0
    t["cost_usd_nominal"] = round(t["cost_usd_nominal"], 6)
    return t


def build(*, entry, ns, unit, seed, worker, started_at, ended_at, duration_ms, sessions, gen, ci, dets, oracle_gen,
          oracle_final, ticket_gen, ticket_final, outcome, infra, infra_retries, out_of_scope, out_of_workspace, final_message,
          ticket_text, context_file, timing, ws_notes=()) -> dict:
    rec = {
        "schema": "record/1",
        "run_id": entry["run_id"], "namespace": ns, "stage": entry["stage"], "unit": unit["name"],
        "adapter": unit["adapter"], "model_requested": unit.get("model"), "model_reported": gen.model_reported,
        "effort": unit.get("effort"), "cli_version": gen.cli_version,
        "ticket": entry["ticket"], "wording": entry.get("wording", "W1"), "paraphrase": entry.get("paraphrase"),
        "visibility": entry["visibility"], "spec": entry["spec"], "replicate": int(entry.get("replicate", 1)),
        "cell": entry.get("cell") or f"{entry['ticket']}|{entry['visibility']}|{entry['spec']}|"
                                      f"{entry.get('wording', 'W1')}|{unit['name']}",
        "seed": int(seed), "scenario_hash": _scenario_hash(), "worker": worker,
        "started_at": started_at, "ended_at": ended_at, "duration_ms": int(duration_ms),
        "sessions": sessions, "totals": _totals(sessions),
        "ci": ci, "detectors": dets,
        "oracle": {"gen": oracle_gen, "final": oracle_final},
        "ticket_done": (ticket_final or {}).get("ticket_done"),    # the PR as it ends (equals gen without repairs)
        "metrics": outcome_mod.metrics(ci=ci, oracle_gen=oracle_gen, oracle_final=oracle_final, ticket=ticket_gen,
                                       detectors=dets),
        "repair_attempts": max(0, len(ci) - 1),
        "outcome": outcome, "infra_failure": infra, "infra_retries": int(infra_retries),
        "contamination": {"flag": False, "hits": []}, "token_exposed": False,
        "out_of_workspace_access": out_of_workspace, "out_of_scope_edits": out_of_scope,
        "final_message": final_message, "isolation": gen.isolation,
        # additive fields (not in the schema's required set; used by trace.py and analysis)
        "ticket_text": ticket_text, "context_file": context_file, "timing": timing,
        "ticket_check": ticket_final, "ticket_done_gen": (ticket_gen or {}).get("ticket_done"),
        "ticket_check_gen": ticket_gen,
    }
    if ws_notes:
        rec["notes"] = list(ws_notes)
    return rec
