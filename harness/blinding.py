"""Blinding rules shared by the runner and the console (spec 11.4, 21.5, 22.3).

A stage's outcomes are visible only if:
  - the stage is in ALWAYS_VISIBLE (P0 calibration, the mock selftest), or
  - state["unblinded"][stage] exists (set by `runner --unblind`, which requires the stage to be
    complete unless --force-unblind is passed).
"""
from __future__ import annotations

from datetime import datetime, timezone

ALWAYS_VISIBLE = {"P0", "selftest"}
TERMINAL = {"done", "infra_failure_final"}


def stage_runs(manifest: dict | None, stage: str) -> list[dict]:
    return [r for r in (manifest or {}).get("runs", []) if r.get("stage") == stage]


def stage_complete(manifest: dict | None, state: dict | None, stage: str) -> bool:
    runs = stage_runs(manifest, stage)
    if not runs:
        return False
    st = (state or {}).get("runs", {})
    return all(st.get(r["run_id"], {}).get("status") in TERMINAL for r in runs)


def is_visible(state: dict | None, stage: str | None) -> bool:
    if stage in ALWAYS_VISIBLE:
        return True
    return bool(stage and (state or {}).get("unblinded", {}).get(stage))


def unblind(state: dict, manifest: dict, stage: str, *, force: bool = False, by: str = "cli") -> dict:
    """Mutates and returns state. Raises ValueError if the stage is incomplete and not forced."""
    complete = stage_complete(manifest, state, stage)
    if not complete and not force:
        raise ValueError(f"stage {stage} is not complete; pass --force-unblind to override (it is recorded)")
    state.setdefault("unblinded", {})[stage] = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "forced": bool(force and not complete),
        "by": by,
    }
    return state


def redact_record(record: dict, state: dict | None) -> dict:
    """Copy of a record with every outcome-bearing field removed when its stage is blinded."""
    if is_visible(state, record.get("stage")):
        return record
    hidden = {"outcome", "ticket_done", "ticket_done_gen", "ticket_check", "ticket_check_gen", "metrics", "oracle", "ci",
              "detectors", "final_message", "repair_attempts", "reviews"}
    out = {k: v for k, v in record.items() if k not in hidden}
    out["blinded"] = True
    return out
