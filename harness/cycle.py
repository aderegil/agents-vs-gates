"""One run, end to end (spec 10.6): workspace -> gen -> CI -> detectors -> repair loop -> oracle + ticket_done on
`gen` and on the final state (ticket_done = final) -> outcome -> sanitize -> archive (spec 10.7) -> clean workspace.

    execute_run(entry, ns=..., worker_ns=..., worker=k, units=..., pipeline=Pipeline()) -> record
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from harness import covariates, detectors, gitutil, jsonio, outcome, paths, record as record_mod, repair, sanitize, scenario_io
from harness import trace as trace_mod
from harness.adapters.base import Limits, load_adapter, now_iso
from harness.workspace import materialize


class Pipeline:
    """WP1 bindings (CI, oracle, ticket_done). Tests inject fakes with the same three methods."""

    def run_ci(self, ws_root: Path, V: str, run_id: str) -> dict:
        from ci.run import run_ci
        return run_ci(Path(ws_root), V, run_id)

    def run_oracle(self, service_dir: Path) -> dict:
        from oracle.run import run_oracle
        return run_oracle(Path(service_dir))

    def check_ticket(self, service_dir: Path, ticket: str) -> dict:
        from oracle.acceptance import check_ticket
        return check_ticket(Path(service_dir), ticket)


def wp1_missing() -> list[str]:
    import importlib
    missing = []
    for mod, attr in (("ci.run", "run_ci"), ("oracle.run", "run_oracle"), ("oracle.acceptance", "check_ticket")):
        try:
            if not hasattr(importlib.import_module(mod), attr):
                missing.append(f"{mod}.{attr}")
        except ImportError:
            missing.append(f"{mod}.{attr}")
    if not (paths.SOLUTIONS / "index.json").exists():
        missing.append("scenario/solutions/index.json")
    return missing


def load_units() -> dict:
    return json.loads(paths.UNITS.read_text(encoding="utf-8"))


def execute_run(entry: dict, *, ns: str, worker_ns: str, worker: int, units: dict | None = None,
                pipeline=None, on_event=None, mock_script: dict | None = None, seed: int = 0,
                infra_retries: int = 0, archive: bool = True) -> dict:
    """entry: a manifest run ({run_id, stage, unit, ticket, wording, paraphrase, visibility, spec, replicate, cell}).
    ns: results namespace (real|mock). worker_ns: worker-dir family (real|mock|selftest)."""
    units = units or load_units()
    pipeline = pipeline or Pipeline()
    run_id, ticket, V, S = entry["run_id"], entry["ticket"], entry["visibility"], entry["spec"]
    unit = dict(units[entry["unit"]], name=entry["unit"])
    adapter = load_adapter(unit["adapter"])
    started, t0 = now_iso(), time.monotonic()
    ws = materialize(worker_ns, worker, entry["unit"], ticket, V, S, units=units)
    ws.mock_script = mock_script
    prompt = scenario_io.ticket_text(ticket, entry.get("wording", "W1"), entry.get("paraphrase"))
    def cb(ev):
        if on_event:
            on_event(ev)

    gen = adapter.run_session(ws, prompt, unit=unit, limits=Limits.for_session("gen"), on_event=cb)
    sessions, ci, dets, diffstats = [gen], [], [], {}
    infra, gen_changed = gen.infra, False
    if not infra:
        ws.commit("gen")
        diffstats["gen"] = gitutil.numstat(ws.root, "base", "gen")
        gen_changed = diffstats["gen"]["files_changed"] > 0
        ci.append(repair.run_ci_entry(pipeline, ws, 0, "gen", run_id))
        dets.extend(repair.detector_entries(ws, 0, "gen", None))
        infra = repair.repair_loop(ws=ws, adapter=adapter, unit=unit, run_id=run_id, pipeline=pipeline,
                                   gen_session=gen, ci=ci, dets=dets, sessions=sessions, on_event=cb,
                                   diffstats=diffstats)
    last_ref = ci[-1]["ref"] if ci else None
    # transcript from the sessions' own event lists (adapters may amend an emitted event, e.g. late denials)
    transcript = [ev for s in sessions for ev in s.events]
    oracle_gen = oracle_final = ticket_gen = ticket_final = None
    timing: dict = {}
    if not infra:
        t = now_iso()
        svc = ws.archive("gen")
        oracle_gen = pipeline.run_oracle(svc)
        ticket_gen = pipeline.check_ticket(svc, ticket)
        timing["oracle_gen"] = {"started_at": t, "ended_at": now_iso()}
        if last_ref != "gen":
            # ticket_done is judged on the PR as it ends too: a repair can undo the ticket to get CI green
            t = now_iso()
            svc = ws.archive(last_ref)
            oracle_final = pipeline.run_oracle(svc)
            ticket_final = pipeline.check_ticket(svc, ticket)
            timing["oracle_final"] = {"started_at": t, "ended_at": now_iso()}
        else:
            oracle_final, ticket_final = oracle_gen, ticket_gen
            timing["oracle_final"] = timing["oracle_gen"]

    diffs = {}
    prev = "base"
    for c in ci:
        diffs[c["ref"]] = ws.diff(prev, c["ref"])
        prev = c["ref"]
    oos = sorted({p for ref in diffs for p in detectors.out_of_scope_edits(ws.root, "base", ref)}) if V == "V2" else []
    ooa = detectors.out_of_workspace_access(transcript, ws.root)
    last = sessions[-1]
    out = outcome.assign_outcome(infra=infra, gen_changed=gen_changed, ci=ci, detectors=dets,
                                 last_session_capped=bool(last.capped), final_message=last.final_text)
    if infra and infra.get("kind") is not None:
        infra = dict(infra, final=False)
    ctx_name = ws.context_file
    sess_entries = []
    for s in sessions:
        e = s.record_entry()
        e["ref"] = s.session if (not s.infra) else None
        e["diffstat"] = diffstats.get(s.session)
        sess_entries.append(e)
    rec = record_mod.build(
        entry=entry, ns=ns, unit=unit, seed=seed, worker=worker, started_at=started, ended_at=now_iso(),
        duration_ms=int((time.monotonic() - t0) * 1000), sessions=sess_entries, gen=gen, ci=ci, dets=dets,
        oracle_gen=oracle_gen, oracle_final=oracle_final, ticket_gen=ticket_gen, ticket_final=ticket_final, outcome=out, infra=infra,
        infra_retries=infra_retries, out_of_scope=oos, out_of_workspace=ooa, final_message=last.final_text,
        ticket_text=prompt, context_file=ctx_name, timing=timing, ws_notes=ws.notes)
    rec["covariates"] = covariates.compute(transcript)   # ran_tests, shell_denials (calibration finding from P0)

    # canaries over transcript + diffs + final message; then token/user-path scrubbing everywhere
    hits = sanitize.canary_hits(json.dumps(transcript, ensure_ascii=False), "transcript")
    for ref, d in diffs.items():
        hits += sanitize.canary_hits(d, f"diffs/{ref}.diff")
    rec["contamination"] = {"flag": bool(hits), "hits": hits}
    transcript_c, e1 = sanitize.clean_obj(transcript)
    diffs_c = {}
    e2 = False
    for ref, d in diffs.items():
        diffs_c[ref], e = sanitize.clean(d)
        e2 |= e
    rec, e3 = sanitize.clean_obj(rec)
    rec["token_exposed"] = bool(e1 or e2 or e3)
    scan_bundle(ws, rec)
    events = trace_mod.build(rec, transcript_c)
    events, e4 = sanitize.clean_obj(events)
    if e4:
        rec["token_exposed"] = True
    if archive:
        archive_run(ns, run_id, rec, transcript_c, diffs_c, events, ws)
    ws.clean()
    return rec


def scan_bundle(ws, rec: dict) -> None:
    """workspace.bundle archives the raw git history, which the sanitizer never sees (agent-made commits, branches,
    commit messages). Scan it for tokens, user paths and canaries and flag the record (Codex audit 2026-10-11)."""
    try:
        scan = sanitize.scan(gitutil.history_text(ws.root), "workspace.bundle")
    except gitutil.GitError as e:
        rec.setdefault("archive_notes", []).append(f"bundle history scan failed: {e}")
        return
    rec["bundle_scan"] = {"token": scan["token"], "user_paths": scan["user_paths"], "canary": len(scan["canary_hits"])}
    if scan["token"]:
        rec["token_exposed"] = True
    if scan["canary_hits"]:
        con = rec.setdefault("contamination", {"flag": False, "hits": []})
        con["flag"] = True
        con.setdefault("hits", []).extend(scan["canary_hits"])


def archive_run(ns: str, run_id: str, rec: dict, transcript: list, diffs: dict, events: list, ws) -> Path:
    d = paths.run_dir(ns, run_id)
    gitutil.rmtree(d)
    (d / "diffs").mkdir(parents=True)
    jsonio.write_jsonl(d / "transcript.jsonl", transcript)
    for ref, text in diffs.items():
        (d / "diffs" / f"{ref}.diff").write_text(text, encoding="utf-8", newline="\n")
    try:
        ws.bundle(d / "workspace.bundle")
    except gitutil.GitError as e:
        rec.setdefault("archive_notes", []).append(f"bundle failed: {e}")
    jsonio.write_jsonl(d / "events.jsonl", events)
    from trace.validate import validate_events
    violations = validate_events(events)
    rec["trace_valid"] = not violations
    if violations:
        rec["trace_violations"] = violations[:20]
    record_mod.write(d / "record.json", rec)
    return d
