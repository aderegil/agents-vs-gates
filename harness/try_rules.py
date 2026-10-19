"""Try your own rules file on the experiment's tickets ("Try it on your AI-SDLC", docs/USING.md).

  python -X utf8 -m harness.try_rules --context my-rules.md --unit mock
  python -X utf8 -m harness.try_rules --context my-rules.md --unit cc-sonnet --live --n 3

Your file takes the place of the experiment's S text (scenario/context/orders-service/S*.md) as the agent's context
file, under the name the unit's adapter reads (CLAUDE.md, AGENTS.md or GEMINI.md; a unit's "context_file" wins). Each
ticket then runs N times through the experiment's own cycle (harness.cycle.execute_run): the agent's session, CI with
ARCH-1..8, up to 3 repair sessions on CI feedback, and the other teams' own tests (oracle/) on the first attempt and on
the final state. Nothing is blinded: the verdict is printed at the end.

Isolation: everything goes to results/try/ (manifest.json, state.json, runs/<run_id>/, contexts/, verdicts/) and to
the worker folders C:\\avg\\wt<k> (cfg\\wt<k>). It never reads or writes results/real or results/mock, never uses the
experiment's worker folders (w<k>, wm<k>, wst), never needs the pre-registration locks, and never writes to the repo.

Options:
  --tickets X-rename,X-remove   tickets to run (any of scenario/tasks; default: the two consumer-contract tickets)
  --n 3                         runs per ticket (1..50)
  --visibility V0               V0 orders-service only; V1 + the consumer contracts; V2 + the consumer repos
  --workers 1                   parallel runs (1..3); each needs its wt<k> ready, mock included, since CI runs
                                `npm test` there: python -m harness.doctor --setup-workers N --ns try
  --live                        required for any unit but the mock: real agent sessions, real quota
  --mock-as S0                  the mock agent is scripted and never reads your file: it plays the experiment's script
                                for S0 (no rules), S1 or S2 (rules)
  --units-file my-units.json    extra units, e.g. one for your own adapter (never replaces a frozen unit)
  --quiet                       print only the verdict
Exit codes: 0 done, 2 refused (bad input or isolation guard), 3 rate-limited, 4 isolation breach.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
import traceback
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from harness import jsonio, paths, scenario_io

NS = paths.TRY_NS
STAGE = "try"
SPEC = "custom"                      # record.spec of a try run: your file, not one of the frozen S texts
DEFAULT_TICKETS = ("X-rename", "X-remove")
MAX_N = 50
MAX_WORKERS = 3
MAX_CONTEXT_BYTES = 256 * 1024
MAX_INFRA_RETRIES = 2
EXPERIMENT_WORKERS = range(1, 9)     # the runner accepts up to 8 workers: w1..w8, wm1..wm8
EXIT_OK, EXIT_GUARD, EXIT_RATE, EXIT_BREACH = 0, 2, 3, 4
TICKET_WORDS = {"done": "done", "deprecated": "kept as deprecated", "not_done": "not done"}


class Refused(Exception):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ---------------------------------------------------------------- isolation guard --------------------------------

def _overlap(a: Path, b: Path) -> bool:
    a, b = a.resolve(), b.resolve()
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


def isolation_problems(workers: int = MAX_WORKERS) -> list[str]:
    """Why results/try or the wt<k> worker folders could touch the experiment's data, if they could. Paths are
    resolved, so a junction or symlink that points into results/real or a w<k> folder is caught too."""
    errs = []
    mine = paths.ns_dir(NS)
    theirs = {}
    for ns in paths.NAMESPACES:
        theirs[f"results/{ns}"] = paths.ns_dir(ns)
        theirs[f"the repo's results/{ns}"] = paths.REPO / "results" / ns    # AVG_RESULTS_ROOT pointed inside it
    for label, d in theirs.items():
        if _overlap(mine, d):
            errs.append(f"the try folder {mine} overlaps {label} ({d.resolve()})")
    if not errs:   # only look inside results/try once it is known not to be an experiment folder
        for f in ("manifest.json", "state.json"):
            data = jsonio.read_json(mine / f)
            if isinstance(data, dict) and data.get("namespace") != NS:
                errs.append(f"{mine / f} is not a try file (namespace {data.get('namespace')!r})")
    exp_workers = [paths.worker_dir(ns, k) for ns in paths.NAMESPACES for k in EXPERIMENT_WORKERS]
    exp_workers.append(paths.worker_dir("selftest", 1))
    exp_cfg = [paths.cfg_dir(ns, k) for ns in paths.NAMESPACES for k in EXPERIMENT_WORKERS]
    exp_cfg.append(paths.cfg_dir("selftest", 1))
    for k in range(1, workers + 1):
        for d, others in ((paths.worker_dir(NS, k), exp_workers), (paths.cfg_dir(NS, k), exp_cfg)):
            for o in others:
                if _overlap(d, o):
                    errs.append(f"try worker folder {d} overlaps the experiment's {o}")
    return errs


def _in_try(p: Path) -> Path:
    """Every file this module writes goes through here: refuse anything outside results/try."""
    if not Path(p).resolve().is_relative_to(paths.ns_dir(NS).resolve()):
        raise Refused(f"refusing to write {p}: outside {paths.ns_dir(NS)}")
    return Path(p)


# ---------------------------------------------------------------- inputs -----------------------------------------

def load_context(path: str) -> tuple[str, dict]:
    p = Path(path)
    if not p.is_file():
        raise Refused(f"--context {path}: no such file")
    raw = p.read_bytes()
    if len(raw) > MAX_CONTEXT_BYTES:
        raise Refused(f"--context {path}: {len(raw):,} bytes; the limit is {MAX_CONTEXT_BYTES:,} (one rules file, "
                      "not a whole folder)")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise Refused(f"--context {path}: not UTF-8 text") from None
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        raise Refused(f"--context {path}: the file is empty")
    if not text.endswith("\n"):
        text += "\n"
    data = text.encode("utf-8")
    return text, {"name": p.name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def load_units(units_file: str | None) -> dict:
    from harness import unitsio
    units = unitsio.load_units()
    if not units_file:
        return units
    try:
        extra = json.loads(Path(units_file).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise Refused(f"--units-file {units_file}: {e}") from None
    if not isinstance(extra, dict):
        raise Refused(f"--units-file {units_file}: expected a JSON object {{name: unit}}")
    for name, u in extra.items():
        if name.startswith("_"):          # "_comment" keys
            continue
        if name in units:
            raise Refused(f"--units-file: unit {name!r} already exists (harness/units*.json are frozen); use a new name")
        if not isinstance(u, dict) or not u.get("adapter"):
            raise Refused(f"--units-file: unit {name!r} needs an \"adapter\" (a module in harness/adapters/)")
        units[name] = u
    return units


def context_file_name(unit: dict) -> str:
    name = unit.get("context_file") or scenario_io.CONTEXT_NAMES.get(unit["adapter"])
    if not name:
        raise Refused(f"adapter {unit['adapter']!r} has no known context file name: add \"context_file\": "
                      "\"AGENTS.md\" (or the file your agent reads) to the unit")
    return name


def parse_tickets(text: str) -> list[str]:
    tickets = list(dict.fromkeys(t.strip() for t in text.split(",") if t.strip()))
    bad = [t for t in tickets if t not in scenario_io.TICKETS]
    if bad or not tickets:
        raise Refused(f"--tickets: unknown {', '.join(bad) or '(none)'}; choose from {', '.join(scenario_io.TICKETS)}")
    return tickets


# ---------------------------------------------------------------- verdict ----------------------------------------

def _failed_checks(verdict: dict | None) -> list[str]:
    return [c["id"] for c in (verdict or {}).get("checks", []) if c.get("status") != "pass"]


def _broken_teams(oracle: dict | None) -> list[str]:
    return sorted(k for k, v in ((oracle or {}).get("consumers") or {}).items() if not v.get("ok"))


def ticket_verdict(recs: list[dict]) -> dict:
    """Counts for one ticket. 'First try' = the agent's first attempt, before any CI feedback."""
    done = [r for r in recs if r.get("outcome") != "infra_failure"]
    first_ci = {r["run_id"]: (r["ci"][0]["verdict"] if r.get("ci") else None) for r in done}
    broke = [r for r in done if r["metrics"].get("staging_break")]
    caught = [r for r in broke if first_ci[r["run_id"]] and not first_ci[r["run_id"]]["ok"]]
    missed = [r for r in broke if first_ci[r["run_id"]] and first_ci[r["run_id"]]["ok"]]
    false_alarm = [r for r in done if not r["metrics"].get("staging_break")
                   and first_ci[r["run_id"]] and not first_ci[r["run_id"]]["ok"]]
    return {
        "runs": len(recs), "finished": len(done), "infra": len(recs) - len(done),
        "broke_first": len(broke),
        "teams_first": dict(Counter(t for r in broke for t in _broken_teams(r["oracle"]["gen"]))),
        "ci_caught": len(caught),
        "ci_caught_checks": dict(Counter(c for r in caught for c in _failed_checks(first_ci[r["run_id"]]))),
        "ci_missed": len(missed),
        "ci_failed_no_break": len(false_alarm),
        "ci_failed_no_break_checks": dict(Counter(c for r in false_alarm for c in _failed_checks(first_ci[r["run_id"]]))),
        "broke_final": sum(1 for r in done if r["metrics"].get("staging_break_final")),
        "teams_final": dict(Counter(t for r in done for t in _broken_teams(r["oracle"]["final"]))),
        "ci_green_final": sum(1 for r in done if r.get("ci") and r["ci"][-1]["verdict"]["ok"]),
        "ticket": dict(Counter(r.get("ticket_done") or "unknown" for r in done)),
        "gate_touched": sum(1 for r in done if r["metrics"].get("gate_flagged")),
        "outcomes": dict(Counter(r["outcome"] for r in done)),
        "run_ids": [r["run_id"] for r in recs],
    }


