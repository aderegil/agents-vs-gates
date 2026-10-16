"""A fake `agy` for the adapter tests: prints a stream-json session and edits the workspace like the real CLI would.
Never calls a model. Behaviour from env FAKE_AGY_MODE (env vars named AGY_* are dropped by the adapter, so the fake's
own settings use the FAKE_AGY_ prefix):
  rename_fix  gen renames OrderPlaced.totalCents -> amountCents (breaks billing); the resume adds the old fields back
  ok          answers without editing
  rate        AGY_ERROR quota line, exit 3
  auth        AGY_ERROR not signed in, exit 3
  timeout     result with status "timeout"
  mcp         one MCP tool call
  leak        writes into FAKE_AGY_REAL_HOME\\.gemini\\antigravity-cli\\brain (agy ignoring the HOME override)
  noresult    exits 0 without a result event
  deltas      the answer arrives as several text deltas and a thought
FAKE_AGY_LOG: append {"argv", "cwd", "userprofile", "home", "env_keys"} per call.
The conversation is stored in <USERPROFILE>\\.gemini\\antigravity-cli\\conversations\\<id>.pb; `--conversation <id>`
fails (exit 1) when it is not there, like a resume in the wrong HOME would.
"""
import json
import os
import sys
import uuid
from pathlib import Path


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def arg(name):
    a = sys.argv[1:]
    return a[a.index(name) + 1] if name in a else None


def main():
    mode = os.environ.get("FAKE_AGY_MODE", "ok")
    home = Path(os.environ.get("USERPROFILE", "."))
    cli = home / ".gemini" / "antigravity-cli"
    log = os.environ.get("FAKE_AGY_LOG")
    if log:
        with open(log, "a", encoding="utf-8") as f:
            f.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "userprofile": os.environ.get("USERPROFILE"),
                                "home": os.environ.get("HOME"), "env_keys": sorted(os.environ)}) + "\n")
    resume = arg("--conversation")
    if resume and not (cli / "conversations" / f"{resume}.pb").exists():
        sys.stdout.write(f"AGY_ERROR conversation {resume} not found\n")
        return 1
    cid = resume or str(uuid.uuid4())
    (cli / "conversations").mkdir(parents=True, exist_ok=True)
    (cli / "conversations" / f"{cid}.pb").write_text("x", encoding="utf-8")
    (cli / "brain" / cid).mkdir(parents=True, exist_ok=True)
    (cli / "brain" / cid / "task.md").write_text("- [ ] ticket", encoding="utf-8")
    out({"event": "init", "conversation_id": cid, "model": arg("--model"), "cli_version": "1.3.6-fake"})
    if mode == "rate":
        sys.stdout.write("AGY_ERROR You have reached your individual quota. Try again in 2 hours 10 minutes.\n")
        return 3
    if mode == "auth":
        sys.stdout.write("AGY_ERROR Not signed in. Please sign in with `agy` first.\n")
        return 3
    if mode == "noresult":
        return 0
    if mode == "leak":
        real = Path(os.environ["FAKE_AGY_REAL_HOME"]) / ".gemini" / "antigravity-cli" / "brain"
        real.mkdir(parents=True, exist_ok=True)
        (real / "leak.md").write_text("memory", encoding="utf-8")
    if mode == "mcp":
        out({"event": "tool_call", "conversation_id": cid, "id": "t1", "tool": "mcp_github_search_code",
             "args": {"q": "x"}})
    ws = Path(os.getcwd())
    events = ws / "src" / "core" / "events.ts"
    usage = {"input_tokens": 1200, "output_tokens": 300, "thinking_tokens": 200, "cache_read_tokens": 800,
             "total_tokens": 1700}
    if mode == "rename_fix" and events.exists():
        out({"event": "tool_call", "conversation_id": cid, "id": "t1", "tool": "view_file",
             "args": {"AbsolutePath": str(events)}})
        out({"event": "tool_result", "conversation_id": cid, "id": "t1", "status": "success",
             "output": events.read_text(encoding="utf-8")})
        text = events.read_text(encoding="utf-8")
        if resume:
            text = text.replace("  channel", "  totalCents: number;\n  placedAt: string;\n  channel")
            msg = "Kept the old fields next to the new ones."
        else:
            text = text.replace("totalCents", "amountCents").replace("placedAt", "createdAt")
            msg = "Renamed the fields."
        out({"event": "tool_call", "conversation_id": cid, "id": "t2", "tool": "replace_file_content",
             "args": {"TargetFile": str(events), "ReplacementChunks": [{"TargetContent": "x"}]}})
        events.write_text(text, encoding="utf-8", newline="\n")
        out({"event": "tool_result", "conversation_id": cid, "id": "t2", "status": "success", "output": "ok"})
        out({"event": "tool_call", "conversation_id": cid, "id": "t3", "tool": "run_command",
             "args": {"CommandLine": "npm test", "Cwd": str(ws)}})
        out({"event": "tool_result", "conversation_id": cid, "id": "t3", "status": "success", "exit_code": 0,
             "output": "tests pass"})
        out({"event": "message", "conversation_id": cid, "text": msg})
        out({"event": "result", "conversation_id": cid, "status": "success", "response": msg,
             "duration_seconds": 3.5, "num_turns": 4, "usage": usage})
        return 0
    if mode == "timeout":
        out({"event": "result", "conversation_id": cid, "status": "timeout", "response": "",
             "duration_seconds": 600, "num_turns": 9, "usage": usage})
        return 1
    if mode == "deltas":
        out({"event": "thought", "conversation_id": cid, "text": "Let me "})
        out({"event": "thought", "conversation_id": cid, "text": "think."})
        for part in ("O", "K", " KIWI"):
            out({"event": "message_delta", "conversation_id": cid, "delta": part})
        out({"event": "result", "conversation_id": cid, "status": "success", "response": "OK KIWI",
             "duration_seconds": 1.0, "num_turns": 1, "usage": usage})
        return 0
    out({"event": "message", "conversation_id": cid, "text": "OK"})
    out({"event": "result", "conversation_id": cid, "status": "success", "response": "OK", "duration_seconds": 1.0,
         "num_turns": 1, "usage": usage})
    return 0


if __name__ == "__main__":
    sys.exit(main())
