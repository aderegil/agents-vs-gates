"""Simulated humans (spec 16.2): every gate is decided by a fixed, deterministic policy, never by a model.

Each policy returns {"decision", "rationale", "policy"}; `decision` is a trace `Decision` (`approved`, `rejected`,
`changes_requested`). The flow engine records the policy id in the event's metadata with `simulated: true`, and the
actor's roster entry carries `simulated: true` (trace rule 13). The policy cards are in flow/prompts/<role>.md.

None of these policies reads the staging oracle: it is an instrument of the experiment, not evidence for anyone.
"""
from __future__ import annotations

import re

FAILURE_WORDS = re.compile(r"\b(declin\w*|error|reject\w*|fails?)\b", re.I)


REVIEW_MD = """# REVIEW.md · review guidelines (tech lead)

Written by the tech lead (simulated, fixed text) for the review agent. The review agent comments or requests changes;
it never approves. The code owner of each repo approves the merge.

1. Request changes when CI is red, when an acceptance criterion of the story has no test, or when a published event
   or API field is renamed, removed or retyped (ARCH-4: additive only).
2. Money is an integer in minor units plus an ISO-4217 code (ADR-0003). Flag any floating-point amount.
3. Zero-decimal currencies (JPY, KRW) need their own test wherever digits matter.
4. Non-blocking observations are `commented` findings with severity `low` or `info`.
"""


def _out(decision: str, rationale: str, policy: str) -> dict:
    return {"decision": decision, "rationale": rationale[:500], "policy": policy}


def product_owner_intent(intent: dict) -> dict:
    missing = [k for k in ("problem", "users", "outcome") if not str(intent.get(k) or "").strip()]
    if missing:
        return _out("rejected", "intent.md lacks: " + ", ".join(missing), "po-intent-checklist")
    return _out("approved", "intent.md states the problem, the users and the expected outcome.", "po-intent-checklist")


def product_owner_spec(spec: dict) -> dict:
    problems = []
    for s in spec["stories"]:
        if not s.get("repo"):
            problems.append(f"{s['id']} names no repo")
        if not s.get("acceptance_criteria"):
            problems.append(f"{s['id']} has no acceptance criteria")
    if not spec.get("money_in_minor_units"):
        problems.append("money is not kept in integer minor units")
    if problems:
        return _out("rejected", "; ".join(problems), "po-spec-checklist")
    return _out("approved", f"All {len(spec['stories'])} stories name a repo and have acceptance criteria; money stays "
                            "in minor units.", "po-spec-checklist")


def tech_lead_risk(spec: dict) -> dict:
    high = [s for s in spec["stories"] if s.get("risk") == "high"]
    vague = [s["id"] for s in high if not any(FAILURE_WORDS.search(c) for c in s.get("acceptance_criteria") or [])]
    if vague:
        return _out("changes_requested", "High-risk stories without a stated failure behaviour: " + ", ".join(vague),
                    "tl-high-risk")
    return _out("approved", "High-risk stories (" + ", ".join(s["id"] for s in high) + ") state their failure "
                            "behaviour.", "tl-high-risk")


def architect_contracts(spec: dict) -> dict:
    changes = [c for s in spec["stories"] for c in s.get("contract_changes") or []]
    breaking = [f"{c['contract']} ({c['change']})" for c in changes if c.get("kind") != "additive"]
    if breaking:
        return _out("rejected", "Breaking contract changes must go through deprecation (ARCH-4): " + "; ".join(breaking),
                    "arch-additive-only")
    if not spec.get("money_in_minor_units"):
        return _out("rejected", "Money must stay in integer minor units (ADR-0003).", "arch-additive-only")
    return _out("approved", f"{len(changes)} contract changes, all additive (ARCH-4); money in minor units (ADR-0003).",
                "arch-additive-only")


def engineer_plan(plan: dict, spec: dict) -> dict:
    problems = []
    story_ids = [s["id"] for s in spec["stories"]]
    tasks_by_story: dict[str, int] = {}
    for t in plan["tasks"]:
        tasks_by_story[t["story"]] = tasks_by_story.get(t["story"], 0) + 1
        if not t.get("repo") or not t.get("assignee"):
            problems.append(f"{t['id']} lacks a repo or an assignee")
        if t.get("status") == "blocked" and not t.get("blocked_reason"):
            problems.append(f"{t['id']} is blocked without a reason")
    for sid in story_ids:
        if tasks_by_story.get(sid, 0) != 1:
            problems.append(f"{sid} has {tasks_by_story.get(sid, 0)} tasks")
    if problems:
        return _out("rejected", "; ".join(problems), "eng-plan-checklist")
    blocked = [t["story"] for t in plan["tasks"] if t.get("status") == "blocked"]
    note = f" Blocked: {', '.join(blocked)} (reason stated)." if blocked else ""
    return _out("approved", f"One task per story, each with one repo and one code agent.{note}", "eng-plan-checklist")


def engineer_carry_over(task: dict) -> dict:
    if task.get("blocked_reason"):
        return _out("approved", f"Carry {task['story']} over to a later sprint: {task['blocked_reason']}.",
                    "eng-carry-over")
    return _out("rejected", "No reason given for the block.", "eng-carry-over")


def code_owner_merge(ci_ok: bool | None, review_decision: str | None, verifier_decision: str | None) -> dict:
    reasons = []
    if ci_ok is not True:
        reasons.append("the last CI run is not green")
    if review_decision == "changes_requested":
        reasons.append("the review agent requested changes")
    if verifier_decision == "changes_requested":
        reasons.append("the verifier reported failures")
    if reasons:
        return _out("rejected", "Not merged: " + "; ".join(reasons) + ".", "owner-ci-green-no-changes")
    return _out("approved", "CI green on the last version; no changes requested by the review agent or the verifier.",
                "owner-ci-green-no-changes")


def release_manager(release: dict, verifier_decision: str | None) -> dict:
    reasons = []
    if not release["merged"]:
        reasons.append("nothing merged")
    if any(not p["ci_ok"] for p in release["merged"]):
        reasons.append("a merged PR has a red last CI run")
    if verifier_decision == "changes_requested":
        reasons.append("the verifier requested changes")
    if release["carried_over"] and release.get("flag_state") != "off":
        reasons.append("blocked stories are not behind a disabled feature flag")
    if reasons:
        return _out("rejected", "; ".join(reasons), "rm-release-checklist")
    carried = f"; {', '.join(release['carried_over'])} carried over, flag {release['flag']} off" \
        if release["carried_over"] else ""
    return _out("approved", f"{len(release['merged'])} merged PRs with green CI; verifier found no failures{carried}.",
                "rm-release-checklist")
