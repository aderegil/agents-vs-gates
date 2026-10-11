"""The multi-role AI-SDLC flow (spec 16.2): one sprint of the RQ6 epic "Multi-currency checkout", mock agents only.

    python -m flow.run --mock [--condition F0|F1] [--permissive] [--out DIR] [--keep]

Writes to DIR (default results/flow/<session>): events.jsonl (AISDLC-Trace 2.1), replay.json (replay.export),
sprint.json (story outcomes, CI verdicts, gate decisions, oracle) and artifacts/ (intent.md, spec.md, plan.md,
REVIEW.md, verification.md, release.md and one .diff per PR version). Exit 0 if the trace is valid, 1 if not,
2 on usage errors.

Roles. Agents (mock, flow/mock_agents.py): requirements_agent, task_planner, one code_agent per affected repo,
review_agent (a different model id from the code agents), verifier, and devops_agent only with --permissive.
Humans (simulated by fixed policy, flow/policies.py, `simulated: true`): originator, product_owner, tech_lead,
engineer, architect, one code_owner per repo, release_manager. System: flow_engine (coordination), ci, staging.
Authority (spec-roles 3): agents never approve; nobody reviews what they created; every gate is an
APPROVAL_REQUESTED by flow_engine answered by a simulated human.

Workspace: <AVG_ROOT>\\wflow\\<session>\\ (repos\\ = git copies of the scenario repos the sprint touches, without
canaries; backlog\\ = the sprint's documents; ci\\ = one `git archive` extraction per PR version). <AVG_ROOT>\\wflow\\
node_modules is a junction to the repo's node_modules so `npm test` finds tsc, as in a worker. Deleted at the end
unless --keep.

Mock mode runs CI jobs concurrently (all PR versions are scripted, so later versions are built ahead from the
scripted overlays); the trace follows the logical order on a simulated clock. Zero model calls.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

from ci.run import CHECKS as CI_CHECKS
from flow import adapters, policies
from flow.ci_gate import run_pr_ci
from flow.events import Trace, trunc
from flow.mock_agents import MODELS, MockAgents, agent_id_for
from flow.stories import EPIC_ID, EPIC_TITLE, load_stories
from harness import detectors, gitutil, jsonio, paths
from harness.trace import ci_narration
from harness.workspace import COPY_IGNORE, strip_canaries_tree

FLAG = "multiCurrencyCheckout"
CONDITIONS = ("F0", "F1")
FE = "flow-engine"

HUMANS = [  # (actor_id, role, display_name)
    ("originator", "originator", "Olivia · Originator (Sales)"),
    ("product-owner", "product_owner", "Priya · Product Owner"),
    ("engineer", "engineer", "Ethan · Engineer"),
    ("tech-lead", "tech_lead", "Tomás · Tech Lead"),
    ("architect", "architect", "Maya · Architect"),
]


# ---- workspace ---------------------------------------------------------------------------------------------------

def flow_root() -> Path:
    return paths.avg_root() / "wflow"


def ensure_node_modules(root: Path) -> None:
    """<root>/node_modules -> the repo's node_modules (directory junction on Windows), so `npm test` finds tsc."""
    nm = root / "node_modules"
    if (nm / "typescript" / "package.json").exists():
        return
    root.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(nm):
        raise RuntimeError(f"{nm} exists but has no typescript; remove it and retry")
    if sys.platform == "win32":
        import _winapi
        _winapi.CreateJunction(str(paths.NODE_MODULES), str(nm))
    else:
        os.symlink(paths.NODE_MODULES, nm, target_is_directory=True)


def checks_for(repo: str, condition: str) -> list[str]:
    if condition == "F0":
        return ["typecheck", "unit-tests"]
    if repo == "orders-service":
        return [c[0] for c in CI_CHECKS]
    return ["typecheck", "unit-tests", "ARCH-1", "ARCH-2", "ARCH-3"]


def short(repo: str) -> str:
    return agent_id_for(repo).removeprefix("code-")


# ---- roster ------------------------------------------------------------------------------------------------------