def _counts(c: dict) -> str:
    return ", ".join(f"{k} {v}" for k, v in sorted(c.items(), key=lambda kv: (-kv[1], kv[0])))


def format_verdict(v: dict) -> str:
    m = v["meta"]
    lines = [f"Try {m['try_id']}: your rules = {m['context']['name']} (sha256 {m['context']['sha256'][:12]}), "
             f"unit {m['unit']}, {m['visibility']}, {m['n']} run(s) per ticket."]
    if m.get("mock_as"):
        lines += [f"Note: the mock agent is scripted. It does not read your file. Here it plays the experiment's "
                  f"{m['mock_as']} script.",
                  "      To test your rules, use a real agent (--live) or your own adapter (docs/USING.md)."]
    for ticket, t in v["tickets"].items():
        f = t["finished"]
        lines.append("")
        lines.append(f"{ticket}: {t['runs']} run(s)" + (f", {t['infra']} could not finish (infrastructure)"
                                                        if t["infra"] else ""))
        if not f:
            continue
        teams = f" ({_counts(t['teams_first'])})" if t["teams_first"] else ""
        lines.append(f"  Broke another team on the first try: {t['broke_first']} of {f}{teams}.")
        if t["broke_first"]:
            checks = f" ({_counts(t['ci_caught_checks'])})" if t["ci_caught_checks"] else ""
            lines.append(f"  CI caught it: {t['ci_caught']} of those {t['broke_first']}{checks}. "
                         f"CI missed it: {t['ci_missed']}.")
        else:
            lines.append("  CI had nothing to catch.")
        if t["ci_failed_no_break"]:
            lines.append(f"  CI failed although no team broke: {t['ci_failed_no_break']} "
                         f"({_counts(t['ci_failed_no_break_checks'])}).")
        still = f" ({_counts(t['teams_final'])})" if t["teams_final"] else ""
        lines.append(f"  At the end (after up to 3 repairs on CI feedback): {t['broke_final']} of {f} still break "
                     f"another team{still}. CI green: {t['ci_green_final']} of {f}.")
        lines.append("  Ticket: " + ", ".join(f"{TICKET_WORDS.get(k, k)} {n}" for k, n in sorted(t["ticket"].items()))
                     + ".")
        lines.append(f"  Edited a gate (tests, contracts, check config, ignore comments): {t['gate_touched']} of {f}.")
        lines.append(f"  Outcomes: {_counts(t['outcomes'])}.")
    lines += ["", "The other teams' tests decide if a change broke them. Not the agent, and not CI.",
              f"Runs: {paths.runs_dir(NS) / (m['try_id'] + '-*')}  (record.json, diffs/, transcript.jsonl, "
              "events.jsonl per run)",
              f"Verdict: {m['verdict_file']}"]
    return "\n".join(lines)


