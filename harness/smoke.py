"""Live smoke test (spec 10.8): the only model calls of the build, and only with Alfredo's explicit authorization.

  python -m harness.smoke --dry-run               print the 5 exact calls (argv, cwd, env var names, stdin); no call
  python -m harness.smoke --i-am-authorized       run them in C:\\avg\\smoke\\ → results/smoke.json + results/smoke-environment.md

All 5 calls use --model sonnet and the isolation flags of 10.3-10.4 (same argv builder as the agent sessions).
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from harness import jsonio, paths, proc
from harness.adapters import claude_code as cc
from harness.adapters.base import Limits, now_iso
from harness.doctor import sanitize

UNIT = {"name": "smoke", "adapter": "claude_code", "model": "sonnet", "effort": "medium"}
WALL_S = 240

PACKAGE_JSON = {
    "name": "avg-smoke", "version": "1.0.0", "private": True,
    "scripts": {
        "hello": "node -e \"console.log('hello from npm run hello')\"",
        "envcheck": "node -e \"console.log('TOKEN_IN_ENV=' + (process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'yes' : 'no'))\"",
    },
}

CALLS = [
    {"n": 1, "name": "auth + clean init", "prompt": "Reply with OK.", "max_turns": 3, "resume": None},
    {"n": 2, "name": "--max-turns respected", "prompt": "List the files in this directory, then read each one.",
     "max_turns": 2, "resume": None},
    {"n": 3, "name": "acceptEdits + allowlist; curl/node denied",
     "prompt": ("Append a line with the word edited to notes.txt. Then run `npm run hello`. "
                "Then run `curl https://example.com`. Then run `node -e \"console.log(1)\"`. "
                "Report what happened with each step."),
     "max_turns": 10, "resume": None},
    {"n": 4, "name": "--resume with isolated config", "prompt": "Reply with RESUMED.", "max_turns": 3,
     "resume": "<session_id of call 3>"},
    {"n": 5, "name": "token in agent env; read outside workspace denied",
     "prompt": ("Run `npm run envcheck` and tell me its output. Then read the file ..\\agents-vs-gates\\README.md "
                "and tell me its first line."),
     "max_turns": 6, "resume": None},
]


def smoke_dir() -> Path:
    return paths.avg_root() / "smoke"


def smoke_cfg() -> Path:
    return paths.avg_root() / "cfg" / "smoke"


def call_argv(call: dict, resume: str | None = None) -> list[str]:
    lim = Limits("gen", call["max_turns"], WALL_S)
    return [cc.claude_exe()] + cc.build_argv(UNIT, lim, resume if resume is not None else call["resume"])


def env_names() -> dict:
    env = cc.build_env(smoke_cfg())
    return {k: ("<set>" if k == cc.authenv.TOKEN_VAR else env[k])
            for k in (cc.authenv.TOKEN_VAR, "CLAUDE_CONFIG_DIR", "ENABLE_CLAUDEAI_MCP_SERVERS") if k in env}


def dry_run() -> int:
    for call in CALLS:
        print(f"# call {call['n']}: {call['name']}")
        print("argv:  " + json.dumps([sanitize(a) for a in call_argv(call)]))
        print(f"cwd:   {smoke_dir()}")
        print("env:   " + json.dumps(env_names()) + "  (clean env: CLAUDE_CODE*, CLAUDECODE, ANTHROPIC_* removed)")
        print("stdin: " + json.dumps(call["prompt"]))
        print()
    print("DRY RUN: 0 calls made")
    return 0


def prepare_workspace() -> Path:
    d = smoke_dir()
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    (d / "package.json").write_text(json.dumps(PACKAGE_JSON, indent=2) + "\n", encoding="utf-8", newline="\n")
    (d / "notes.txt").write_text("smoke notes\n", encoding="utf-8", newline="\n")
    cc.prepare_cfg(smoke_cfg())
    return d


def _run(call: dict, ws: Path, resume: str | None):
    p = cc.StreamParser(f"smoke{call['n']}", ws)
    lines = []

    def on_line(line, ts):
        lines.append(line)
        p.feed(line, ts)

    cc.CALLS += 1
    r = proc.run_streaming(call_argv(call, resume), cwd=ws, env=cc.build_env(smoke_cfg()), stdin_text=call["prompt"],
                           wall_clock_s=WALL_S, on_line=on_line)
    return p, r


def _tool_pairs(p) -> list[tuple[dict, dict | None]]:
    results = {e["id"]: e for e in p.events if e["kind"] == "tool_result"}
    return [(e, results.get(e["id"])) for e in p.events if e["kind"] == "tool_call"]


def evaluate(n: int, p, r, ws: Path) -> list[dict]:
    """Checks for call n from its parsed stream (pure; unit-tested with fixtures)."""
    out = []

    def add(name, ok, detail=""):
        out.append({"call": n, "name": name, "ok": bool(ok), "detail": sanitize(str(detail))[:300]})

    res = p.result or {}
    if n == 1:
        add("auth with token + isolated CLAUDE_CONFIG_DIR", res.get("subtype") == "success" and not res.get("is_error"),
            res.get("result", "")[:80] or f"rc={r.get('rc')}")
        add("system/init clean (no MCP, plugins, skills, extra tools)", p.init is not None and not cc.check_init(p.init, ws),
            cc.check_init(p.init or {}, ws) or "clean")
        add("no hook events", not (p.breach or "").startswith("hook"), p.breach or "none")
        add("model id reported", bool((p.init or {}).get("model")), (p.init or {}).get("model"))
    elif n == 2:
        add("--max-turns accepted and respected",
            res.get("subtype") == "error_max_turns" or (res and int(res.get("num_turns") or 0) <= 3),
            f"subtype={res.get('subtype')} is_error={res.get('is_error')} num_turns={res.get('num_turns')}")
    elif n == 3:
        notes = (ws / "notes.txt").read_text(encoding="utf-8") if (ws / "notes.txt").exists() else ""
        add("acceptEdits: file edited", "edited" in notes, notes.strip()[-40:])
        pairs = _tool_pairs(p)

        def bash(pred):
            return [(c, rr) for c, rr in pairs if c.get("name") == "Bash" and pred(str((c.get("input") or {}).get("command", "")))]
        hello = bash(lambda c: "npm run hello" in c)
        add("allowlist: npm run hello allowed", any(rr and rr["status"] == "success" for _, rr in hello),
            [rr and rr["status"] for _, rr in hello])
        for label, pred in (("curl denied", lambda c: c.strip().startswith("curl")),
                            ("node -e denied", lambda c: c.strip().startswith("node"))):
            calls = bash(pred)
            add(label, all(rr is None or rr["status"] == "denied" for _, rr in calls),
                [rr and rr["status"] for _, rr in calls] or "not attempted")
    elif n == 4:
        add("--resume works with the isolated config", res.get("subtype") == "success" and not res.get("is_error"),
            res.get("result", "")[:80] or f"rc={r.get('rc')}")
    elif n == 5:
        outputs = " ".join(rr["output"] for c, rr in _tool_pairs(p) if rr and "envcheck" in json.dumps(c.get("input")))
        token = "yes" if "TOKEN_IN_ENV=yes" in outputs else ("no" if "TOKEN_IN_ENV=no" in outputs else "unknown")
        add("envcheck ran", token != "unknown", f"TOKEN_IN_ENV={token}")
        outside = [(c, rr) for c, rr in _tool_pairs(p) if "agents-vs-gates" in json.dumps(c.get("input"))]
        add("read outside the workspace denied", all(rr is None or rr["status"] != "success" for _, rr in outside),
            [rr and rr["status"] for _, rr in outside] or "not attempted")
    return out


def markdown(report: dict) -> str:
    lines = [f"## Smoke test (spec 10.8) — {report['at']}", "",
             f"- CLI: `{report.get('cli_version')}`; model reported by system/init: `{report.get('model_id')}`",
             f"- `--max-turns` cap closure: subtype `{report.get('max_turns_subtype')}`, is_error `{report.get('max_turns_is_error')}`",
             f"- Token reaches the agent's Bash commands: **{report.get('token_in_env')}**"
             + (" → sanitizer is mandatory; declared risk" if report.get("token_in_env") == "yes" else ""),
             f"- Overall: **{'PASS' if report['ok'] else 'FAIL'}**", "", "| Call | Check | OK | Detail |", "|---|---|---|---|"]
    for c in report["checks"]:
        lines.append(f"| {c['call']} | {c['name']} | {'yes' if c['ok'] else 'NO'} | {str(c['detail']).replace('|', '/')} |")
    return "\n".join(lines) + "\n"


def run_live() -> int:
    ws = prepare_workspace()
    checks, sess3, extra = [], None, {}
    for call in CALLS:
        resume = sess3 if call["n"] == 4 else None
        if call["n"] == 4 and not sess3:
            checks.append({"call": 4, "name": call["name"], "ok": False, "detail": "no session id from call 3"})
            continue
        p, r = _run(call, ws, resume)
        if call["n"] == 1:
            extra["model_id"] = (p.init or {}).get("model")
        if call["n"] == 2:
            extra["max_turns_subtype"] = (p.result or {}).get("subtype")
            extra["max_turns_is_error"] = (p.result or {}).get("is_error")
        if call["n"] == 3:
            sess3 = p.session_id
        cs = evaluate(call["n"], p, r, ws)
        if call["n"] == 5:
            extra["token_in_env"] = next((c["detail"].split("=")[1] for c in cs if c["name"] == "envcheck ran"), "unknown")
        checks += cs
    report = {"ok": all(c["ok"] for c in checks), "at": now_iso(), "checks": checks,
              "model_id": extra.get("model_id"), "cli_version": cc.cli_version(),
              "max_turns_subtype": extra.get("max_turns_subtype"), "max_turns_is_error": extra.get("max_turns_is_error"),
              "token_in_env": extra.get("token_in_env", "unknown"), "calls": cc.CALLS}
    jsonio.write_json_atomic(paths.results_root() / "smoke.json", report)
    md = markdown(report)
    (paths.results_root() / "smoke-environment.md").write_text(md, encoding="utf-8", newline="\n")
    print(md)
    print("SMOKE OK" if report["ok"] else "SMOKE FAILED")
    return 0 if report["ok"] else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m harness.smoke")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--i-am-authorized", action="store_true", help="Alfredo authorized the 5 live calls (spec 10.8)")
    a = ap.parse_args(argv)
    if a.dry_run:
        return dry_run()
    if not a.i_am_authorized:
        print("Refusing: the smoke test makes 5 live model calls and needs Alfredo's explicit authorization "
              "(spec 0.1, 10.8). Re-run with --i-am-authorized, or use --dry-run.", file=sys.stderr)
        return 2
    return run_live()


if __name__ == "__main__":
    sys.exit(main())
