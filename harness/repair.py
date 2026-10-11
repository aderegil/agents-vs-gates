"""Repair loop (spec 10.6 step 5) and the frozen CI feedback message (spec 7.5, harness/texts/ci_feedback.md)."""
from __future__ import annotations

from harness import detectors, gitutil, paths
from harness.adapters.base import Limits, now_iso

MAX_REPAIRS = 3
FEEDBACK_TEMPLATE = paths.REPO / "harness" / "texts" / "ci_feedback.md"


def feedback_message(verdict: dict) -> str:
    """Exact §7.5 text with the verdict's feedback_text (already ≤ 6000 chars per the CI contract)."""
    tpl = FEEDBACK_TEMPLATE.read_text(encoding="utf-8").rstrip("\n")
    return tpl.replace("{feedback_text}", (verdict.get("feedback_text") or "").strip("\n"))


def detector_entries(ws, attempt: int, ref: str, prev: str | None) -> list[dict]:
    """Detectors after a session: base..ref, plus prev..ref for repairs (spec 10.6)."""
    out = [{"attempt": attempt, "ref": ref, "range": f"base..{ref}",
            "flags": detectors.detect(ws.root, "base", ref, ws.service_prefix)}]
    if prev:
        out.append({"attempt": attempt, "ref": ref, "range": f"{prev}..{ref}",
                    "flags": detectors.detect(ws.root, prev, ref, ws.service_prefix)})
    return out


def run_ci_entry(pipeline, ws, attempt: int, ref: str, run_id: str) -> dict:
    t0 = now_iso()
    verdict = pipeline.run_ci(ws.root, ws.V, run_id)
    return {"attempt": attempt, "ref": ref, "verdict": verdict, "started_at": t0, "ended_at": now_iso()}


def repair_loop(*, ws, adapter, unit: dict, run_id: str, pipeline, gen_session, ci: list, dets: list,
                sessions: list, on_event, diffstats: dict) -> dict | None:
    """Mutates ci/dets/sessions; returns an infra dict if a repair session failed for infrastructure reasons."""
    prev = "gen"
    session_id = gen_session.session_id
    for n in range(1, MAX_REPAIRS + 1):
        if ci[-1]["verdict"]["ok"]:
            return None
        ref = f"fix{n}"
        msg = feedback_message(ci[-1]["verdict"])
        res = adapter.run_session(ws, msg, resume=session_id, unit=unit, limits=Limits.for_session(ref),
                                  on_event=on_event)
        sessions.append(res)
        if res.infra:
            return res.infra
        session_id = res.session_id or session_id
        ws.commit(ref)
        diffstats[ref] = gitutil.numstat(ws.root, prev, ref)
        ci.append(run_ci_entry(pipeline, ws, n, ref, run_id))
        dets.extend(detector_entries(ws, n, ref, prev))
        prev = ref
    return None