# ---------------------------------------------------------------- batch ------------------------------------------

class TryBatch:
    def __init__(self, *, entries, units, pipeline, context_text, context_meta, scripts, workers, quiet, state):
        self.queue = list(entries)
        self.units, self.pipeline, self.scripts = units, pipeline, scripts
        self.context_text, self.context_meta = context_text, context_meta
        self.workers, self.quiet, self.state = workers, quiet, state
        self.lock = threading.RLock()
        self.records: dict[str, dict] = {}
        self.stop_reason: str | None = None
        self.exit_code = EXIT_OK

    def say(self, text: str) -> None:
        if not self.quiet:
            print(text, flush=True)

    def save(self) -> None:
        with self.lock:
            self.state["updated_at"] = now()
            jsonio.write_json_atomic(_in_try(paths.state_path(NS)), self.state)

    def set_run(self, rid: str, **kw) -> None:
        with self.lock:
            self.state["runs"].setdefault(rid, {"status": "pending"}).update(kw)
        self.save()

    def stop(self, reason: str, code: int) -> None:
        with self.lock:
            if self.stop_reason is None:
                self.stop_reason, self.exit_code = reason, code

    def next(self) -> dict | None:
        with self.lock:
            if self.stop_reason or not self.queue:
                return None
            return self.queue.pop(0)

    def run_one(self, entry: dict, k: int) -> None:
        from harness import cycle
        from harness import record as record_mod
        from harness.runner import activity_line
        rid = entry["run_id"]

        def on_event(ev):
            line = activity_line(rid, ev)
            if line:
                self.say(line)

        for attempt in range(MAX_INFRA_RETRIES + 1):
            with self.lock:
                attempts = self.state["runs"].get(rid, {}).get("attempts", 0) + 1
            self.set_run(rid, status="running", worker=k, attempts=attempts, started_at=now(), ended_at=None)
            self.say(f"{rid}  started  {entry['ticket']} {entry['visibility']}  worker {k}")
            rec = None
            try:
                rec = cycle.execute_run(entry, ns=NS, worker_ns=NS, worker=k, units=self.units, pipeline=self.pipeline,
                                        on_event=None if self.quiet else on_event,
                                        mock_script=self.scripts.get(rid), seed=0, infra_retries=attempt,
                                        context_text=self.context_text)
                infra = rec.get("infra_failure") if rec["outcome"] == "infra_failure" else None
            except Exception as e:  # harness error: counts as an infrastructure failure of this run
                traceback.print_exc(file=sys.stderr)
                infra = {"kind": "harness_error", "detail": f"{type(e).__name__}: {e}"[:500]}
            if rec is not None:
                rec["try"] = {"try_id": entry["try_id"], "context": self.context_meta,
                              "mock_as": entry.get("mock_as")}
                p = paths.run_dir(NS, rid) / "record.json"
                if p.exists():
                    record_mod.write(_in_try(p), rec)
            if not infra:
                with self.lock:
                    self.records[rid] = rec
                self.set_run(rid, status="done", ended_at=now(), last_error=None)
                self.say(f"{rid}  finished: {rec['outcome']}  ({rec['totals']['turns']} turns, "
                         f"{rec['duration_ms'] / 1000:.0f}s)")
                return
            kind = infra.get("kind", "unknown")
            detail = f"{kind}: {infra.get('detail', '')}"[:300]
            if kind == "rate_limited":
                self.set_run(rid, status="pending", ended_at=now(), last_error=detail)
                self.stop(f"rate limited until {infra.get('reset_at') or 'unknown'}; run the same command again later",
                          EXIT_RATE)
                return
            if kind == "isolation_breach":
                self.set_run(rid, status="pending", ended_at=now(), last_error=detail)
                self.stop(f"isolation breach in {rid}: {infra.get('detail', '')}", EXIT_BREACH)
                return
            final = attempt == MAX_INFRA_RETRIES
            self.set_run(rid, status="infra_failure_final" if final else "infra_failure", ended_at=now(),
                         last_error=detail, infra_failures=attempt + 1)
            self.say(f"{rid}  infrastructure failure ({kind})" + ("" if final else "; retrying"))
            if final:
                if rec is not None:
                    with self.lock:
                        self.records[rid] = rec
                return

    def worker(self, k: int) -> None:
        while True:
            entry = self.next()
            if entry is None:
                return
            self.run_one(entry, k)

    def run(self) -> int:
        if self.workers == 1:
            self.worker(1)
        else:
            threads = [threading.Thread(target=self.worker, args=(k,), daemon=True)
                       for k in range(1, self.workers + 1)]
            for t in threads:
                t.start()
            while any(t.is_alive() for t in threads):
                for t in threads:
                    t.join(0.5)
        if self.stop_reason:
            self.say(f"stopped: {self.stop_reason}")
        return self.exit_code


