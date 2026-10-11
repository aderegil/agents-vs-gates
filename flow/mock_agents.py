"""Mock agents of the flow: deterministic, scripted outputs. Zero model calls (spec 0.1, 16.2).

Every agent role of the flow has a method here. Documents are rendered from the story drafts by fixed templates; code
changes are scripted:
- S-2 (orders-service) reuses the additive reference patch scenario/solutions/X-add/correct.patch with the field
  renamed by a fixed table (couponCode -> fxQuoteId), so it is a known-green, additive change;
- S-1, S-4 and S-5 overlay small files from flow/mock_edits/<story>/v<n>/ (S-4 has a v2 that answers the scripted
  review finding);
- S-3 (payments-service) and S-6 (inventory-service) have no repo in the scenario yet (M2a): their code agents report
  the missing repo and the story is carried over.
"""
from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

from harness import gitutil, paths

EDITS = Path(__file__).resolve().parent / "mock_edits"
XADD_PATCH = paths.SOLUTIONS / "X-add" / "correct.patch"
XADD_RENAMES = (  # applied in order; replacements keep every line in place, so the hunks stay valid
    ("/** Promotion code given at checkout; absent when none. */", "/** FX quote the shopper saw at checkout; absent when none. */"),
    ("/** Promotion code given at checkout, if any. */", "/** FX quote shown at checkout, if any. */"),
    ("maxCouponLength: 40", "maxFxQuoteIdLength: 64"),
    ("maxCouponLength", "maxFxQuoteIdLength"),
    ('"WELCOME5"', '"fxq-EUR-0001"'),
    ("couponCode", "fxQuoteId"),
)
MODELS = {"code": "mock-model-a", "review": "mock-model-b", "other": "mock-model-a"}

CONTRACT_CHANGES = {
    "S-2": [{"contract": "OrderPlaced (event)", "change": "add optional fxQuoteId", "kind": "additive"},
            {"contract": "POST /orders (orders-api)", "change": "accept optional fxQuoteId", "kind": "additive"}],
    "S-3": [{"contract": "PaymentCaptured (event)", "change": "no field removed; currency already present",
             "kind": "additive"}],
    "S-6": [{"contract": "StockReserved / StockShortage (events)", "change": "add optional warehouse",
             "kind": "additive"}],
}
REVIEWS = {  # (story, version) -> scripted review agent output when CI is green
    ("S-4", 1): {"decision": "changes_requested",
                 "summary": "Settlement digits for zero-decimal currencies are not tested; the story requires it.",
                 "findings": [{"severity": "medium", "title": "No test for JPY (0 decimals)",
                               "location": "test/settlement.test.ts"}]},
    ("S-5", 1): {"decision": "commented",
                 "summary": "No blocking findings. Note: amountMinor * rate * scale can exceed 2^53 for amounts above "
                            "~9e7 JPY; fine for current order limits.",
                 "findings": [{"severity": "low", "title": "Possible precision loss for very large JPY amounts",
                               "location": "src/core/reportingCurrency.ts"}]},
}
THOUGHTS = {
    "S-1": "Add a display-currency picker next to formatMoney; keep the orders client untouched.",
    "S-2": "Additive only: optional fxQuoteId on the request, the order and OrderPlaced; no field renamed.",
    "S-3": "Looking for payments-service in the sprint workspace.",
    "S-4": "Settlement currencies with their digits; unknown currency is a typed error, not 2 decimals.",
    "S-5": "Integer FX rates in parts per million; scale by minor-unit digits so JPY converts correctly.",
    "S-6": "Looking for inventory-service in the sprint workspace.",
}
FIXES = {("S-4", 2): "Added a JPY (0 decimals) test, as the review asked."}


def agent_id_for(repo: str) -> str:
    short = repo.removeprefix("web-").removesuffix("-service").removesuffix("-ingest")
    return f"code-{short}"


def xadd_as_fx_patch() -> str:
    text = XADD_PATCH.read_text(encoding="utf-8")
    text = "".join(l for l in text.splitlines(keepends=True) if "CANARY-" not in l)
    for old, new in XADD_RENAMES:
        text = text.replace(old, new)
    return text


def _overlay_files(story: str, version: int) -> dict[str, str]:
    base = EDITS / story / f"v{version}"
    return {p.relative_to(base).as_posix(): p.read_text(encoding="utf-8")
            for p in sorted(base.rglob("*")) if p.is_file()}


def _bullets(items) -> str:
    return "\n".join(f"- {i}" for i in items) or "- (none)"