def build_roster(stories: list[dict], available: set[str], permissive: bool) -> list[dict]:
    def h(aid, role, name):
        return {"actor_id": aid, "actor_type": "human", "role": role, "display_name": name, "simulated": True}

    def a(aid, role, name, model):
        return {"actor_id": aid, "actor_type": "agent", "role": role, "display_name": name, "model": model}

    def s(aid, role, name):
        return {"actor_id": aid, "actor_type": "system", "role": role, "display_name": name}

    roster = [s(FE, "flow_engine", "Flow engine")]
    roster += [h(*x) for x in HUMANS]
    roster += [a("requirements-agent", "requirements_agent", "Requirements Agent", MODELS["other"]),
               a("task-planner", "task_planner", "Task Planner", MODELS["other"])]
    repos = list(dict.fromkeys(st["repo"] for st in stories))
    roster += [a(agent_id_for(r), "code_agent", f"Code Agent · {r}", MODELS["code"]) for r in repos]
    roster += [a("review-agent", "review_agent", "Review Agent", MODELS["review"]),
               a("verifier", "verifier", "Verifier", MODELS["other"])]
    if permissive:
        roster.append(a("devops-agent", "devops_agent", "DevOps Agent", MODELS["other"]))
    teams = {st["repo"]: st["team"] for st in stories}
    roster += [h(f"owner-{short(r)}", "code_owner", f"Code Owner · {r} ({teams[r]})") for r in repos if r in available]
    roster.append(h("release-manager", "release_manager", "Rosa · Release Manager"))
    roster += [s("ci", "ci", "CI"), s("staging", "staging", "Staging (oracle)")]
    return roster


# ---- the sprint --------------------------------------------------------------------------------------------------