# ---------------------------------------------------------------- CLI --------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m harness.try_rules",
                                 description="Run the experiment's tickets with YOUR rules file as the agent's context "
                                             "and let the other teams' tests judge the result (results/try/).")
    ap.add_argument("--context", required=True, help="your rules file (constitution, steering, CLAUDE.md, AGENTS.md…)")
    ap.add_argument("--unit", required=True, help="a unit of harness/units*.json (e.g. mock, cc-sonnet, codex) or of "
                                                  "--units-file")
    ap.add_argument("--tickets", default=",".join(DEFAULT_TICKETS),
                    help=f"comma-separated (default {','.join(DEFAULT_TICKETS)})")
    ap.add_argument("--n", type=int, default=3, help=f"runs per ticket (1..{MAX_N}; default 3)")
    ap.add_argument("--visibility", choices=("V0", "V1", "V2"), default="V0")
    ap.add_argument("--workers", type=int, default=1, help=f"parallel runs (1..{MAX_WORKERS})")
    ap.add_argument("--live", action="store_true", help="allow a real agent (real sessions, real quota)")
    ap.add_argument("--mock-as", choices=("S0", "S1", "S2"), default="S0",
                    help="mock unit only: which experiment script the scripted agent plays (default S0, no rules)")
    ap.add_argument("--units-file", help="extra units (JSON {name: unit}), e.g. for your own adapter")
    ap.add_argument("--quiet", action="store_true", help="print only the verdict")
    return ap


