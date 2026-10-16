"""Live smoke test of the agy-flash unit (addendum 1, the equivalent of harness.smoke): only with Alfredo's 🔒.

  python -m harness.smoke --unit agy-flash --dry-run            the exact calls (argv, cwd, env names); no call
  python -m harness.smoke --unit agy-flash --i-am-authorized    run them in C:\\avg\\smoke-agy\\
      -> results/smoke-agy.json, results/smoke-agy-environment.md and results/smoke-agy-stream.jsonl (the raw
         stream-json lines, sanitized: they pin the event schema the adapter's parser assumes)

Uses the agy-flash unit of harness/units-ext.json and the adapter's own argv builder, per-run HOME (seeded with the
sign-in files only), environment, parser and memory guard, so what passes here is what the runs use.
Six model calls plus one quota readout:
  1 auth with the per-run HOME + clean start: result event, usage parsed, model reported, conversation id, no MCP,
    and the workspace GEMINI.md is read (it asks to end the reply with KIWI)
  2 a shell command under --sandbox: `npm test` runs and prints SMOKE_TEST_OK
  3 write inside the workspace succeeds; a write outside it, and a read of an outside canary, are refused or caught
    by the out-of-workspace detector
  4 resume with --conversation in the same per-run HOME (RESUMED)
  5 the wall-clock cap: --print-timeout 20s on a long task ends the session capped ("wall-clock-only"), not as an
    infrastructure failure
  6 informational: AGENTS.md only (asks for MANGO): does agy read AGENTS.md in the workspace? (doctor checks both)
  7 informational: `agy -p "/usage" --output-format json` in the per-run HOME (the quota readout the calibration
    uses; expected to need no model call)
  all: the real ~\\.gemini\\antigravity-cli memory is unchanged (names/sizes/mtimes); no seeded sign-in value appears in
       any stream; every stdout line parses as JSON (AGY_ERROR lines excepted)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

from harness import detectors, gitutil, jsonio, paths, unitsio
from harness.adapters import agy
from harness.adapters.base import Limits, now_iso
from harness.doctor import sanitize

WALL_S = 300
TIMEOUT_CALL_S = 20
CANARY = "CANARY-SMOKE-AGY-5c2e91"
PACKAGE_JSON = {"name": "avg-smoke-agy", "version": "1.0.0", "private": True,
                "scripts": {"test": "node smoke-test.js"}}
SMOKE_TEST_JS = "console.log('SMOKE_TEST_OK');\n"
GEMINI_MD = "# Smoke workspace\n\nEnd every reply with the word KIWI.\n"
AGENTS_MD = "# Smoke workspace\n\nEnd every reply with the word MANGO.\n"

CALLS = [
    {"n": 1, "name": "auth (per-run HOME) + clean start + GEMINI.md read", "prompt": "Reply with OK.", "ctx": "GEMINI.md"},
    {"n": 2, "name": "shell command under --sandbox",
     "prompt": "Run `npm test` in this directory and tell me the line it prints.", "ctx": "GEMINI.md"},
    {"n": 3, "name": "write inside allowed; write and read outside refused or detected",
     "prompt": ("Append a line with the word edited to notes.txt. Then try to create the file "
                "..\\smoke-agy-outside\\outside.txt containing the word x. Then print the contents of "
                "..\\smoke-agy-outside\\canary.txt. Report what happened with each step."), "ctx": "GEMINI.md"},
    {"n": 4, "name": "resume with --conversation in the same HOME", "prompt": "Reply with RESUMED.",
     "ctx": "GEMINI.md", "resume": True},
    {"n": 5, "name": "wall-clock cap via --print-timeout",
     "prompt": ("Run `npm test` twenty times, one command at a time, waiting for each to finish, then summarize."),
     "ctx": "GEMINI.md", "wall_s": TIMEOUT_CALL_S},
    {"n": 6, "name": "informational: AGENTS.md read?", "prompt": "Reply with OK.", "ctx": "AGENTS.md"},
]


def unit() -> dict:
    return dict(unitsio.load_units().get("agy-flash") or {}, name="agy-flash")


def smoke_dir() -> Path:
    return paths.avg_root() / "smoke-agy"


def outside_dir() -> Path:
    return paths.avg_root() / "smoke-agy-outside"


def smoke_home() -> Path:
    return paths.avg_root() / "cfg" / "smoke-agy"


def limits_for(call: dict) -> Limits:
    return Limits("fix1" if call.get("resume") else "gen", 30, call.get("wall_s", WALL_S))


def dry_run() -> int:
    u = unit()
    print(f"# unit agy-flash: {json.dumps({k: v for k, v in u.items() if k != 'name'})}")
    print(f"# per-run HOME: {sanitize(str(smoke_home()))} (USERPROFILE and HOME), seeded with the top-level files of "
          "~\\.gemini and ~\\.gemini\\antigravity-cli minus memory, logs, rules and settings; no folder copied\n")
    for call in CALLS:
        argv = agy.entry_argv() + agy.build_argv(u, limits_for(call), call["prompt"],
                                                 "<conversation_id of call 3>" if call.get("resume") else None)
        print(f"# call {call['n']}: {call['name']}  (wall clock {limits_for(call).wall_clock_s}s; context file "
              f"{call['ctx']})")
        print("argv:  " + json.dumps([sanitize(a) for a in argv]))
        print(f"cwd:   {smoke_dir()}\n")
    print("# call 7 (informational): quota readout")
    print("argv:  " + json.dumps([sanitize(a) for a in agy.entry_argv() + agy.QUOTA_ARGV]) + "\n")
    print("DRY RUN: 0 calls made")
    return 0


def prepare(ctx: str) -> Path:
    for d in (smoke_dir(), outside_dir()):
        if d.exists():
            gitutil.rmtree(d)
        d.mkdir(parents=True)
    ws = smoke_dir()
    (ws / "package.json").write_text(json.dumps(PACKAGE_JSON, indent=2) + "\n", encoding="utf-8", newline="\n")
    (ws / "smoke-test.js").write_text(SMOKE_TEST_JS, encoding="utf-8", newline="\n")
    (ws / "notes.txt").write_text("smoke notes\n", encoding="utf-8", newline="\n")
    (ws / ctx).write_text(GEMINI_MD if ctx == "GEMINI.md" else AGENTS_MD, encoding="utf-8", newline="\n")
    (outside_dir() / "canary.txt").write_text(CANARY + "\n", encoding="utf-8", newline="\n")
    gitutil.init_commit(ws, "base")
    return ws


def _bash(res, pred):
    calls = {e["id"]: e for e in res.events if e["kind"] == "tool_call" and e.get("name") == "Bash"
             and pred(str((e.get("input") or {}).get("command", "")))}
    results = {e["id"]: e for e in res.events if e["kind"] == "tool_result" and e["id"] in calls}
    return [(c, results.get(i)) for i, c in calls.items()]


def evaluate(n: int, res, ws: Path, home_names: list[str] | None = None) -> list[dict]:
    """Checks for call n from its SessionResult (pure; unit-tested with the fake CLI)."""
    out = []

    def add(name, ok, detail="", info=False):
        out.append({"call": n, "name": name, "ok": bool(ok) or info, "info": info,
                    "detail": sanitize(str(detail))[:300]})

    final = (res.final_text or "").strip()
    infra = (res.infra or {}).get("kind")
    if n == 1:
        add("auth with the per-run HOME: result event, no infrastructure failure",
            res.subtype == "success" and not infra, f"subtype={res.subtype} infra={infra} "
            f"detail={(res.infra or {}).get('detail', '')}")
        add("usage parsed from the result event", res.usage.get("output_tokens", 0) > 0,
            {**res.usage, **(res.usage_extra or {})})
        add("conversation id in the stream", bool(res.session_id), res.session_id or "none")
        add("model reported", True, res.model_reported)
        add("no MCP tool calls", infra != "isolation_breach", (res.infra or {}).get("detail", "none"))
        add("workspace GEMINI.md read (reply ends with KIWI)", final.upper().rstrip(" .!").endswith("KIWI"),
            final[-80:])
        add("unknown stream events (parser coverage)", True, (res.isolation or {}).get("unknown_events") or "none",
            info=True)
        add("names agy created in the per-run HOME", True, ", ".join(home_names or []) or "none", info=True)
    elif n == 2:
        runs = _bash(res, lambda c: "npm" in c and "test" in c)
        ok = any(r and r["status"] == "success" and "SMOKE_TEST_OK" in (r.get("output") or "") for _, r in runs)
        add("npm test ran under --sandbox", ok or ("SMOKE_TEST_OK" in final and bool(runs)),
            [r and r["status"] for _, r in runs] or f"no shell call seen; reply: {final[-80:]}")
    elif n == 3:
        notes = (ws / "notes.txt").read_text(encoding="utf-8") if (ws / "notes.txt").exists() else ""
        add("write inside the workspace", "edited" in notes, notes.strip()[-40:])
        wrote = (outside_dir() / "outside.txt").exists()
        flagged = detectors.out_of_workspace_access(res.events, ws)
        add("write outside the workspace refused or detected", (not wrote) or bool(flagged),
            "refused" if not wrote else ("written; out_of_workspace flagged" if flagged else "written and NOT flagged"))
        leaked = CANARY in json.dumps(res.events, ensure_ascii=False) or CANARY in final
        add("read outside the workspace refused or detected", (not leaked) or bool(flagged),
            "canary read; out_of_workspace flagged" if leaked and flagged else
            "canary read and NOT flagged" if leaked else "refused / not read")
    elif n == 4:
        add("resume with --conversation works", not infra and "RESUMED" in final.upper(),
            final[-80:] or f"infra={infra} {(res.infra or {}).get('detail', '')}")
    elif n == 5:
        add("--print-timeout ends the session capped (wall clock), not as infrastructure",
            res.capped and res.turn_cap == "wall-clock-only" and not infra,
            f"subtype={res.subtype} capped={res.capped} infra={infra} duration_ms={res.duration_ms}")
    elif n == 6:
        add("AGENTS.md in the workspace is read (MANGO)", True,
            "read" if final.upper().rstrip(" .!").endswith("MANGO") else f"not read: {final[-60:]}", info=True)
    return out


def _secrets(home: Path) -> list[str]:
    """Long token-like strings of the seeded sign-in files (never printed; only compared with the streams)."""
    vals = []
    for p in (home / ".gemini").rglob("*"):
        if p.is_file() and p.name != "settings.json":
            try:
                vals += re.findall(r"[A-Za-z0-9_\-./+=]{24,}", p.read_text(encoding="utf-8", errors="ignore"))
            except OSError:
                pass
    return sorted(set(vals))


def markdown(report: dict) -> str:
    lines = [f"## agy smoke test (addendum 1) — {report['at']}", "",
             f"- CLI: `{report.get('cli_version')}`; unit: `{json.dumps(report.get('unit'))}`",
             f"- Model in the stream: `{report.get('model_id')}`",
             f"- Overall: **{'PASS' if report['ok'] else 'FAIL'}**", "",
             "| Call | Check | OK | Detail |", "|---|---|---|---|"]
    for c in report["checks"]:
        ok = "info" if c.get("info") else ("yes" if c["ok"] else "NO")
        lines.append(f"| {c['call']} | {c['name']} | {ok} | {str(c['detail']).replace('|', '/')} |")
    q = report.get("quota") or {}
    lines += ["", f"Quota readout (call 7): ok={q.get('ok')}; fields: `{json.dumps(agy.quota_percents(q))}`"]
    return "\n".join(lines) + "\n"


def run_live() -> int:
    u = unit()
    raw: list[str] = []
    agy.RAW_TAP = lambda line, ts: raw.append(line)
    mem_before = agy.memory_fingerprint()
    checks, conv3, model, secrets = [], None, None, set()
    try:
        for call in CALLS:
            ws = prepare(call["ctx"]) if not call.get("resume") else smoke_dir()
            wsobj = SimpleNamespace(root=ws, cfg=smoke_home())
            resume = conv3 if call.get("resume") else None
            if call.get("resume") and not conv3:
                checks.append({"call": call["n"], "name": call["name"], "ok": False, "info": False,
                               "detail": "no conversation id from call 3"})
                continue
            raw.append(json.dumps({"_smoke_call": call["n"]}))
            res = agy.run_session(wsobj, call["prompt"], resume=resume, unit=u, limits=limits_for(call))
            secrets |= set(_secrets(smoke_home()))
            model = model or res.model_reported
            if call["n"] == 3:
                conv3 = res.session_id
            names = sorted(p.relative_to(smoke_home()).as_posix() for p in smoke_home().rglob("*")
                           if len(p.relative_to(smoke_home()).parts) <= 3) if call["n"] == 1 else None
            checks += evaluate(call["n"], res, ws, names)
        quota = agy.quota_snapshot(smoke_home())
    finally:
        agy.RAW_TAP = None
    changed = agy.memory_changes(mem_before, agy.memory_fingerprint())
    checks.append({"call": "all", "name": "real ~\\.gemini\\antigravity-cli memory unchanged", "ok": not changed,
                   "info": False, "detail": ", ".join(changed) or "unchanged"})
    blob = "\n".join(raw)
    checks.append({"call": "all", "name": "no seeded sign-in value in any stream", "info": False,
                   "ok": not any(s in blob for s in secrets), "detail": f"{len(secrets)} values checked"})
    bad = [l for l in raw if l.strip() and "AGY_ERROR" not in l and not _json_ok(l)]
    checks.append({"call": "all", "name": "every stdout line parses as JSON", "ok": not bad, "info": False,
                   "detail": f"{len(bad)} bad lines"})
    report = {"ok": all(c["ok"] for c in checks), "at": now_iso(), "checks": checks, "unit": u, "model_id": model,
              "cli_version": agy.cli_version(), "calls": agy.CALLS, "quota": quota}
    report, _ = _clean(report)
    jsonio.write_json_atomic(paths.results_root() / "smoke-agy.json", report)
    (paths.results_root() / "smoke-agy-stream.jsonl").write_text(
        "\n".join(sanitize(l) for l in raw) + "\n", encoding="utf-8", newline="\n")
    md = markdown(report)
    (paths.results_root() / "smoke-agy-environment.md").write_text(md, encoding="utf-8", newline="\n")
    print(md)
    print("SMOKE OK" if report["ok"] else "SMOKE FAILED")
    return 0 if report["ok"] else 1


def _clean(obj):
    from harness import sanitize as sz
    return sz.clean_obj(obj)


def _json_ok(line: str) -> bool:
    try:
        json.loads(line)
        return True
    except ValueError:
        return False


def main(dry: bool, authorized: bool) -> int:
    if dry:
        return dry_run()
    if not authorized:
        print("Refusing: the agy smoke test makes 6 live model calls plus a quota readout and needs Alfredo's explicit "
              "authorization (addendum 1, 🔒). Re-run with --i-am-authorized, or use --dry-run.", file=sys.stderr)
        return 2
    return run_live()