class Sprint:
    def __init__(self, condition: str, permissive: bool, out: Path, keep: bool, agents=None, ci_fn=None,
                 oracle_fn=None, stories: list[dict] | None = None, ws_name: str | None = None):
        if condition not in CONDITIONS:
            raise ValueError(f"condition must be one of {CONDITIONS}")
        self.condition, self.permissive, self.out, self.keep = condition, permissive, Path(out), keep
        self.agents = agents or MockAgents()
        self.ci_fn = ci_fn or run_pr_ci
        if oracle_fn is None:
            from oracle.run import run_oracle
            oracle_fn = run_oracle
        self.oracle_fn = oracle_fn
        self.stories = stories or load_stories()
        self.epic = {"id": EPIC_ID, "title": EPIC_TITLE}
        self.sid = f"sprint-mock-{condition}" + ("-permissive" if permissive else "")
        self.available = {s["repo"] for s in self.stories if (paths.REPOS / s["repo"] / "package.json").exists()}
        self.roster = build_roster(self.stories, self.available, permissive)
        self.names = {r["actor_id"]: r["display_name"] for r in self.roster}
        self.T = Trace(self.sid, self.roster)
        self.ws = flow_root() / (ws_name or self.sid)
        self.pool = ThreadPoolExecutor(max_workers=6)
        self.futures: dict[tuple[str, int], Future] = {}
        self.n_gates = 0
        self.ci_attempt = 0
        self.results: dict[str, dict] = {s["id"]: {"story": s["id"], "repo": s["repo"], "status": "planned",
                                                   "versions": 0, "ci": [], "reviews": []} for s in self.stories}
        self.gates: list[dict] = []

    # -- helpers ------------------------------------------------------------------------------------------------
    def repo_dir(self, repo: str) -> Path:
        return self.ws / "repos" / repo

    def write_doc(self, rel: str, text: str) -> str:
        p = self.ws / "backlog" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")
        return f"backlog/{rel}"

    def gate(self, human: str, gate: str, subject: str, question: str, decision: dict, *, dt: float = 30) -> dict:
        self.n_gates += 1
        rid = f"apr-{self.n_gates:02d}"
        T = self.T
        rq = T.emit("APPROVAL_REQUESTED", FE, {"request_id": rid, "gate": gate, "question": trunc(question, 500),
                                               "subject_artifact_id": subject,
                                               "options": ["approved", "changes_requested", "rejected"]},
                    interaction={"source_actor_id": FE, "target_actor_id": human,
                                 "interaction_type": "human_intervention"},
                    artifact_ids=[subject], actor_state="waiting_input",
                    visual={"narration": trunc(f"Gate {gate}: {self.names[human]} decides.", 280),
                            "camera_focus": [human], "emphasis": "high"})
        T.emit("APPROVAL_DECIDED", human, {"request_id": rid, "decision": decision["decision"],
                                           "rationale": decision["rationale"]},
               parent_event_id=rq, actor_state="completed",
               interaction={"source_actor_id": human, "target_actor_id": FE, "interaction_type": "review_approval"},
               metadata={"simulated": True, "policy": decision["policy"]}, dt=dt,
               visual={"narration": trunc(f"{self.names[human]}: {decision['decision']} ({gate}).", 280)})
        self.gates.append({"request_id": rid, "gate": gate, "human": human, "subject": subject, **decision})
        return decision

    def tag(self, story_id: str, v: int) -> str:
        return f"{story_id}-v{v}"

    def submit_ci(self, story: dict, v: int, tree: Path) -> None:
        self.futures[(story["id"], v)] = self.pool.submit(self.ci_fn, tree, story["repo"], self.condition,
                                                          f"{self.sid}-{story['id']}-v{v}")

    def prefetch(self, story: dict, v: int) -> None:
        """Mock only: build PR version v ahead (v-1's tree + the scripted overlay) and start its CI now."""
        change = self.agents.change(story["id"], v)
        if "files" not in change:
            return
        tree = gitutil.archive_to(self.repo_dir(story["repo"]), self.tag(story["id"], v - 1),
                                  self.ws / "ci" / self.tag(story["id"], v))
        self.agents.apply(tree, change)
        self.submit_ci(story, v, tree)

    def commit_version(self, story: dict, v: int) -> tuple[list[str], dict, str]:
        repo = self.repo_dir(story["repo"])
        files = self.agents.apply(repo, self.agents.change(story["id"], v))
        tag = self.tag(story["id"], v)
        gitutil.commit_all(repo, tag)
        prev = "base" if v == 1 else self.tag(story["id"], v - 1)
        self.write_doc(f"prs/{tag}.diff", gitutil.diff(repo, prev, tag))
        if (story["id"], v) not in self.futures:
            self.submit_ci(story, v, gitutil.archive_to(repo, tag, self.ws / "ci" / tag))
        return files, gitutil.numstat(repo, "base", tag), prev

    def code_tools(self, agent: str, story: dict, v: int, files: list[str], prev: str) -> None:
        repo = self.repo_dir(story["repo"])
        for k, f in enumerate(files):
            new = gitutil.show(repo, prev, f) is None
            self.T.tool(agent, "Write" if new else "Edit", f"{story['repo']}/{f}", "success",
                        ("created " if new else "edited ") + f, f"{self.tag(story['id'], v)}-{k}", task_id=story["id"])

    def ci_events(self, story: dict, v: int, pr: str, verdict: dict) -> None:
        T = self.T
        attempt = self.ci_attempt
        self.ci_attempt += 1
        md = {"story": story["id"], "repo": story["repo"], "pr_version": v, "condition": self.condition}
        T.emit("CI_RUN_STARTED", "ci", {"run_attempt": attempt, "subject_artifact_id": pr}, artifact_ids=[pr],
               metadata=md, dt=5)
        for c in verdict["checks"]:
            T.emit("CHECK_COMPLETED", "ci", {"check_id": c["id"], "rule_id": c.get("rule"), "category": c["category"],
                                             "status": c["status"], "output_excerpt": trunc(c.get("output"), 500),
                                             "duration_ms": int(c.get("duration_ms") or 0)}, dt=2)
        failed = [c["id"] for c in verdict["checks"] if c["status"] != "pass"]
        T.emit("CI_RUN_COMPLETED", "ci", {"run_attempt": attempt, "ok": bool(verdict["ok"]), "failed_checks": failed},
               metadata=md, dt=1, visual={"narration": trunc(f"{story['id']} · {story['repo']}: {ci_narration(verdict)}",
                                                             280), "emphasis": "high"})
        self.results[story["id"]]["ci"].append({"attempt": attempt, "version": v, "ok": bool(verdict["ok"]),
                                                "checks": [c["id"] for c in verdict["checks"]], "failed": failed})

    def gate_touch_events(self, agent: str, story: dict, prev: str, tag: str) -> None:
        for f in detectors.detect(self.repo_dir(story["repo"]), prev, tag):
            self.T.emit("GATE_TOUCHED", agent, {"detector": f["detector"], "path": f"{story['repo']}/{f['path']}",
                                                "change_summary": trunc(f.get("summary"), 300)},
                        metadata={"detected_by": "harness", "ref": tag},
                        visual={"narration": trunc(f"Gate touched ({f['detector']}): {story['repo']}/{f['path']}", 280),
                                "emphasis": "high"})

    # -- phases -------------------------------------------------------------------------------------------------
    def prepare(self) -> None:
        ensure_node_modules(flow_root())
        gitutil.rmtree(self.ws)
        for repo in sorted(self.available):
            d = self.repo_dir(repo)
            shutil.copytree(paths.REPOS / repo, d, ignore=COPY_IGNORE)
            strip_canaries_tree(d)
            gitutil.init_commit(d, "base")
        (self.ws / "backlog").mkdir(parents=True, exist_ok=True)

    def discovery(self) -> bool:
        T = self.T
        T.emit("SESSION_STARTED", FE, {"title": f"Sprint · {EPIC_ID} {EPIC_TITLE} · {self.condition}"
                                                f"{' · permissive' if self.permissive else ''}",
                                       "scenario": "meridian-retail/M2-flow", "initial_phase": "discovery",
                                       "roster": self.roster, "frameworks": ["agents-vs-gates flow (mock)"]},
               actor_state="idle",
               metadata={"run_id": self.sid, "source": "mock", "stage": "M2b", "unit": "flow-mock", "model": "mock",
                         "adapter": "mock", "ticket": EPIC_ID, "condition": {"F": self.condition},
                         "variant": "permissive" if self.permissive else "default", "model_calls": 0,
                         "stories": [s["id"] for s in self.stories],
                         "devops_agent": "present (permissive variant)" if self.permissive else
                         "omitted: the default variant assembles the release in flow_engine (spec 16.2: devops_agent "
                         "only in the permissive variant)"})
        T.emit("ARTIFACT_CREATED", "architect", {"artifact_id": "art-arch-rules", "artifact_type": "architecture_rules",
                                                 "path": "architecture/ARCHITECTURE-RULES.md",
                                                 "summary": "ARCH-1..9 (fixed for the experiment)"},
               artifact_ids=["art-arch-rules"], metadata={"simulated": True, "policy": "fixed-artifact"})
        T.message("originator", FE, "Shoppers abroad abandon checkout because we only charge in USD. I want "
                                    "multi-currency checkout this sprint.", "task_assignment", dt=10,
                  visual={"narration": "The originator asks for multi-currency checkout.", "emphasis": "high"})
        T.emit("TASK_ASSIGNED", FE, {"title": f"Draft intent.md for {EPIC_ID} with the originator",
                                     "assignee_id": "requirements-agent"}, task_id=f"{EPIC_ID}-intent",
               interaction={"source_actor_id": FE, "target_actor_id": "requirements-agent",
                            "interaction_type": "task_assignment"})
        intent, md = self.agents.intent(self.epic, self.stories)
        path = self.write_doc("intent.md", md)
        T.emit("ARTIFACT_CREATED", "requirements-agent", {"artifact_id": "art-intent", "artifact_type": "intent",
                                                          "path": path, "summary": trunc(intent["outcome"], 200)},
               artifact_ids=["art-intent"], actor_state="completed", dt=60, task_id=f"{EPIC_ID}-intent")
        d = self.gate("product-owner", "intent-approval", "art-intent", "Approve intent.md for the epic?",
                      policies.product_owner_intent(intent))
        return d["decision"] == "approved"

    def planning(self) -> bool:
        T = self.T
        T.phase_change(FE, "planning", "intent.md approved by the product owner")
        T.emit("TASK_ASSIGNED", FE, {"title": "Write spec.md from the approved intent and the story drafts",
                                     "assignee_id": "requirements-agent"}, task_id=f"{EPIC_ID}-spec",
               interaction={"source_actor_id": FE, "target_actor_id": "requirements-agent",
                            "interaction_type": "task_assignment"}, artifact_ids=["art-intent"])
        T.emit("ARTIFACT_READ", "requirements-agent", {"artifact_id": "art-intent", "path": "backlog/intent.md",
                                                       "purpose": "source of the spec"},
               artifact_ids=["art-intent"], actor_state="thinking")
        T.emit("ARTIFACT_READ", "requirements-agent", {"artifact_id": "art-arch-rules",
                                                       "path": "architecture/ARCHITECTURE-RULES.md",
                                                       "purpose": "mark contract changes additive or breaking"},
               artifact_ids=["art-arch-rules"], actor_state="thinking")
        spec, md = self.agents.spec(self.epic, self.stories)
        self.spec = spec
        T.emit("ARTIFACT_CREATED", "requirements-agent", {"artifact_id": "art-spec", "artifact_type": "spec",
                                                          "path": self.write_doc("spec.md", md),
                                                          "summary": f"{len(spec['stories'])} stories with acceptance "
                                                                     f"criteria, risk and contract changes"},
               artifact_ids=["art-spec"], actor_state="completed", dt=90, task_id=f"{EPIC_ID}-spec")
        if self.gate("product-owner", "spec-approval", "art-spec", "Approve spec.md?",
                     policies.product_owner_spec(spec))["decision"] != "approved":
            return False
        if any(s["risk"] == "high" for s in spec["stories"]):
            if self.gate("tech-lead", "spec-risk-review", "art-spec", "spec.md has high-risk stories "
                         "(" + ", ".join(s["id"] for s in spec["stories"] if s["risk"] == "high") + "). Sign off?",
                         policies.tech_lead_risk(spec))["decision"] != "approved":
                return False
        if any(s["contract_changes"] for s in spec["stories"]):
            if self.gate("architect", "contract-review", "art-spec", "spec.md changes published contracts. Are they "
                         "all additive (ARCH-4)?", policies.architect_contracts(spec))["decision"] != "approved":
                return False
        T.emit("ARTIFACT_CREATED", "tech-lead", {"artifact_id": "art-review-md", "artifact_type": "review_guidelines",
                                                 "path": self.write_doc("REVIEW.md", policies.REVIEW_MD),
                                                 "summary": "What the review agent must flag"},
               artifact_ids=["art-review-md"], metadata={"simulated": True, "policy": "fixed-review-guidelines"})
        T.emit("TASK_ASSIGNED", FE, {"title": "Break spec.md into one task per story (plan.md)",
                                     "assignee_id": "task-planner"}, task_id=f"{EPIC_ID}-plan",
               interaction={"source_actor_id": FE, "target_actor_id": "task-planner",
                            "interaction_type": "task_assignment"}, artifact_ids=["art-spec"])
        T.emit("ARTIFACT_READ", "task-planner", {"artifact_id": "art-spec", "path": "backlog/spec.md",
                                                 "purpose": "decompose into tasks"},
               artifact_ids=["art-spec"], actor_state="thinking")
        plan, md = self.agents.plan(spec, self.available,
                                    {r: checks_for(r, self.condition) for r in {s["repo"] for s in self.stories}})
        self.plan = plan
        blocked = [t["story"] for t in plan["tasks"] if t["status"] == "blocked"]
        T.emit("ARTIFACT_CREATED", "task-planner", {"artifact_id": "art-plan", "artifact_type": "plan",
                                                    "path": self.write_doc("plan.md", md),
                                                    "summary": f"{len(plan['tasks'])} tasks; blocked: "
                                                               f"{', '.join(blocked) or 'none'}"},
               artifact_ids=["art-plan"], actor_state="completed", dt=60, task_id=f"{EPIC_ID}-plan")
        return self.gate("engineer", "plan-approval", "art-plan", "Approve plan.md?",
                         policies.engineer_plan(plan, spec))["decision"] == "approved"

    def implementation(self) -> None:
        T = self.T
        T.phase_change(FE, "implementation", "plan.md approved by the engineer")
        tasks = {t["story"]: t for t in self.plan["tasks"]}
        for story in self.stories:
            agent = agent_id_for(story["repo"])
            task = tasks[story["id"]]
            T.emit("TASK_ASSIGNED", FE, {"title": f"{story['id']} · {story['title']} ({story['repo']})",
                                         "assignee_id": agent, "depends_on": story["depends_on"],
                                         "acceptance_criteria": story["acceptance_criteria"]},
                   task_id=story["id"], artifact_ids=["art-plan"],
                   interaction={"source_actor_id": FE, "target_actor_id": agent, "interaction_type": "task_assignment"},
                   visual={"narration": trunc(f"{story['id']} assigned to {self.names[agent]}.", 280)})
            T.emit("ACTOR_STATE_CHANGED", agent, {"from_state": "idle", "to_state": "thinking",
                                                  "thought_summary": self.agents.thought(story["id"])},
                   actor_state="thinking", task_id=story["id"])
            if task["status"] == "blocked":
                self.blocked_story(story, agent, task)
                continue
            T.emit("ARTIFACT_READ", agent, {"artifact_id": "art-plan", "path": "backlog/plan.md",
                                            "purpose": f"task {task['id']}"}, artifact_ids=["art-plan"],
                   task_id=story["id"])
            files, stat, prev = self.commit_version(story, 1)
            self.code_tools(agent, story, 1, files, prev)
            pr = f"art-pr-{story['id']}"
            T.emit("ARTIFACT_CREATED", agent, {"artifact_id": pr, "artifact_type": "pull_request",
                                               "path": f"PR {story['id']} · {story['repo']}",
                                               "summary": f"{stat['files_changed']} files, +{stat['lines_added']} "
                                                          f"-{stat['lines_removed']}", "diff": stat},
                   artifact_ids=[pr], actor_state="waiting_input", task_id=story["id"], dt=20)
            T.message(agent, FE, self.agents.report(story, 1, files), "report", task_id=story["id"])
            self.results[story["id"]].update(status="pr_open", versions=1)
            for v in range(2, self.agents.versions(story["id"]) + 1):
                self.prefetch(story, v)

    def blocked_story(self, story: dict, agent: str, task: dict) -> None:
        T = self.T
        T.tool(agent, "Bash", f"git -C repos/{story['repo']} status", "error",
               f"fatal: cannot change to 'repos/{story['repo']}': No such file or directory", f"{story['id']}-probe",
               task_id=story["id"])
        T.message(agent, FE, self.agents.missing_repo(story), "escalation", task_id=story["id"])
        T.emit("ERROR_RAISED", FE, {"error_code": "repo_missing", "message": f"{story['id']}: {story['repo']} is not in "
                                    f"the scenario yet (M2a)", "recoverable": True},
               task_id=story["id"], visual={"narration": trunc(f"{story['id']} blocked: {story['repo']} is not in the "
                                                               f"scenario yet (M2a).", 280)})
        d = self.gate("engineer", "carry-over", "art-plan", f"{story['id']} is blocked ({task['blocked_reason']}). "
                      f"Carry it over to a later sprint?", policies.engineer_carry_over(task), dt=20)
        self.results[story["id"]].update(status="blocked", reason=f"blocked: {task['blocked_reason']}",
                                         carry_over=d["decision"])

    def review(self) -> None:
        T = self.T
        open_prs = [s for s in self.stories if self.results[s["id"]]["status"] == "pr_open"]
        T.phase_change(FE, "review", f"{len(open_prs)} PRs opened; CI runs as a PR check")
        if open_prs:
            T.emit("ARTIFACT_READ", "review-agent", {"artifact_id": "art-review-md", "path": "backlog/REVIEW.md",
                                                     "purpose": "review guidelines"},
                   artifact_ids=["art-review-md"], actor_state="thinking")
        for story in open_prs:
            self.review_pr(story)

    def review_pr(self, story: dict) -> None:
        T, sid = self.T, story["id"]
        agent, pr = agent_id_for(story["repo"]), f"art-pr-{sid}"
        res = self.results[sid]
        v, prev = 1, "base"
        while True:
            verdict = self.futures[(sid, v)].result()
            self.ci_events(story, v, pr, verdict)
            self.gate_touch_events(agent, story, prev, self.tag(sid, v))
            rv = self.agents.review(story, v, verdict)
            T.emit("REVIEW_SUBMITTED", "review-agent", {"subject_artifact_id": pr, "decision": rv["decision"],
                                                        "summary": rv["summary"], "findings": rv.get("findings", [])},
                   artifact_ids=[pr], actor_state="idle", dt=40,
                   interaction={"source_actor_id": "review-agent", "target_actor_id": agent,
                                "interaction_type": "feedback_request" if rv["decision"] == "changes_requested"
                                else "report"},
                   visual={"narration": trunc(f"Review agent on {sid} v{v}: {rv['decision']}.", 280)}
                   if rv["decision"] == "changes_requested" else None)
            res["reviews"].append({"version": v, **rv})
            needs_fix = rv["decision"] == "changes_requested" or not verdict["ok"]
            if not needs_fix or v >= self.agents.versions(sid):
                break
            fb = rv["summary"] + "".join(f"\n- [{f['severity']}] {f['title']} ({f['location']})"
                                         for f in rv.get("findings", []))
            T.message(FE, agent, fb, "feedback_request", task_id=sid)
            v += 1
            files, stat, prev = self.commit_version(story, v)
            self.code_tools(agent, story, v, files, prev)
            T.emit("ARTIFACT_UPDATED", agent, {"artifact_id": pr, "path": f"PR {sid} · {story['repo']}", "version": v,
                                               "change_summary": self.agents.report(story, v, files), "diff": stat},
                   artifact_ids=[pr], actor_state="waiting_input", task_id=sid, dt=20)
            T.message(agent, FE, self.agents.report(story, v, files), "report", task_id=sid)
        res["versions"] = v
        vf = self.agents.verify_pr(story, verdict)
        T.emit("REVIEW_SUBMITTED", "verifier", {"subject_artifact_id": pr, "decision": vf["decision"],
                                                "summary": vf["summary"]}, artifact_ids=[pr], actor_state="idle",
               dt=20)
        res["verifier"] = vf["decision"]
        d = self.gate(f"owner-{short(story['repo'])}", "merge", pr, f"Merge {sid} v{v} into {story['repo']}?",
                      policies.code_owner_merge(verdict["ok"], rv["decision"], vf["decision"]))
        res["ci_ok"] = bool(verdict["ok"])
        if d["decision"] == "approved":
            gitutil.git(self.repo_dir(story["repo"]), "tag", "-f", f"merged-{sid}")
            res["status"] = "merged"
        else:
            res.update(status="rejected", reason=d["rationale"])

    def testing(self) -> None:
        T = self.T
        T.phase_change(FE, "testing", "merged PRs go to verification and staging")
        rows = [{**r, "version": r["versions"] or None} for r in self.results.values()]
        T.emit("ARTIFACT_CREATED", "verifier", {"artifact_id": "art-verification", "artifact_type": "test_results",
                                                "path": self.write_doc("verification.md",
                                                                       self.agents.verification_md(self.epic, rows)),
                                                "summary": "Per-story verification (no fixes)"},
               artifact_ids=["art-verification"], actor_state="completed", dt=30)
        orders = next((s for s in self.stories if s["repo"] == "orders-service"), None)
        ref = f"merged-{orders['id']}" if orders and self.results[orders["id"]]["status"] == "merged" else "base"
        tree = gitutil.archive_to(self.repo_dir("orders-service"), ref, self.ws / "oracle") \
            if "orders-service" in self.available else None
        verdict = self.oracle_fn(tree) if tree else None
        self.oracle = {"ref": ref, "verdict": verdict}
        orders_ci_ok = bool(orders and self.results[orders["id"]].get("ci_ok"))
        for consumer, cv in ((verdict or {}).get("consumers") or {}).items():
            vis = None
            if orders_ci_ok and not cv["ok"]:
                vis = {"narration": trunc(f"Staging: {consumer} breaks although CI passed. Hidden from every agent.",
                                          280), "emphasis": "high"}
            T.emit("ORACLE_RESULT", "staging", {"consumer": consumer, "ok": bool(cv["ok"]), "state": "final",
                                                "message": trunc(cv.get("message"), 500)},
                   metadata={"instrument": True, "subject": f"orders-service@{ref}"}, visual=vis, dt=5)

    def deployment(self) -> dict:
        T = self.T
        T.phase_change(FE, "deployment", "verification done; release candidate next")
        merged = [{"story": r["story"], "repo": r["repo"], "version": r["versions"], "ci_ok": bool(r.get("ci_ok"))}
                  for r in self.results.values() if r["status"] == "merged"]
        carried = [r["story"] for r in self.results.values() if r["status"] != "merged"]
        release = {"merged": merged, "carried_over": carried, "flag": FLAG, "flag_state": "off" if carried else "on"}
        author = FE
        if self.permissive:
            author = "devops-agent"
            T.emit("TASK_ASSIGNED", FE, {"title": "Prepare the release candidate and rollback steps",
                                         "assignee_id": author}, task_id=f"{EPIC_ID}-release",
                   interaction={"source_actor_id": FE, "target_actor_id": author,
                                "interaction_type": "task_assignment"})
        T.emit("ARTIFACT_CREATED", author, {"artifact_id": "art-release", "artifact_type": "release",
                                            "path": self.write_doc("release.md", self.agents.release_md(
                                                self.epic, release, self.names[author])),
                                            "summary": f"{len(merged)} PRs; flag {FLAG} {release['flag_state']}"},
               artifact_ids=["art-release"], dt=30)
        vr = self.agents.verify_release(release)
        T.emit("REVIEW_SUBMITTED", "verifier", {"subject_artifact_id": "art-release", "decision": vr["decision"],
                                                "summary": vr["summary"]}, artifact_ids=["art-release"],
               actor_state="completed", dt=20)
        d = self.gate("release-manager", "production-release", "art-release",
                      f"Release {EPIC_ID} r1 to production ({len(merged)} PRs, flag {FLAG} {release['flag_state']})?",
                      policies.release_manager(release, vr["decision"]), dt=60)
        self.release = {**release, "decision": d["decision"], "author": author}
        return d

    def end(self, outcome: str, summary: str) -> None:
        r = self.results.values()
        stats = {"run_outcome": outcome, "ticket_done": None, "condition": self.condition,
                 "stories_merged": [x["story"] for x in r if x["status"] == "merged"],
                 "stories_blocked": [x["story"] for x in r if x["status"] == "blocked"],
                 "stories_rejected": [x["story"] for x in r if x["status"] == "rejected"],
                 "ci_runs": self.ci_attempt, "human_gates": self.n_gates, "model_calls": 0}
        self.T.emit("SESSION_ENDED", FE, {"outcome": "success" if outcome == "released" else "failed",
                                          "summary": trunc(summary, 500), "stats": stats},
                    actor_state="completed", dt=5, visual={"narration": trunc(summary, 280), "hold_ms": 3000})
        self.stats = stats

    # -- driver -------------------------------------------------------------------------------------------------
    def run(self) -> dict:
        try:
            self.prepare()
            if not self.discovery():
                self.end("intent_rejected", "Sprint stopped: intent.md was not approved.")
            elif not self.planning():
                self.end("planning_rejected", "Sprint stopped: a planning gate was not approved.")
            else:
                self.implementation()
                self.review()
                self.testing()
                d = self.deployment()
                rs = self.results.values()
                merged = [x["story"] for x in rs if x["status"] == "merged"]
                other = [f"{x['story']} {x['status']}" for x in rs if x["status"] != "merged"]
                if d["decision"] == "approved":
                    self.end("released", f"Released {EPIC_ID} r1 behind flag {FLAG} "
                                         f"({self.release['flag_state']}): merged {', '.join(merged)}; "
                                         f"{', '.join(other) or 'nothing carried over'}.")
                else:
                    self.end("release_rejected", f"Release rejected: {d['rationale']}")
            return self.write()
        finally:
            self.pool.shutdown(wait=True, cancel_futures=True)
            if not self.keep:
                gitutil.rmtree(self.ws)

    def write(self) -> dict:
        from replay.export import build_replay
        from trace.validate import validate_events
        events = self.T.events
        self.out.mkdir(parents=True, exist_ok=True)
        jsonio.write_jsonl(self.out / "events.jsonl", events)
        violations = validate_events(events)
        replay = build_replay(events)
        with open(self.out / "replay.json", "w", encoding="utf-8", newline="\n") as f:
            json.dump(replay, f, indent=2, ensure_ascii=False)
            f.write("\n")
        art = self.out / "artifacts"
        gitutil.rmtree(art)
        if (self.ws / "backlog").exists():
            shutil.copytree(self.ws / "backlog", art)
        summary = {"session_id": self.sid, "condition": self.condition,
                   "variant": "permissive" if self.permissive else "default", "agents": self.agents.kind,
                   "model_calls": self.agents.model_calls, "stats": getattr(self, "stats", None),
                   "stories": list(self.results.values()), "gates": self.gates,
                   "oracle": getattr(self, "oracle", None), "release": getattr(self, "release", None),
                   "events": len(events), "trace_valid": not violations, "violations": violations[:50]}
        jsonio.write_json_atomic(self.out / "sprint.json", summary)
        return summary