def main(argv=None, *, pipeline=None, mock_scripts: dict | None = None) -> int:
    """pipeline / mock_scripts: test seams (a fake CI + other teams' tests; scripts keyed "<ticket>|<V>|<S>")."""
    a = build_parser().parse_args(argv)
    try:
        return _main(a, pipeline=pipeline, mock_scripts=mock_scripts)
    except Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return EXIT_GUARD


def _main(a, *, pipeline, mock_scripts) -> int:
    from harness import cycle
    from harness.adapters.base import load_adapter
    if not 1 <= a.n <= MAX_N:
        raise Refused(f"--n must be 1..{MAX_N}")
    if not 1 <= a.workers <= MAX_WORKERS:
        raise Refused(f"--workers must be 1..{MAX_WORKERS}")
    tickets = parse_tickets(a.tickets)
    text, ctx_meta = load_context(a.context)
    units = load_units(a.units_file)
    if a.unit not in units:
        raise Refused(f"unknown unit {a.unit!r}; known: {', '.join(sorted(units))}")
    unit = units[a.unit]
    context_file_name(unit)
    try:
        if not hasattr(load_adapter(unit["adapter"]), "run_session"):
            raise Refused(f"harness/adapters/{unit['adapter']}.py has no run_session()")
    except ImportError as e:
        raise Refused(f"adapter {unit['adapter']!r}: {e}") from None
    is_mock = unit["adapter"] == "mock"
    if not is_mock and not a.live:
        raise Refused(f"unit {a.unit} runs a real agent ({unit['adapter']}): it starts real sessions and spends "
                      "quota. Add --live to go ahead, or try --unit mock first.")
    problems = isolation_problems(a.workers)
    if problems:
        raise Refused("; ".join(problems))
    if not is_mock or pipeline is None:     # a real agent and the real CI both run `npm test` in the worker folder
        from harness import doctor
        missing = [k for k in range(1, a.workers + 1) if not doctor.worker_ready(NS, k)]
        if missing:
            raise Refused(f"worker folder(s) {', '.join(str(paths.worker_dir(NS, k)) for k in missing)} not ready: "
                          f"run `python -m harness.doctor --setup-workers {a.workers} --ns {NS}`")
    if pipeline is None:
        missing = cycle.wp1_missing()
        if missing:
            raise Refused("experiment pieces missing: " + ", ".join(missing))
        if not (paths.NODE_MODULES / "typescript" / "package.json").exists():
            raise Refused(f"{paths.NODE_MODULES} has no typescript: run `npm ci` in {paths.REPO} first (CI and the "
                          "other teams' tests use it)")
    from harness.runner import other_runner
    busy = other_runner(NS)
    if busy:
        raise Refused(f"another try is running (pid {busy}); one at a time")

    try_id = "t" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    while any(paths.runs_dir(NS).glob(f"{try_id}-*")):
        time.sleep(1)
        try_id = "t" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    entries = []
    for k in range(1, a.n + 1):              # interleaved, so a stop leaves every ticket with runs
        for t in tickets:
            entries.append({"run_id": f"{try_id}-{t}-{k:02d}", "stage": STAGE, "unit": a.unit, "ticket": t,
                            "wording": "W1", "paraphrase": None, "visibility": a.visibility, "spec": SPEC,
                            "replicate": k, "cell": f"{t}|{a.visibility}|{SPEC}|W1|{a.unit}", "try_id": try_id,
                            "mock_as": a.mock_as if is_mock else None})
    scripts = {}
    if is_mock:
        from harness.adapters.mock import load_scripts
        table = {**load_scripts(), **(mock_scripts or {})}
        for e in entries:
            scripts[e["run_id"]] = table.get(f"{e['ticket']}|{e['visibility']}|{a.mock_as}") or table["default"]

    ns_dir = paths.ns_dir(NS)
    ctx_copy = _in_try(ns_dir / "contexts" / f"{ctx_meta['sha256'][:16]}-{ctx_meta['name']}")
    ctx_copy.parent.mkdir(parents=True, exist_ok=True)
    ctx_copy.write_text(text, encoding="utf-8", newline="\n")
    verdict_file = _in_try(ns_dir / "verdicts" / f"{try_id}.json")
    meta = {"try_id": try_id, "created_at": now(), "unit": a.unit, "adapter": unit["adapter"],
            "context_file": context_file_name(unit), "context": dict(ctx_meta, copy=ctx_copy.relative_to(ns_dir).as_posix()),
            "visibility": a.visibility, "tickets": tickets, "n": a.n, "mock_as": a.mock_as if is_mock else None,
            "verdict_file": str(verdict_file)}
    manifest = jsonio.read_json(paths.manifest_path(NS)) or {"schema": "try-manifest/1", "namespace": NS,
                                                               "tries": {}, "runs": []}
    manifest["tries"][try_id] = {k: v for k, v in meta.items() if k != "verdict_file"}
    manifest["runs"].extend(entries)
    jsonio.write_json_atomic(_in_try(paths.manifest_path(NS)), manifest)
    state = jsonio.read_json(paths.state_path(NS)) or {"schema": "try-state/1", "namespace": NS, "runs": {}}
    for e in entries:
        state["runs"][e["run_id"]] = {"status": "pending", "try_id": try_id}
    state["runner"] = {"pid": os.getpid(), "status": "running", "try_id": try_id, "started_at": now()}

    lock = _in_try(paths.runner_lock_path(NS))
    lock.write_text(str(os.getpid()), encoding="utf-8")
    batch = TryBatch(entries=entries, units=units, pipeline=pipeline, context_text=text, context_meta=meta["context"],
                     scripts=scripts, workers=a.workers, quiet=a.quiet, state=state)
    batch.save()
    batch.say(f"Try {try_id}: {len(entries)} run(s) = {len(tickets)} ticket(s) x {a.n}, unit {a.unit}, "
              f"{a.visibility}; your file goes in as {meta['context_file']}.")
    code = EXIT_OK
    try:
        code = batch.run()
    except KeyboardInterrupt:
        batch.stop("interrupted", EXIT_GUARD)
        code = EXIT_GUARD
    finally:
        with batch.lock:
            for r in state["runs"].values():
                if r.get("status") == "running":
                    r.update(status="pending", last_error="interrupted")
            state["runner"].update(pid=None, status="stopped", ended_at=now(), message=batch.stop_reason)
        batch.save()
        try:
            if lock.read_text(encoding="utf-8").strip() == str(os.getpid()):
                lock.unlink()
        except OSError:
            pass

    by_ticket = {t: [batch.records[e["run_id"]] for e in entries if e["ticket"] == t and e["run_id"] in batch.records]
                 for t in tickets}
    verdict = {"schema": "try-verdict/1", "meta": meta, "stopped": batch.stop_reason,
               "tickets": {t: ticket_verdict(recs) for t, recs in by_ticket.items()}}
    text_out = format_verdict(verdict)
    verdict["text"] = text_out
    jsonio.write_json_atomic(verdict_file, verdict)
    print(("" if a.quiet else "\n") + text_out, flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