class MockAgents:
    """Scripted outputs for requirements_agent, task_planner, code_agent, review_agent, verifier, devops_agent."""

    kind = "mock"
    model_calls = 0

    # ---- requirements_agent -----------------------------------------------------------------------------------
    def intent(self, epic: dict, stories: list[dict]) -> tuple[dict, str]:
        st = {"problem": "Shoppers outside the US see and pay prices in USD only; checkout abandons when the currency "
                         "is foreign.",
              "users": "International shoppers; teams Digital, Checkout, Payments, Finance, Data and Fulfilment.",
              "outcome": "A shopper can see prices, place an order and pay in a supported local currency; invoices, "
                         "revenue reports and stock reservation follow the order's currency.",
              "open_questions": ["Which FX source quotes the rates shown at checkout?",
                                 "Do refunds use the original FX quote?"]}
        md = (f"# Intent · {epic['id']} · {epic['title']}\n\n"
              f"Drafted by the requirements agent with the originator. Status: awaiting the product owner.\n\n"
              f"## Problem\n{st['problem']}\n\n## Users\n{st['users']}\n\n## Expected outcome\n{st['outcome']}\n\n"
              f"## Repos likely affected\n{_bullets(sorted({s['repo'] for s in stories}))}\n\n"
              f"## Open questions\n{_bullets(st['open_questions'])}\n")
        return st, md

    def spec(self, epic: dict, stories: list[dict]) -> tuple[dict, str]:
        ss = []
        for s in stories:
            ss.append({k: s[k] for k in ("id", "title", "repo", "team", "risk", "depends_on", "narrative",
                                         "acceptance_criteria")} | {"contract_changes": CONTRACT_CHANGES.get(s["id"], [])})
        st = {"epic": epic, "stories": ss, "money_in_minor_units": True}
        parts = [f"# Spec · {epic['id']} · {epic['title']}\n",
                 "Source: the story drafts in scenario/tasks/S-*.md (drafts for Alfredo). Money stays in integer minor "
                 "units plus an ISO-4217 code (ADR-0003).\n"]
        for s in ss:
            changes = [f"{c['contract']}: {c['change']} ({c['kind']})" for c in s["contract_changes"]]
            parts.append(f"## {s['id']} · {s['title']}\n- Repo: {s['repo']} (team {s['team']})\n- Risk: {s['risk']}\n"
                         f"- Depends on: {', '.join(s['depends_on']) or 'none'}\n\n{s['narrative']}\n\n"
                         f"Acceptance criteria:\n{_bullets(s['acceptance_criteria'])}\n\n"
                         f"Contract changes:\n{_bullets(changes)}\n")
        return st, "\n".join(parts)

    # ---- task_planner -----------------------------------------------------------------------------------------
    def plan(self, spec: dict, available_repos: set[str], ci_checks: dict[str, list[str]]) -> tuple[dict, str]:
        tasks = []
        for s in spec["stories"]:
            ok = s["repo"] in available_repos
            tasks.append({"id": f"T-{s['id']}", "story": s["id"], "repo": s["repo"],
                          "assignee": agent_id_for(s["repo"]), "depends_on": [f"T-{d}" for d in s["depends_on"]],
                          "estimate": {"low": "S", "medium": "M", "high": "L"}[s["risk"]],
                          "status": "ready" if ok else "blocked",
                          "blocked_reason": None if ok else "repo not yet in scenario (M2a)",
                          "checks": ci_checks.get(s["repo"], [])})
        st = {"tasks": tasks}
        rows = ["| Task | Story | Repo | Code agent | Depends on | Estimate | Status | CI checks |",
                "|---|---|---|---|---|---|---|---|"]
        for t in tasks:
            status = t["status"] + (f": {t['blocked_reason']}" if t["blocked_reason"] else "")
            rows.append(f"| {t['id']} | {t['story']} | {t['repo']} | {t['assignee']} | "
                        f"{', '.join(t['depends_on']) or '—'} | {t['estimate']} | {status} | "
                        f"{', '.join(t['checks']) or '—'} |")
        md = (f"# Plan · {spec['epic']['id']}\n\nOne task per story; one code agent per repo. Drafted by the task "
              f"planner; awaiting the engineer.\n\n" + "\n".join(rows) + "\n")
        return st, md

    # ---- code_agent -------------------------------------------------------------------------------------------
    def versions(self, story_id: str) -> int:
        if story_id == "S-2":
            return 1
        d = EDITS / story_id
        return len([p for p in d.iterdir() if p.is_dir()]) if d.is_dir() else 0

    def thought(self, story_id: str) -> str:
        return THOUGHTS.get(story_id, "Reading the task and the plan.")

    def change(self, story_id: str, version: int) -> dict:
        """{"files": {rel: text}} or {"patch": text} for one PR version."""
        if story_id == "S-2" and version == 1:
            return {"patch": xadd_as_fx_patch()}
        files = _overlay_files(story_id, version)
        if not files:
            raise KeyError(f"no scripted change for {story_id} v{version}")
        return {"files": files}

    @staticmethod
    def apply(repo_dir: Path, change: dict) -> list[str]:
        """Writes the change into the repo checkout; returns the touched paths (repo-relative)."""
        if "patch" in change:
            # A file, not stdin: text-mode pipes on Windows would turn LF into CRLF and break the hunks.
            fd, tmp = tempfile.mkstemp(suffix=".patch", prefix="flow-")
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
                    f.write(change["patch"])
                gitutil.git(repo_dir, "apply", "--whitespace=nowarn", tmp)
            finally:
                os.unlink(tmp)
            return re.findall(r"^\+\+\+ b/(\S+)", change["patch"], re.M)
        for rel, text in change["files"].items():
            p = repo_dir / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8", newline="\n")
        return list(change["files"])

    def report(self, story: dict, version: int, files: list[str]) -> str:
        if (story["id"], version) in FIXES:
            return FIXES[(story["id"], version)]
        return f"{story['id']}: {story['title']}. Changed {len(files)} files ({', '.join(files[:4])}). Tests added."

    def missing_repo(self, story: dict) -> str:
        return (f"Blocked: {story['repo']} is not in the sprint workspace (repo not yet in scenario, M2a). "
                f"Nothing changed.")

    # ---- review_agent -----------------------------------------------------------------------------------------
    def review(self, story: dict, version: int, verdict: dict) -> dict:
        if not verdict["ok"]:
            failed = [c["id"] for c in verdict["checks"] if c["status"] != "pass"]
            return {"decision": "changes_requested", "summary": f"CI is red ({', '.join(failed)}); fix before review.",
                    "findings": [{"severity": "high", "title": f"Failing check {f}", "location": story["repo"]}
                                 for f in failed]}
        return REVIEWS.get((story["id"], version),
                           {"decision": "commented", "summary": "No blocking findings; acceptance criteria covered by "
                                                                "the tests in the PR.", "findings": []})

    # ---- verifier ---------------------------------------------------------------------------------------------
    def verify_pr(self, story: dict, verdict: dict) -> dict:
        ut = next((c for c in verdict["checks"] if c["id"] == "unit-tests"), None)
        tc = next((c for c in verdict["checks"] if c["id"] == "typecheck"), None)
        ok = bool(ut and tc and ut["status"] == "pass" and tc["status"] == "pass")
        tests = re.search(r"tests (\d+)", (ut or {}).get("output") or "")
        evidence = f"typecheck {tc['status'] if tc else 'missing'}, unit tests {ut['status'] if ut else 'missing'}" + \
                   (f" ({tests.group(1)} tests)" if tests else "")
        return {"decision": "commented" if ok else "changes_requested",
                "summary": f"Verified the PR version (mock: evidence from its CI run: {evidence}). No fixes made."}

    def verification_md(self, epic: dict, results: list[dict]) -> str:
        rows = ["| Story | Repo | PR version | CI | Verifier |", "|---|---|---|---|---|"]
        for r in results:
            rows.append(f"| {r['story']} | {r['repo']} | {r.get('version') or '—'} | "
                        f"{'green' if r.get('ci_ok') else ('red' if r.get('ci_ok') is False else '—')} | "
                        f"{r.get('verifier') or r.get('status')} |")
        return (f"# Verification · {epic['id']}\n\nThe verifier ran each merged PR in isolation and fixed nothing. "
                f"The staging oracle is not part of this note (it is hidden from every agent).\n\n" + "\n".join(rows) +
                "\n")

    def verify_release(self, release: dict) -> dict:
        red = [p["story"] for p in release["merged"] if not p["ci_ok"]]
        if red:
            return {"decision": "changes_requested", "summary": "Red CI on merged PRs: " + ", ".join(red)}
        return {"decision": "commented",
                "summary": f"Release candidate checked: {len(release['merged'])} merged PRs green; "
                           f"carried over: {', '.join(release['carried_over']) or 'none'}."}

    # ---- devops_agent (permissive variant) / flow engine (default) -------------------------------------------
    @staticmethod
    def release_md(epic: dict, release: dict, author: str) -> str:
        merged = [f"{p['story']} · {p['repo']} · PR v{p['version']} (rollback: revert the merge in {p['repo']})"
                  for p in release["merged"]]
        return (f"# Release candidate · {epic['id']} · r1\n\nPrepared by {author}. Feature flag `{release['flag']}` "
                f"ships **{release['flag_state']}** until the carried-over stories land.\n\n## Ships\n{_bullets(merged)}"
                f"\n\n## Carried over\n{_bullets(release['carried_over'])}\n")