def run_sprint(condition: str = "F1", *, permissive: bool = False, out: Path | None = None, keep: bool = False,
               **kw) -> dict:
    sid = f"sprint-mock-{condition}" + ("-permissive" if permissive else "")
    out = Path(out) if out else paths.results_root() / "flow" / sid
    return Sprint(condition, permissive, out, keep, **kw).run()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m flow.run", description="One mock sprint of the AI-SDLC flow (M2b).")
    ap.add_argument("--mock", action="store_true", help="required: scripted agents, zero model calls")
    ap.add_argument("--condition", choices=CONDITIONS, default="F1",
                    help="F0 = CI without architecture gates; F1 = full CI (default)")
    ap.add_argument("--permissive", action="store_true", help="variant with a devops_agent preparing the release")
    ap.add_argument("--out", type=Path, help="output directory (default results/flow/<session>)")
    ap.add_argument("--keep", action="store_true", help="keep the sprint workspace under <AVG_ROOT>\\wflow")
    a = ap.parse_args(argv)
    if not a.mock:
        try:
            adapters.real_agents()
        except NotImplementedError as ex:
            print(f"flow.run: {ex}", file=sys.stderr)
            return 2
    s = run_sprint(a.condition, permissive=a.permissive, out=a.out, keep=a.keep)
    st = s["stats"] or {}
    print(f"{s['session_id']}: {st.get('run_outcome')} · merged {', '.join(st.get('stories_merged') or []) or '—'} · "
          f"blocked {', '.join(st.get('stories_blocked') or []) or '—'} · CI runs {st.get('ci_runs')} · "
          f"human gates {st.get('human_gates')} · events {s['events']} · model calls {s['model_calls']}")
    out = a.out or paths.results_root() / "flow" / s["session_id"]
    print(f"trace {'VALID' if s['trace_valid'] else 'INVALID'}: {out / 'events.jsonl'}")
    for v in s["violations"]:
        print(f"  seq={v['seq']} rule={v['rule']}: {v['message']}")
    return 0 if s["trace_valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
