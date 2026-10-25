"""Scripted AI-SDLC scenes, one per public model, for the Replay Theater (night order 2026-10-13, section B).

    .venv\\Scripts\\python.exe -X utf8 -m replay.scenes.make_scenes [--check]

Writes, for each scene, the AISDLC-Trace 2.1 file `replay/scenes/traces/<id>.jsonl`, its replay
`console/plugins/replay/app/public/scenes/<id>.json` (bundled into the theater build), `.../scenes/index.json`, and
the beat → source table `replay/scenes/SOURCES.md`. `--check` validates without writing (trace rules 1-13 and the
replay schema).

These are ILLUSTRATIONS, not measurements: every trace says `metadata.source = "illustration"`, every replay is
labelled "Illustration · scripted from public documentation" with its source and date, and nothing here is a run.
The same feature goes through every model so the scenes compare: Meridian Retail (fictional) renames
`totalCents`/`placedAt` on `OrderPlaced` (the experiment's X-rename). In every scene the agent's first attempt drops
the old field names although the rule is in its context: the scripted premise, so the scenes differ only in what
the model has after generation. How often that happens with the rule in view is the experiment's to say (README).
Stages, roles and artifacts are only the ones each source names (`docs/AI-SDLC-SOURCES.md`, and spec-kit's
public docs); where a source is silent about CI, the scene shows that silence.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO))

from replay.export import build_replay  # noqa: E402

TRACES = HERE / "traces"
PUBLIC = REPO / "console" / "plugins" / "replay" / "app" / "public" / "scenes"
T0 = datetime(2026, 10, 13, 9, 0, 0, tzinfo=timezone.utc)
AXIS = ["intent", "spec", "plan", "tasks", "code", "review", "ci", "release", "production"]
AXIS_LABEL = {"intent": "Intent", "spec": "Spec", "plan": "Plan", "tasks": "Tasks", "code": "Code",
              "review": "Review", "ci": "CI", "release": "Release", "production": "Production"}
FEATURE = "Rename totalCents/placedAt on OrderPlaced"
MISS = ("Same scripted case in every model: the first attempt renames the fields and drops the old names, "
        "although the rule is in the agent's context.")
CI_ARCH4_FAIL = ("ARCH-4 FAIL billing-service: OrderPlaced.totalCents missing (required integer)\n"
                 "ARCH-4 FAIL analytics-ingest: OrderPlaced.placedAt missing (required iso-datetime)\n"
                 "ARCH-4 PASS web-storefront: GET /orders/{id} (9 required fields present)")
CI_ARCH4_PASS = ("ARCH-4 PASS billing-service: OrderPlaced (4 required fields present)\n"
                 "ARCH-4 PASS analytics-ingest: OrderPlaced (5 required fields present)\n"
                 "ARCH-4 PASS web-storefront: GET /orders/{id} (9 required fields present)")
BREAK = {"billing-service": "1 of 5 tests failed: invoices order A: totalCents missing",
         "analytics-ingest": "1 of 5 tests failed: records order A: placedAt missing"}


class Scene:
    """Builds one AISDLC-Trace 2.1 session, event by event, with a scripted clock."""

    def __init__(self, sid: str, title: str, frameworks: list[str], roster: list[dict], illustration: dict,
                 start_actor: str):
        self.sid = sid
        self.events: list[dict] = []
        self.t = T0
        self.phase = "discovery"
        self.ids = {r["actor_id"]: r for r in roster}
        self.versions: dict[str, int] = {}
        self.ci_attempt = -1
        self._ev("SESSION_STARTED", start_actor, {
            "title": title, "scenario": "meridian-retail/illustration", "initial_phase": "discovery",
            "roster": roster, "frameworks": frameworks}, wait=0,
            metadata={"source": "illustration", "run_id": sid, "unit": "illustration", "ticket": "X-rename",
                      "illustration": illustration},
            visual={"narration": f"{illustration['model']} · {FEATURE} at Meridian Retail (fictional)."})

    # ------------------------------------------------------------------------------------------- primitives
    def _actor(self, aid: str) -> dict:
        r = self.ids[aid]
        return {"actor_id": aid, "actor_type": r["actor_type"], "role": r["role"]}

    def _ev(self, et: str, actor: str, payload: dict, *, wait: float = 2.4, say: str | None = None,
            metadata: dict | None = None, visual: dict | None = None, **env) -> dict:
        self.t += timedelta(milliseconds=int(wait * 1000))
        e = {"schema_version": "2.1.0", "event_id": f"evt-{len(self.events):04d}", "seq": len(self.events),
             "session_id": self.sid, "run_id": self.sid,
             "timestamp": self.t.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
             "event_type": et, "phase": self.phase, "actor": self._actor(actor), "payload": payload}
        e.update(env)
        if say or visual:
            e["visual"] = dict(visual or {}, **({"narration": say[:280]} if say else {}))
        if metadata:
            e["metadata"] = metadata
        self.events.append(e)
        return e

    def beat(self, stage: str, axis: str, cite: str, **extra) -> dict:
        assert axis in AXIS, axis
        return {"stage": stage, "axis": axis, "cite": cite, **extra}

    def to_phase(self, phase: str, actor: str, reason: str, md: dict, say: str | None = None):
        prev, self.phase = self.phase, phase
        self._ev("PHASE_CHANGED", actor, {"from_phase": prev, "to_phase": phase, "reason": reason}, wait=1.2,
                 metadata=md, say=say)

    def create(self, actor: str, art: str, atype: str, path: str, summary: str, md: dict, say=None, wait=2.6):
        self.versions[art] = 1
        return self._ev("ARTIFACT_CREATED", actor, {"artifact_id": art, "artifact_type": atype, "path": path,
                                                    "summary": summary}, artifact_ids=[art], metadata=md, say=say,
                        wait=wait)

    def update(self, actor: str, art: str, path: str, change: str, md: dict, say=None, diff=None, wait=2.6):
        self.versions[art] += 1
        p = {"artifact_id": art, "path": path, "version": self.versions[art], "change_summary": change}
        if diff:
            p["diff"] = diff
        return self._ev("ARTIFACT_UPDATED", actor, p, artifact_ids=[art], metadata=md, say=say, wait=wait)

    def read(self, actor: str, art: str, path: str, purpose: str, md: dict, say=None, wait=1.6):
        return self._ev("ARTIFACT_READ", actor, {"artifact_id": art, "path": path, "purpose": purpose},
                        artifact_ids=[art], metadata=md, say=say, wait=wait)

    def review(self, actor: str, art: str, decision: str, summary: str, md: dict, say=None, findings=None, wait=2.4):
        p = {"subject_artifact_id": art, "decision": decision, "summary": summary}
        if findings:
            p["findings"] = findings
        return self._ev("REVIEW_SUBMITTED", actor, p, artifact_ids=[art], metadata=md, say=say, wait=wait)

    def message(self, actor: str, to: str, content: str, itype: str, md: dict, say=None, wait=2.2):
        return self._ev("MESSAGE_EXCHANGED", actor, {"content": content},
                        interaction={"source_actor_id": actor, "target_actor_id": to, "interaction_type": itype},
                        metadata=md, say=say, wait=wait)

    def tool(self, actor: str, name: str, inp: str, out: str, status: str, md: dict, say=None, wait=2.0):
        cid = f"call-{len(self.events):04d}"
        self._ev("TOOL_CALL_STARTED", actor, {"tool_name": name, "protocol": "cli", "input_summary": inp},
                 correlation_id=cid, metadata=md, wait=wait)
        return self._ev("TOOL_CALL_COMPLETED", actor, {"tool_name": name, "status": status, "output_summary": out},
                        correlation_id=cid, metadata=md, say=say, wait=1.6)

    def ci(self, art: str, checks: list[tuple[str, str, str, str, str | None]], md: dict, say=None):
        """checks: (check_id, category, status, output, rule_id)."""
        self.ci_attempt += 1
        self._ev("CI_RUN_STARTED", "ci", {"run_attempt": self.ci_attempt, "subject_artifact_id": art},
                 artifact_ids=[art], metadata=md, wait=1.8)
        failed = []
        for cid, cat, st, out, rule in checks:
            p = {"check_id": cid, "category": cat, "status": st, "output_excerpt": out, "duration_ms": 900}
            if rule:
                p["rule_id"] = rule
            self._ev("CHECK_COMPLETED", "ci", p, metadata=md, wait=0.7)
            if st != "pass":
                failed.append(cid)
        return self._ev("CI_RUN_COMPLETED", "ci", {"run_attempt": self.ci_attempt, "ok": not failed,
                                                  "failed_checks": failed}, metadata=md, say=say, wait=0.9)

    def ask(self, actor: str, to: str, rid: str, gate: str, question: str, art: str, md: dict, say=None):
        return self._ev("APPROVAL_REQUESTED", actor, {"request_id": rid, "gate": gate, "question": question,
                                                      "subject_artifact_id": art, "options": ["approved", "rejected"]},
                        interaction={"source_actor_id": actor, "target_actor_id": to,
                                     "interaction_type": "human_intervention"}, artifact_ids=[art], metadata=md,
                        say=say, wait=2.0)

    def decide(self, actor: str, rid: str, decision: str, rationale: str, md: dict, say=None):
        return self._ev("APPROVAL_DECIDED", actor, {"request_id": rid, "decision": decision, "rationale": rationale},
                        metadata=md, say=say, wait=2.4)

    def consumers(self, broken: bool, md: dict, say: str, state: str = "final"):
        first = True
        for c in ("billing-service", "analytics-ingest", "web-storefront"):
            bad = broken and c in BREAK
            self._ev("ORACLE_RESULT", "staging", {"consumer": c, "state": state, "ok": not bad,
                                                  "message": BREAK[c] if bad else "all tests passed"},
                     metadata=md, say=say if first else None, wait=1.4 if first else 0.5)
            first = False

    def end(self, outcome: str, summary: str, say: str):
        self._ev("SESSION_ENDED", next(iter(self.ids)), {"outcome": outcome, "summary": summary,
                                                        "stats": {"events": len(self.events) + 1}},
                 visual={"hold_ms": 4500}, say=say, wait=2.4)


def person(aid: str, role: str, name: str) -> dict:
    return {"actor_id": aid, "actor_type": "human", "role": role, "display_name": name}


def agent(aid: str, role: str, name: str) -> dict:
    return {"actor_id": aid, "actor_type": "agent", "role": role, "display_name": name, "model": None}


SYSTEMS = [{"actor_id": "ci", "actor_type": "system", "role": "ci", "display_name": "CI"},
           {"actor_id": "staging", "actor_type": "system", "role": "staging",
            "display_name": "The other teams' tests"}]


# ------------------------------------------------------------------------------------------------- the scenes
def anthropic() -> Scene:
    src = "Anthropic, The AI-native SDLC playbook (21 Aug 2026)"
    ill = {"id": "anthropic", "model": "Anthropic · AI-native SDLC playbook", "short": "Anthropic",
           "source": src, "date": "2026-08-21",
           "url": "https://claude.com/resources/articles/the-ai-native-sdlc-playbook",
           "stages": ["Plan", "Design", "Build", "Test", "Deploy", "Maintain"],
           "rule": {"axis": "plan", "place": "desk-orders",
                    "label": "CLAUDE.md · Architecture (context the agent reads)"},
           "blocks": {"axis": "review", "place": "review-desk",
                      "label": "Code owner approval (branch protection)"},
           "ci_arch": False, "outcome": {"status": "caught", "axis": "review",
                                         "label": "Caught at review: LLM pass + human"}}
    s = Scene("aisdlc-anthropic", "Meridian Retail · rename on OrderPlaced · Anthropic playbook",
              ["Anthropic · AI-native SDLC playbook"],
              [person("originator", "originator", "Priya · Originator"),
               person("product-owner", "product_owner", "Tomás · Product Owner"),
               agent("claude-spec", "requirements_agent", "Claude · spec session"),
               person("engineer", "engineer", "Lena · Engineer"),
               agent("claude-code", "code_agent", "Claude Code · orders-service"),
               agent("code-review", "review_agent", "Code Review"),
               person("code-owner", "code_owner", "Omar · Code Owner"),
               person("release-manager", "release_manager", "Ravi · Release Manager"), *SYSTEMS],
              ill, "originator")
    b = s.beat
    s.create("originator", "art-intent", "intent", "intent/orderplaced-rename.md",
             "Rename totalCents → amountCents and placedAt → createdAt on OrderPlaced",
             b("Plan", "intent", "Stage 1 Plan · Capture as intent.md", handoff_to="product-desk"),
             say="Plan: Priya describes the change to Claude and commits intent.md.")
    s.review("product-owner", "art-intent", "approved", "Intent accepted into Design",
             b("Plan", "intent", "Plan · Governance considerations: the product owner approves"),
             say="Tomás, the product owner, accepts intent.md.")
    s.to_phase("planning", "product-owner", "intent.md accepted", b("Design", "spec", "Stage 2 Design"))
    s.create("claude-spec", "art-spec", "spec", "spec.md", "Requirements and design for the rename, concerns flagged",
             b("Design", "spec", "Design · Requirements and design (How to execute it)", handoff_to="product-desk"),
             say="Design: Claude turns intent.md into spec.md, guided by the organization's skills.")
    s.review("product-owner", "art-spec", "approved", "Spec signed off; build may start",
             b("Design", "spec", "Design · the product owner decides whether the spec progresses to build"),
             say="Tomás signs off spec.md. Accepting the spec starts plan mode.")
    s.to_phase("implementation", "engineer", "spec.md accepted", b("Build", "plan", "Stage 3 Build"))
    s.create("engineer", "art-claude", "context_file", "CLAUDE.md",
             "## Architecture: Kafka events are defined in schemas/; published event fields are never renamed or "
             "removed without keeping the old ones",
             b("Build", "plan", "Build · The CLAUDE.md (What it looks like: ## Architecture)", rule=True),
             say="The architecture rule lives in CLAUDE.md: context Claude Code reads at the start of every session.")
    s.read("claude-code", "art-claude", "CLAUDE.md", "session context", b("Build", "plan", "Build · The CLAUDE.md"))
    s.create("claude-code", "art-plan", "plan", "plan.md", "Files that change, order of work, tests that prove it",
             b("Build", "plan", "Build · Claude Code plan mode as the default starting point"),
             say="In plan mode, Claude Code writes plan.md without touching any file.")
    s.review("engineer", "art-plan", "approved", "Plan accepted",
             b("Build", "plan", "Build · plan mode: routine changes are approved by the engineer"),
             say="Lena, the engineer, accepts plan.md and lets Claude implement.")
    s.tool("claude-code", "Edit", "src/core/events.ts", "OrderPlaced: totalCents → amountCents, placedAt → createdAt",
           "success", b("Build", "code", "Build · Accept the plan and let Claude implement"), say=MISS)
    s.tool("claude-code", "Bash", "make test", "all tests passed", "success",
           b("Test", "code", "Stage 4 Test · Give Claude a feedback loop"),
           say="Test: Claude runs its own tests. They pass: they are orders-service's tests.")
    s.to_phase("review", "claude-code", "PR opened", b("Deploy", "review", "Stage 5 Deploy"))
    s.create("claude-code", "art-pr", "pull_request", "PR #412", "3 files changed",
             b("Deploy", "review", "Deploy · AI in the PR review loop"))
    s.ci("art-pr", [("lint", "build", "pass", "make lint: zero warnings", None),
                    ("tests", "test", "pass", "make test: all green", None)],
         b("Deploy", "ci", "Build · CLAUDE.md Commands: make lint runs in CI; Test · the PR's check run"),
         say="CI runs lint and tests. Both pass. No check in CI reads the consumers' contracts.")
    s.review("code-review", "art-pr", "changes_requested",
             "Important (Compliance): renames published OrderPlaced fields; CLAUDE.md says keep the old ones",
             b("Deploy", "review", "Deploy · REVIEW.md passes: Compliance against spec.md, plan.md, design principles"),
             findings=[{"severity": "high", "title": "Published event fields renamed without the old names",
                        "location": "src/core/events.ts"}],
             say="Code Review's compliance pass flags it. A finding is advice: it does not block the PR on its own.")
    s.message("engineer", "claude-code", "@claude address the Important finding", "feedback_request",
              b("Deploy", "review", "Deploy · tag @claude on a review comment; Claude addresses it and pushes"))
    s.update("claude-code", "art-pr", "PR #412", "keeps totalCents and placedAt as @deprecated aliases",
             b("Deploy", "review", "Deploy · Claude pushes the fix; the PR thread records both"),
             say="Claude keeps the old names as @deprecated aliases and pushes the fix.",
             diff={"files_changed": 2, "lines_added": 8, "lines_removed": 0})
    s.ci("art-pr", [("lint", "build", "pass", "make lint: zero warnings", None),
                    ("tests", "test", "pass", "make test: all green", None)],
         b("Deploy", "ci", "Deploy · the PR's check run"))
    s.review("code-review", "art-pr", "commented", "No Important findings",
             b("Deploy", "review", "Deploy · findings do not approve or block a PR on their own"))
    s.review("code-owner", "art-pr", "approved", "Approved",
             b("Deploy", "review", "Deploy · branch protection still requires approval from a code owner", blocks=True),
             say="Omar, the code owner, approves. Branch protection is what blocks the merge.")
    s.to_phase("deployment", "code-owner", "PR merged", b("Deploy", "release", "Deploy · Hooks as approval gates"))
    s.ask("claude-code", "release-manager", "rel-1", "production-release", "Deploy PR #412 to production?",
          "art-pr", b("Deploy", "release", "Deploy · production-gate.sh: a named release authorization"),
          say="A hook stops the production deploy until the release manager authorizes it.")
    s.decide("release-manager", "rel-1", "approved", "Release authorized",
             b("Deploy", "release", "Deploy · the release manager authorizes it"))
    s.to_phase("maintenance", "release-manager", "released", b("Maintain", "production", "Stage 6 Maintain"))
    s.consumers(False, b("Maintain", "production", "(illustration) the other teams' own tests"),
                say="The other teams' services keep working: the old names are still there.")
    s.end("success", "Caught at review by an LLM pass that reads CLAUDE.md, then a human approval",
          "Caught here at review: an advisory LLM pass plus a human. Nothing deterministic checked the rule.")
    return s


def aws() -> Scene:
    ill = {"id": "aws", "model": "AWS · AI-DLC (blog + aidlc-workflows)", "short": "AWS AI-DLC",
           "source": "AWS, AI-DLC blog (31 Jul 2025) + awslabs/aidlc-workflows 2.11.0", "date": "2025-07-31",
           "url": "https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/",
           "stages": ["Inception", "Construction", "Operations"],
           "rule": {"axis": "plan", "place": "planning-room",
                    "label": "The design artifacts (Contract Design), reviewed by an LLM reviewer"},
           "blocks": {"axis": "release", "place": "merge-gate",
                      "label": "Release: manual approval (tech lead or product owner)"},
           "ci_arch": False, "outcome": {"status": "escapes", "axis": "production",
                                         "label": "Escapes: 2 consumers break"}}
    s = Scene("aisdlc-aws", "Meridian Retail · rename on OrderPlaced · AWS AI-DLC",
              ["AWS · AI-DLC (blog + aidlc-workflows)"],
              [person("product-owner", "product_owner", "Chen · Product Owner"),
               agent("product-agent", "requirements_agent", "Product Agent"),
               agent("product-lead", "review_agent", "Product Lead"),
               agent("architect-agent", "task_planner", "Architect Agent"),
               agent("arch-reviewer", "review_agent", "Architecture Reviewer"),
               person("architect", "architect", "Kwame · Architect"),
               agent("developer-agent", "code_agent", "Developer Agent · orders-service"),
               agent("quality-agent", "verifier", "Quality Agent"),
               agent("pipeline-agent", "devops_agent", "Pipeline & Deploy Agent"),
               agent("operations-agent", "monitoring_agent", "Operations Agent"), *SYSTEMS],
              ill, "product-owner")
    b = s.beat
    s.message("product-owner", "product-agent", FEATURE, "task_assignment",
              b("Inception", "intent", "aidlc-workflows · Product Agent leads Intent Capture"),
              say="Inception: Chen states the intent; the Product Agent leads Intent Capture.")
    s.create("product-agent", "art-req", "spec", "requirements.md", "Requirements and user stories for the rename",
             b("Inception", "spec", "Blog · Inception: intent → requirements, stories and units (Mob Elaboration)"),
             say="The Product Agent writes requirements and stories. The whole team validates them: Mob Elaboration.")
    s.review("product-lead", "art-req", "commented", "Stories complete and testable",
             b("Inception", "spec", "aidlc-workflows · Product Lead: does not produce, only reviews"))
    s.review("product-owner", "art-req", "approved", "Requirements validated",
             b("Inception", "spec", "Blog · implements solutions only after receiving human validation"),
             say="Chen validates them: AI-DLC defers critical decisions to humans.")
    s.to_phase("planning", "product-owner", "requirements validated",
               b("Inception", "plan", "aidlc-workflows · Architect Agent leads Units Generation, Contract Design"))
    s.create("architect-agent", "art-design", "plan", "design/contract-design.md",
             "Units of work and the OrderPlaced contract: new names, old names kept during a deprecation window",
             b("Inception", "plan", "aidlc-workflows · Architect Agent: domain design, contract design", rule=True),
             say="The Architect Agent designs the units and the OrderPlaced contract. The rule lives in this design.")
    s.review("arch-reviewer", "art-design", "commented", "Design sound and implementable",
             b("Inception", "plan", "aidlc-workflows · Architecture Reviewer reviews technical design artifacts"),
             say="The Architecture Reviewer, an LLM, reviews the design before any code exists.")
    s.review("architect", "art-design", "approved", "Design approved",
             b("Construction", "plan", "Blog · Mob Construction: the team clarifies architectural choices"))
    s.to_phase("implementation", "architect", "design approved",
               b("Construction", "code", "Blog · Construction phase"))
    s.read("developer-agent", "art-design", "design/contract-design.md", "code generation",
           b("Construction", "code", "aidlc-workflows · Developer Agent leads Code Generation"))
    s.tool("developer-agent", "Edit", "src/core/events.ts", "OrderPlaced: totalCents → amountCents, placedAt → createdAt",
           "success", b("Construction", "code", "aidlc-workflows · Developer Agent: code generation"), say=MISS)
    s.tool("quality-agent", "Bash", "npm test", "generated test suite: all passed", "success",
           b("Construction", "code", "aidlc-workflows · Quality Agent leads Build and Test"),
           say="The Quality Agent runs the test suite the AI generated. It passes.")
    s.to_phase("review", "developer-agent", "bolt ready to merge", b("Construction", "review", "Construction"))
    s.create("developer-agent", "art-pr", "pull_request", "PR #88", "bolt 3: OrderPlaced rename",
             b("Construction", "review", "aidlc-workflows · Bolt merge"))
    s.ci("art-pr", [("lint", "build", "pass", "Lint: zero lint errors", None),
                    ("unit-tests", "test", "pass", "Unit Test: all passed", None),
                    ("coverage", "test", "pass", "Test coverage 84% (>= 80%)", None),
                    ("security-scan", "build", "pass", "Security scan: zero Critical/High", None),
                    ("integration", "test", "pass", "Integration tests: 100% pass", None)],
         b("Construction", "ci", "cicd-patterns.md · CI Pipeline Stages and Quality Gates"),
         say="CI quality gates: lint, tests, coverage, security, integration. All pass. None is an architecture rule.")
    s.to_phase("deployment", "pipeline-agent", "CI passed", b("Operations", "release", "Blog · Operations phase"))
    s.ask("pipeline-agent", "product-owner", "rel-1", "manual-approval", "Promote bolt 3 to production?", "art-pr",
          b("Operations", "release", "cicd-patterns.md · Manual approval: tech lead or product owner sign-off",
            blocks=True), say="Manual approval gate: the product owner signs off the release.")
    s.decide("product-owner", "rel-1", "approved", "Release approved",
             b("Operations", "release", "cicd-patterns.md · Quality Gates: Manual approval"))
    s.to_phase("maintenance", "product-owner", "deployed",
               b("Operations", "production", "Blog · Operations: deployments with team oversight"))
    s.consumers(True, b("Operations", "production", "(illustration) the other teams' own tests"),
                say="Billing and analytics break in production: they still read the old names.")
    s.message("operations-agent", "product-owner", "Incident: billing cannot invoice new orders", "report",
              b("Operations", "production", "aidlc-workflows · Operations Agent leads Incident Response"),
              say="Contract testing (Pact) is in the pipeline agent's knowledge for many repos, not a required gate.")
    s.end("failed", "The break escaped: no step after generation checked the consumers' contracts",
          "Escaped: the rule lived in the design; after generation nothing checked it.")
    return s


def kiro() -> Scene:
    ill = {"id": "kiro", "model": "Kiro · specs, steering, hooks", "short": "Kiro",
           "source": "Kiro docs: Specs, Steering, Hooks, Custom agents (captured 10 Oct 2026)", "date": "2026-10-10",
           "url": "https://kiro.dev/docs/specs/",
           "stages": ["Requirements", "Design", "Tasks", "Implementation"],
           "rule": {"axis": "plan", "place": "desk-orders",
                    "label": "Steering structure.md and design.md (context)"},
           "blocks": {"axis": "review", "place": "pr-tray",
                      "label": "The user reviewing the PR (no CI step described)"},
           "ci_arch": False, "outcome": {"status": "escapes", "axis": "production",
                                         "label": "Escapes: 2 consumers break"}}
    s = Scene("aisdlc-kiro", "Meridian Retail · rename on OrderPlaced · Kiro", ["Kiro · specs, steering, hooks"],
              [person("user", "engineer", "Elif · User"),
               agent("spec-agent", "requirements_agent", "Spec agent"),
               agent("kiro-agent", "code_agent", "Kiro agent · orders-service"), *SYSTEMS],
              ill, "user")
    b = s.beat
    s.create("user", "art-steer", "context_file", ".kiro/steering/structure.md",
             "Architectural decisions: published event fields stay backward compatible",
             b("Steering", "intent", "Steering · Project Structure (structure.md): architectural decisions", rule=True),
             say="Steering: structure.md records the architecture decisions. It is context for the agent.")
    s.message("user", "spec-agent", FEATURE, "task_assignment",
              b("Requirements", "intent", "Specs · Start a spec"),
              say="Elif, the user, starts a spec: the docs address a generic user, not named roles.")
    s.to_phase("planning", "user", "spec started", b("Requirements", "spec", "Specs · Three-Phase Workflow"))
    s.create("spec-agent", "art-req", "spec", ".kiro/specs/orderplaced-rename/requirements.md",
             "WHEN an order is placed THE SYSTEM SHALL publish OrderPlaced with amountCents and createdAt",
             b("Requirements", "spec", "Specs · Requirements with EARS notation"),
             say="Requirements in EARS notation: WHEN an order is placed THE SYSTEM SHALL publish …")
    s.review("user", "art-req", "approved", "Happy? yes",
             b("Requirements", "spec", "Specs · Requirements-First: Happy? → design.md"))
    s.read("spec-agent", "art-steer", ".kiro/steering/structure.md", "design context",
           b("Design", "plan", "Steering · included in every interaction"))
    s.create("spec-agent", "art-design", "spec", "design.md", "Event schema change with a deprecation window",
             b("Design", "plan", "Specs · Design: technical architecture in design.md", rule=True),
             say="design.md: the agent designs the change, old names kept for a deprecation window.")
    s.review("user", "art-design", "approved", "Happy? yes", b("Design", "plan", "Specs · approval gate"))
    s.create("spec-agent", "art-tasks", "task_list", "tasks.md", "4 tasks: event type, publisher, tests, docs",
             b("Tasks", "tasks", "Specs · Tasks: discrete, executable tasks in tasks.md"),
             say="tasks.md: four discrete tasks.")
    s.to_phase("implementation", "user", "Run all Tasks", b("Implementation", "code", "Specs · Run all Tasks"))
    s.tool("kiro-agent", "Edit", "src/core/events.ts", "OrderPlaced: totalCents → amountCents, placedAt → createdAt",
           "success", b("Implementation", "code", "Specs · Task Execution"), say=MISS)
    s.tool("kiro-agent", "hook · Post Task Execution", "npm test", "all tests passed", "success",
           b("Implementation", "code", "Hooks · Post Task Execution: run tests after a task completes"),
           say="A Post Task Execution hook runs the tests in the agent's session. They pass.")
    s.to_phase("review", "kiro-agent", "tasks done", b("Implementation", "review", "Specs · Task Execution"))
    s.create("kiro-agent", "art-pr", "pull_request", "PR #57", "4 tasks done",
             b("Implementation", "review", "Specs · the agent opens a pull request with a description"),
             say="The agent opens a pull request. Kiro's docs describe no CI step after it.")
    s.review("user", "art-pr", "approved", "Looks good",
             b("Implementation", "review", "Specs · you can continue to provide feedback", blocks=True),
             say="Elif reviews the diff and merges. Nothing she sees mentions billing or analytics.")
    s.to_phase("deployment", "user", "merged", b("(not described)", "release", "AI-SDLC-SOURCES §2: no CI/CD in the docs"))
    s.to_phase("maintenance", "user", "running", b("(not described)", "production", "AI-SDLC-SOURCES §2"))
    s.consumers(True, b("(not described)", "production", "(illustration) the other teams' own tests"),
                say="Billing and analytics break: the property tests and hooks ran in the session, on this repo only.")
    s.end("failed", "The break escaped: the rule was context; no check after generation read the consumers",
          "Escaped: the rule lived in steering and design.md, as context.")
    return s


def speckit() -> Scene:
    ill = {"id": "speckit", "model": "GitHub spec-kit", "short": "spec-kit",
           "source": "github/spec-kit README and spec-driven.md (public docs, read 13 Oct 2026)", "date": "2026-10-13",
           "url": "https://github.com/github/spec-kit",
           "stages": ["constitution", "specify", "plan", "tasks", "implement"],
           "rule": {"axis": "intent", "place": "planning-room",
                    "label": "The constitution (a project article), checked by plan gates"},
           "blocks": {"axis": "review", "place": "pr-tray",
                      "label": "Team review (no CI step described)"},
           "ci_arch": False, "outcome": {"status": "escapes", "axis": "production",
                                         "label": "Escapes: 2 consumers break"}}
    s = Scene("aisdlc-speckit", "Meridian Retail · rename on OrderPlaced · spec-kit", ["GitHub spec-kit"],
              [person("maintainer", "tech_lead", "Ada · Maintainer"),
               person("developer", "engineer", "Rui · Developer"),
               agent("agent", "code_agent", "AI agent · orders-service (/speckit commands)"), *SYSTEMS],
              ill, "maintainer")
    b = s.beat
    s.create("maintainer", "art-const", "context_file", "memory/constitution.md",
             "Article IV (project): published events stay backward compatible · Article IX: Integration-First "
             "Testing, contracts and contract tests first",
             b("constitution", "intent", "spec-driven.md · constitution: Articles IV-VI are defined by each project",
               rule=True),
             say="/speckit.constitution: the project's articles. The rule is Article IV, written by the project.")
    s.message("developer", "agent", f"/speckit.specify {FEATURE}", "task_assignment",
              b("specify", "intent", "spec-driven.md · /speckit.specify"))
    s.to_phase("planning", "developer", "specify", b("specify", "spec", "spec-driven.md · /speckit.specify"))
    s.create("agent", "art-spec", "spec", "specs/012-orderplaced-rename/spec.md", "What and why: rename the two fields",
             b("specify", "spec", "spec-driven.md · /speckit.specify generates specs/<branch>/spec.md"),
             say="/speckit.specify writes spec.md on its own branch.")
    s.review("developer", "art-spec", "approved", "Spec reviewed",
             b("specify", "spec", "spec-driven.md · team-reviewed specifications, created in branches, merged"))
    s.read("agent", "art-const", "memory/constitution.md", "plan gates", b("plan", "plan", "spec-driven.md · plan"))
    s.create("agent", "art-plan", "plan", "plan.md", "Phase -1 gates: Integration-First ✓ contracts defined ✓ "
             "contract tests written ✓ · contracts/orderplaced.json updated to the new names",
             b("plan", "plan", "spec-driven.md · Phase -1: Pre-Implementation Gates (Integration-First Gate)"),
             say="/speckit.plan: plan.md, data-model.md, contracts/. The Phase -1 gates are a checklist the agent fills.")
    s.create("agent", "art-tasks", "task_list", "tasks.md", "Contract tests first, then the publisher",
             b("tasks", "tasks", "spec-driven.md · /speckit.tasks writes tasks.md"), say="/speckit.tasks: tasks.md.")
    s.review("developer", "art-tasks", "approved", "Tests validated (Red)",
             b("tasks", "tasks", "spec-driven.md · Article III: tests validated and approved by the user"))
    s.to_phase("implementation", "developer", "implement", b("implement", "code", "spec-driven.md · implement"))
    s.tool("agent", "Edit", "src/core/events.ts", "OrderPlaced: totalCents → amountCents, placedAt → createdAt",
           "success", b("implement", "code", "README · /speckit-implement"), say=MISS)
    s.tool("agent", "Bash", "npm test", "contract tests (orders-service's own contracts/): all passed", "success",
           b("implement", "code", "spec-driven.md · contract tests mandatory before implementation"),
           say="Contract tests pass: they test this service's own contracts, now with the new names.")
    s.to_phase("review", "agent", "branch ready", b("implement", "review", "spec-driven.md · branches, merged"))
    s.create("agent", "art-pr", "pull_request", "PR #31", "012-orderplaced-rename",
             b("implement", "review", "spec-driven.md · created in branches, and merged"),
             say="The branch goes up for review. spec-kit's docs do not describe CI or pull requests.")
    s.review("developer", "art-pr", "approved", "Merged",
             b("implement", "review", "spec-driven.md · team-reviewed, merged", blocks=True))
    s.to_phase("deployment", "developer", "merged", b("(not described)", "release", "spec-driven.md: no CI step"))
    s.to_phase("maintenance", "developer", "running", b("(not described)", "production", "spec-driven.md"))
    s.consumers(True, b("(not described)", "production", "(illustration) the other teams' own tests"),
                say="Billing and analytics break: their contracts live in their own repos.")
    s.end("failed", "The break escaped: the constitution was read; nothing after generation checked the consumers",
          "Escaped: the rule lived in the constitution, as context and a plan checklist.")
    return s


def gate() -> Scene:
    ill = {"id": "gate", "model": "Any of the above + the gate", "short": "+ the gate",
           "source": "This talk's proposal (Agents vs. Gates), 13 Oct 2026", "date": "2026-10-13", "url": None,
           "stages": ["intent", "spec", "plan", "code", "PR", "CI", "release"],
           "rule": {"axis": "spec", "place": "architecture-library",
                    "label": "The spec AND a required CI check (ARCH-4)"},
           "blocks": {"axis": "ci", "place": "ci-tower",
                      "label": "Required check ARCH-4 (consumer contracts)"},
           "ci_arch": True, "outcome": {"status": "caught", "axis": "ci",
                                        "label": "Caught in CI (ARCH-4), repaired"}}
    s = Scene("aisdlc-gate", "Meridian Retail · rename on OrderPlaced · + the gate", ["Any of the above + the gate"],
              [person("product-owner", "product_owner", "Amara · Product Owner"),
               person("architect", "architect", "Maya · Architect"),
               person("engineer", "engineer", "Yusuf · Engineer"),
               agent("code-agent", "code_agent", "Code Agent · orders-service"),
               person("code-owner", "code_owner", "Greta · Code Owner"),
               person("release-manager", "release_manager", "Ravi · Release Manager"), *SYSTEMS],
              ill, "product-owner")
    b = s.beat
    s.create("product-owner", "art-intent", "intent", "intent.md", FEATURE,
             b("intent", "intent", "any model: the intent artifact"),
             say="Same flow as any of the models: intent, spec, plan. The difference comes after generation.")
    s.to_phase("planning", "product-owner", "intent accepted", b("spec", "spec", "any model"))
    s.create("architect", "art-spec", "spec", "spec.md",
             "ARCH-4: published events stay backward compatible (consumer contracts in the central catalog)",
             b("spec", "spec", "this experiment: S2, the rule in the spec", rule=True),
             say="The rule lives in the spec: ARCH-4, published events stay backward compatible.")
    s.review("product-owner", "art-spec", "approved", "Spec accepted", b("spec", "spec", "any model"))
    s.create("code-agent", "art-plan", "plan", "plan.md", "Rename on OrderPlaced; tests", b("plan", "plan", "any model"))
    s.review("engineer", "art-plan", "approved", "Plan accepted", b("plan", "plan", "any model"))
    s.to_phase("implementation", "engineer", "plan accepted", b("code", "code", "any model"))
    s.tool("code-agent", "Edit", "src/core/events.ts", "OrderPlaced: totalCents → amountCents, placedAt → createdAt",
           "success", b("code", "code", "same scripted case"), say=MISS)
    s.tool("code-agent", "Bash", "npm test", "all tests passed", "success", b("code", "code", "any model"),
           say="Its own tests pass.")
    s.to_phase("review", "code-agent", "PR opened", b("PR", "review", "any model"))
    s.create("code-agent", "art-pr", "pull_request", "PR #412", "3 files changed", b("PR", "review", "any model"))
    s.ci("art-pr", [("lint", "build", "pass", "lint: zero warnings", None),
                    ("tests", "test", "pass", "tests: all green", None),
                    ("ARCH-4", "contract", "fail", CI_ARCH4_FAIL, "ARCH-4")],
         b("CI", "ci", "this experiment: required CI check ARCH-4 against the consumer contracts", blocks=True),
         say="CI blocks the pull request: ARCH-4 fails. Billing needs totalCents; analytics needs placedAt.")
    s.message("ci", "code-agent", f"CI failed on your change. Output: {CI_ARCH4_FAIL}", "feedback_request",
              b("CI", "ci", "this experiment: the CI output goes back to the agent"),
              say="The red build goes back to the agent, with the exact fields the other teams need.")
    s.update("code-agent", "art-pr", "PR #412", "keeps totalCents and placedAt as @deprecated aliases",
             b("CI", "review", "this experiment: X-rename V0·S0, fixed_code"),
             say="The agent keeps the old names as @deprecated aliases and pushes again.",
             diff={"files_changed": 2, "lines_added": 8, "lines_removed": 0})
    s.ci("art-pr", [("lint", "build", "pass", "lint: zero warnings", None),
                    ("tests", "test", "pass", "tests: all green", None),
                    ("ARCH-4", "contract", "pass", CI_ARCH4_PASS, "ARCH-4")],
         b("CI", "ci", "this experiment"), say="CI passes: ARCH-4 green for all three consumers.")
    s.review("code-owner", "art-pr", "approved", "Approved", b("PR", "review", "any model: a human approves"))
    s.to_phase("deployment", "code-owner", "merged", b("release", "release", "any model"))
    s.ask("code-agent", "release-manager", "rel-1", "production-release", "Release PR #412?", "art-pr",
          b("release", "release", "any model"))
    s.decide("release-manager", "rel-1", "approved", "Release authorized", b("release", "release", "any model"))
    s.to_phase("maintenance", "release-manager", "released", b("release", "production", "any model"))
    s.consumers(False, b("release", "production", "(illustration) the other teams' own tests"),
                say="The other teams keep working.")
    s.end("success", "Caught in CI by a deterministic check of the consumers' contracts; repaired before merge",
          "Caught by a required check that reads the consumers' contracts. The agent repaired it before merge.")
    return s


SCENES = [anthropic, aws, kiro, speckit, gate]


def lanes(scenes: list[tuple[Scene, dict]]) -> dict:
    """Index for the theater picker and the compare lanes: per scene, per axis column, the model's stage names, the
    artifacts and who acted; plus where the rule lives, what blocks the merge and the outcome."""
    out = []
    for sc, rep in scenes:
        ill = rep["scene"]["illustration"]
        names = {a["id"]: a["display_name"] for a in rep["actors"]}
        cols = {k: {"stages": [], "artifacts": [], "checks": [], "who": [], "t_ms": None} for k in AXIS}
        for st in rep["steps"]:
            d = st.get("detail") or {}
            ax = d.get("axis")
            if ax not in cols or st["action"] == "move":
                continue
            c = cols[ax]
            if c["t_ms"] is None:
                c["t_ms"] = st["t_ms"]
            if d.get("stage") and d["stage"] not in c["stages"]:
                c["stages"].append(d["stage"])
            who = names.get(st["actor"], st["actor"])
            if st["actor"] not in ("ci", "staging") and who not in c["who"]:
                c["who"].append(who)
            path = None
            if d.get("event_type") in ("ARTIFACT_CREATED", "ARTIFACT_UPDATED") and st.get("text"):
                path = st["text"].split(" · ")[0]
            if d.get("event_type") == "CHECK_COMPLETED" and st.get("check") and st["check"]["id"] not in c["checks"]:
                c["checks"].append(st["check"]["id"])
            if path and path not in c["artifacts"]:
                c["artifacts"].append(path)
        out.append({"id": sc.sid, "url": f"scenes/{sc.sid}.json", "title": ill["model"], "short": ill["short"],
                    "source": ill["source"], "date": ill["date"], "stages": ill["stages"], "rule": ill["rule"],
                    "blocks": ill["blocks"], "ci_arch": ill["ci_arch"], "outcome": ill["outcome"],
                    "duration_ms": rep["meta"]["duration_ms"], "columns": cols})
    return {"label": "Illustration · scripted from public documentation", "axis": AXIS, "axis_label": AXIS_LABEL,
            "feature": FEATURE, "premise": MISS, "scenes": out}


def sources_md(scenes: list[Scene]) -> str:
    lines = ["# AI-SDLC scenes · beat → source",
             "",
             "Generated by `python -m replay.scenes.make_scenes`; do not edit by hand. Every scene is an "
             "**illustration scripted from public documentation**, never a measured run. Stage = the model's own "
             "stage name; axis = the common phase axis of the compare lanes; source = the section of the source the "
             "beat stages (summarized in `docs/AI-SDLC-SOURCES.md`; spec-kit "
             "from its public README and `spec-driven.md`).", ""]
    for sc in scenes:
        ill = sc.events[0]["metadata"]["illustration"]
        lines += [f"## {ill['model']}", "", f"Source: {ill['source']}" + (f" · {ill['url']}" if ill.get("url") else ""),
                  f"Where the rule lives: {ill['rule']['label']} · What blocks the merge: {ill['blocks']['label']} · "
                  f"Outcome: {ill['outcome']['label']}", "",
                  "| # | Stage | Axis | Beat | Source |", "|---|---|---|---|---|"]
        n = 0
        for e in sc.events:
            md = e.get("metadata") or {}
            if "cite" not in md:
                continue
            n += 1
            p = e["payload"]
            what = (p.get("path") or p.get("summary") or p.get("content") or p.get("input_summary")
                    or p.get("reason") or p.get("question") or p.get("decision") or p.get("check_id") or "")
            if e["event_type"] == "ORACLE_RESULT":
                what = f"{p['consumer']}: {'pass' if p['ok'] else 'fail'}"
            beat = f"{e['actor']['actor_id']} · {e['event_type'].lower()} · {str(what)[:70]}"
            lines.append(f"| {n} | {md['stage']} | {md['axis']} | {beat.replace('|', '/')} | "
                         f"{md['cite'].replace('|', '/')} |")
        lines.append("")
    return "\n".join(lines)


def build() -> list[tuple[Scene, dict]]:
    out = []
    for make in SCENES:
        sc = make()
        out.append((sc, build_replay(sc.events)))
    return out


def check(built: list[tuple[Scene, dict]]) -> list[str]:
    import jsonschema
    from trace import validate as tv
    problems = []
    schema = json.loads((REPO / "docs" / "contracts" / "replay.schema.json").read_text(encoding="utf-8"))
    for sc, rep in built:
        tmp = TRACES / f".{sc.sid}.check.jsonl"
        TRACES.mkdir(parents=True, exist_ok=True)
        tmp.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in sc.events), encoding="utf-8",
                       newline="\n")
        try:
            for v in tv.validate_file(tmp):
                problems.append(f"{sc.sid}: seq {v.get('seq')} rule {v.get('rule')}: {v.get('message')}")
        finally:
            tmp.unlink(missing_ok=True)
        try:
            jsonschema.validate(rep, schema)
        except jsonschema.ValidationError as exc:
            problems.append(f"{sc.sid}: replay schema: {exc.message}")
        if rep["meta"]["source"] != "illustration":
            problems.append(f"{sc.sid}: not labelled illustration")
    return problems


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m replay.scenes.make_scenes", description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="validate only, write nothing")
    args = ap.parse_args(argv)
    built = build()
    problems = check(built)
    for p in problems:
        print(p, file=sys.stderr)
    for sc, rep in built:
        print(f"{sc.sid}: {len(sc.events)} events, {len(rep['steps'])} steps, {rep['meta']['duration_ms'] / 1000:.1f} s")
    if problems:
        return 1
    if args.check:
        return 0
    TRACES.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    for sc, rep in built:
        (TRACES / f"{sc.sid}.jsonl").write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in sc.events),
                                                encoding="utf-8", newline="\n")
        (PUBLIC / f"{sc.sid}.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1) + "\n",
                                               encoding="utf-8", newline="\n")
    (PUBLIC / "index.json").write_text(json.dumps(lanes(built), ensure_ascii=False, indent=1) + "\n",
                                       encoding="utf-8", newline="\n")
    (HERE / "SOURCES.md").write_text(sources_md([sc for sc, _ in built]), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
