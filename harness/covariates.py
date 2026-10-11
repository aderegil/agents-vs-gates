"""Run covariates read from the transcript (calibration finding from P0, see DECISIONS):

  ran_tests          the agent ran the project's checks at least once in `gen` (npm test, npm run test|typecheck|arch|build,
                     npx tsc) and the command was not denied
  ran_tests_any      same, in any session
  shell_denials      shell commands denied by the permission layer, all sessions
  shell_denials_gen  same, in `gen`

They are not outcomes; a run that never tested its change is still analysed, and the covariate is reported per cell.
"""
from __future__ import annotations

import re

TEST_CMD = re.compile(r"(?<![\w-])(npm\s+(?:test\b|run\s+(?:test|typecheck|arch|build)\b)|npx\s+tsc\b)")
SHELL_TOOLS = {"Bash", "shell", "exec_command", "local_shell"}
DENIED_TEXT = "Permission for this tool use was denied"


def compute(transcript: list[dict]) -> dict:
    calls = {e.get("id"): e for e in transcript if e.get("kind") == "tool_call" and e.get("name") in SHELL_TOOLS}
    ran_gen = ran_any = False
    den = den_gen = 0
    for e in transcript:
        if e.get("kind") != "tool_result" or e.get("id") not in calls:
            continue
        call = calls[e["id"]]
        gen = (call.get("session") or "gen") == "gen"
        # a late denial can arrive as status "error" carrying the permission message (seen in P0)
        if e.get("status") == "denied" or DENIED_TEXT in str(e.get("output") or ""):
            den += 1
            den_gen += gen
            continue
        cmd = str((call.get("input") or {}).get("command") or "")
        if TEST_CMD.search(cmd):
            ran_any = True
            ran_gen = ran_gen or gen
    return {"ran_tests": ran_gen, "ran_tests_any": ran_any, "shell_denials": den, "shell_denials_gen": den_gen}
