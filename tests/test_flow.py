"""M2b flow (spec 16.2): the mock sprint runs, its trace is valid AISDLC-Trace 2.1, the authority rules hold, F0 and F1
differ in which gates run, and the replay export is valid. Zero model calls.

Default run (~1 min): one real F1 sprint (real CI and oracle through Node) plus an F0 sprint that reuses the F1 CI
verdicts filtered by `flow.ci_gate.filter_condition` (for every repo, F0's real CI is exactly F1's verdict without the
gate/contract checks), and fast sprints with a fake CI. AVG_SLOW=1 adds a real F0 sprint.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flow import adapters, policies
from flow import run as flow_run
from flow.ci_gate import filter_condition
from flow.mock_agents import MockAgents, XADD_PATCH, xadd_as_fx_patch
from flow.stories import load_stories
from harness import paths
from replay.export import build_replay, read_trace, trace_sha256
from trace.validate import validate_events

SLOW = unittest.skipUnless(os.environ.get("AVG_SLOW") == "1", "slow; set AVG_SLOW=1")
EXAMPLES = paths.REPO / "flow" / "examples"
REPLAY_SCHEMA = paths.CONTRACTS / "replay.schema.json"
FLOW_ROLES = {"flow_engine", "ci", "staging", "originator", "product_owner", "engineer", "tech_lead", "architect",
              "code_owner", "release_manager", "requirements_agent", "task_planner", "code_agent", "review_agent",
              "verifier"}


def replay_errors(replay: dict) -> list[str]:
    from jsonschema import Draft7Validator
    schema = json.loads(REPLAY_SCHEMA.read_text(encoding="utf-8"))
    return [e.message for e in Draft7Validator(schema).iter_errors(replay)]


def authority_violations(events: list[dict]) -> list[str]:
    """Independent check of spec-roles 3: agents never approve, nobody reviews/approves what they touched, every gate
    is requested by flow_engine and decided by a simulated human."""
    out, touched, requests = [], {}, {}
    roster = {r["actor_id"]: r for r in events[0]["payload"]["roster"]}
    for e in events:
        et, a, p = e["event_type"], e["actor"], e["payload"]
        if et in ("ARTIFACT_CREATED", "ARTIFACT_UPDATED"):
            touched.setdefault(p["artifact_id"], set()).add(a["actor_id"])
        elif et == "REVIEW_SUBMITTED":
            if a["actor_type"] != "human" and p["decision"] == "approved":
                out.append(f"{e['seq']}: {a['actor_id']} ({a['actor_type']}) approves")
            if a["actor_id"] in touched.get(p["subject_artifact_id"], set()):
                out.append(f"{e['seq']}: {a['actor_id']} reviews its own {p['subject_artifact_id']}")
        elif et == "APPROVAL_REQUESTED":
            if a["role"] != "flow_engine":
                out.append(f"{e['seq']}: gate requested by {a['actor_id']}")
            requests[p["request_id"]] = p.get("subject_artifact_id")
        elif et == "APPROVAL_DECIDED":
            if a["actor_type"] != "human" or not roster[a["actor_id"]].get("simulated"):
                out.append(f"{e['seq']}: gate decided by non-simulated-human {a['actor_id']}")
            if (e.get("metadata") or {}).get("simulated") is not True or not (e.get("metadata") or {}).get("policy"):
                out.append(f"{e['seq']}: decision without simulated policy metadata")
            if a["actor_id"] in touched.get(requests.get(p["request_id"]), set()):
                out.append(f"{e['seq']}: {a['actor_id']} approves an artifact it touched")
    return out


def gate_checks(events: list[dict]) -> set[str]:
    return {e["payload"]["check_id"] for e in events if e["event_type"] == "CHECK_COMPLETED"
            and e["payload"]["category"] in ("gate", "contract")}


def fake_ci(red: set[str] = frozenset()):
    """CI stand-in for fast tests: one green/red check per category kept by the condition."""
    def fn(tree, repo, condition, run_id):
        status = "fail" if any(run_id.endswith(r) for r in red) else "pass"
        checks = [{"id": "typecheck", "rule": None, "category": "build", "status": "pass", "duration_ms": 1,
                   "output": "typecheck PASS"},
                  {"id": "unit-tests", "rule": None, "category": "test", "status": status, "duration_ms": 1,
                   "output": f"unit-tests {status.upper()}\nℹ tests 3"},
                  {"id": "ARCH-1", "rule": "ARCH-1", "category": "gate", "status": "pass", "duration_ms": 1,
                   "output": "ARCH-1 PASS"}]
        return {**filter_condition({"checks": checks}, condition), "condition": condition, "repo": repo}
    return fn


def fake_oracle(tree):
    return {"ok": True, "consumers": {c: {"ok": True, "status": "pass", "message": "fake"}
                                      for c in ("billing-service", "analytics-ingest", "web-storefront")}}


class FastFlowTests(unittest.TestCase):
    def test_story_drafts(self):
        stories = load_stories()
        self.assertEqual([s["id"] for s in stories], [f"S-{i}" for i in range(1, 7)])
        self.assertEqual({s["repo"] for s in stories}, {"web-storefront", "orders-service", "payments-service",
                                                        "billing-service", "analytics-ingest", "inventory-service"})
        for s in stories:
            self.assertTrue(s["draft"], s["id"])
            self.assertTrue(s["acceptance_criteria"], s["id"])
            self.assertTrue(s["narrative"].startswith("As "), s["id"])

    def test_prompts_short(self):
        for role in ("requirements_agent", "task_planner", "code_agent", "review_agent", "verifier", "devops_agent",
                     "originator", "product_owner", "tech_lead", "engineer", "architect", "code_owner",
                     "release_manager"):
            p = paths.REPO / "flow" / "prompts" / f"{role}.md"
            self.assertTrue(p.is_file(), role)
            self.assertLessEqual(len(p.read_text(encoding="utf-8").splitlines()), 25, role)

    def test_orders_patch_is_the_additive_reference_renamed(self):
        patch = xadd_as_fx_patch()
        self.assertNotIn("couponCode", patch)
        self.assertNotIn("CANARY-", patch)
        self.assertIn("readonly fxQuoteId?: string;", patch)
        orig = [l for l in XADD_PATCH.read_text(encoding="utf-8").splitlines() if "CANARY-" not in l]
        self.assertEqual(len(orig), len(patch.splitlines()))
        self.assertFalse([l for l in patch.splitlines() if l.startswith("-") and not l.startswith("---")
                          and "fxQuoteId" in l])

    def test_policies(self):
        self.assertEqual(policies.code_owner_merge(True, "commented", "commented")["decision"], "approved")
        self.assertEqual(policies.code_owner_merge(False, "commented", "commented")["decision"], "rejected")
        self.assertEqual(policies.code_owner_merge(True, "changes_requested", "commented")["decision"], "rejected")
        spec = {"stories": [{"id": "S-1", "repo": "x", "acceptance_criteria": ["a"], "risk": "high",
                             "contract_changes": [{"contract": "E", "change": "rename f", "kind": "breaking"}]}],
                "money_in_minor_units": True}
        self.assertEqual(policies.product_owner_spec(spec)["decision"], "approved")
        self.assertEqual(policies.architect_contracts(spec)["decision"], "rejected")
        self.assertEqual(policies.tech_lead_risk(spec)["decision"], "changes_requested")
        rel = {"merged": [{"story": "S-1", "ci_ok": True}], "carried_over": ["S-3"], "flag": "f", "flag_state": "on"}
        self.assertEqual(policies.release_manager(rel, "commented")["decision"], "rejected")
        self.assertEqual(policies.release_manager({**rel, "flag_state": "off"}, "commented")["decision"], "approved")

    def test_real_adapter_hook_raises_without_calling_anything(self):
        with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("spawned")), \
                mock.patch.object(subprocess, "run", side_effect=AssertionError("spawned")):
            with self.assertRaises(NotImplementedError):
                adapters.RealRoleAdapter("code_agent", "cc-sonnet").run("task")
            with self.assertRaises(NotImplementedError):
                adapters.real_agents()
            with mock.patch("sys.stderr"):
                self.assertEqual(flow_run.main(["--condition", "F1"]), 2)
        self.assertEqual(MockAgents.model_calls, 0)

    def test_examples_are_valid(self):
        for cond in ("F0", "F1"):
            trace = EXAMPLES / f"sprint-mock-{cond}.jsonl"
            events = read_trace(trace)
            self.assertEqual(validate_events(events), [], cond)
            self.assertEqual(authority_violations(events), [], cond)
            replay = json.loads((EXAMPLES / f"sprint-mock-{cond}.replay.json").read_text(encoding="utf-8"))
            self.assertEqual(replay_errors(replay), [], cond)
            self.assertEqual(replay["meta"]["trace_sha256"], trace_sha256(events), cond)
            self.assertEqual(replay_errors(build_replay(events)), [], cond)
        f0, f1 = (read_trace(EXAMPLES / f"sprint-mock-{c}.jsonl") for c in ("F0", "F1"))
        self.assertEqual(gate_checks(f0), set())
        self.assertEqual(gate_checks(f1), {f"ARCH-{i}" for i in range(1, 9)})


class FakeCISprintTests(unittest.TestCase):
    """The engine with a fake CI and oracle (no Node): permissive variant with a red-CI path."""

    def run_sprint(self, **kw):
        out = Path(tempfile.mkdtemp(prefix="avg-flow-"))
        self.addCleanup(shutil.rmtree, out, True)
        cond = kw.pop("condition", "F1")
        s = flow_run.Sprint(cond, kw.pop("permissive", False), out, False, oracle_fn=fake_oracle,
                            ws_name=f"test-fake-{self._testMethodName}", **kw).run()
        return s, read_trace(out / "events.jsonl"), json.loads((out / "replay.json").read_text(encoding="utf-8"))

    def test_permissive_variant_and_red_ci(self):
        s, events, replay = self.run_sprint(permissive=True, ci_fn=fake_ci(red={"S-1-v1"}))
        self.assertTrue(s["trace_valid"], s["violations"])
        self.assertEqual(authority_violations(events), [])
        self.assertEqual(replay_errors(replay), [])
        rel = next(e for e in events if e["event_type"] == "ARTIFACT_CREATED"
                   and e["payload"]["artifact_type"] == "release")
        self.assertEqual(rel["actor"]["role"], "devops_agent")
        by = {r["story"]: r for r in s["stories"]}
        self.assertEqual(by["S-1"]["status"], "rejected")          # red CI: the code owner does not merge
        self.assertEqual(by["S-2"]["status"], "merged")
        self.assertIn("S-1", s["release"]["carried_over"])
        self.assertEqual(s["release"]["decision"], "approved")      # flag stays off for what is carried over


class RealSprintTests(unittest.TestCase):
    """One real F1 sprint (Node CI + oracle); F0 reuses its verdicts through the F0 filter."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="avg-flow-real-"))
        raw: dict[str, dict] = {}

        def recording_ci(tree, repo, condition, run_id):
            v = flow_run.run_pr_ci(tree, repo, condition, run_id)
            raw[run_id.rsplit("-S-", 1)[1]] = v
            return v

        def replaying_ci(tree, repo, condition, run_id):
            v = raw[run_id.rsplit("-S-", 1)[1]]
            return {**filter_condition(v, condition), "condition": condition, "repo": repo}

        cls.s1 = flow_run.Sprint("F1", False, cls.tmp / "F1", False, ci_fn=recording_ci,
                                 ws_name="test-real-F1").run()
        cls.s0 = flow_run.Sprint("F0", False, cls.tmp / "F0", False, ci_fn=replaying_ci,
                                 ws_name="test-real-F0").run()
        cls.e1 = read_trace(cls.tmp / "F1" / "events.jsonl")
        cls.e0 = read_trace(cls.tmp / "F0" / "events.jsonl")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_sprint_runs_and_releases(self):
        st = self.s1["stats"]
        self.assertEqual(st["run_outcome"], "released")
        self.assertEqual(st["stories_merged"], ["S-1", "S-2", "S-4", "S-5"])
        self.assertEqual(st["stories_blocked"], ["S-3", "S-6"])
        self.assertEqual(self.s1["model_calls"], 0)
        by = {r["story"]: r for r in self.s1["stories"]}
        self.assertIn("M2a", by["S-3"]["reason"])
        self.assertEqual(by["S-4"]["versions"], 2)       # review asked for a JPY test; v2 added it
        self.assertTrue(all(c["ok"] for r in self.s1["stories"] for c in r["ci"]))
        self.assertTrue(self.s1["oracle"]["verdict"]["ok"])
        art = self.tmp / "F1" / "artifacts"
        for f in ("intent.md", "spec.md", "plan.md", "REVIEW.md", "verification.md", "release.md", "prs/S-2-v1.diff"):
            self.assertTrue((art / f).is_file(), f)

    def test_trace_is_valid(self):
        self.assertEqual(validate_events(self.e1), [])
        self.assertEqual(validate_events(self.e0), [])
        self.assertTrue(self.s1["trace_valid"] and self.s0["trace_valid"])

    def test_all_roles_appear(self):
        emitting = {e["actor"]["role"] for e in self.e1}
        self.assertEqual(FLOW_ROLES - emitting, set())
        roster = self.e1[0]["payload"]["roster"]
        code = [r for r in roster if r["role"] == "code_agent"]
        self.assertEqual(len(code), 6)
        self.assertTrue(all(r.get("simulated") is True for r in roster if r["actor_type"] == "human"))
        review = next(r for r in roster if r["role"] == "review_agent")
        self.assertTrue(all(review["model"] != r["model"] for r in code))
        kinds = {e["event_type"] for e in self.e1}
        self.assertTrue({"APPROVAL_REQUESTED", "APPROVAL_DECIDED", "CI_RUN_STARTED", "CHECK_COMPLETED",
                         "CI_RUN_COMPLETED", "ORACLE_RESULT", "REVIEW_SUBMITTED"} <= kinds)
        self.assertTrue(all(e["metadata"]["instrument"] for e in self.e1 if e["event_type"] == "ORACLE_RESULT"))

    def test_authority_rules(self):
        self.assertEqual(authority_violations(self.e1), [])
        self.assertEqual(authority_violations(self.e0), [])
        deciders = {e["actor"]["role"] for e in self.e1 if e["event_type"] == "APPROVAL_DECIDED"}
        self.assertEqual(deciders, {"product_owner", "tech_lead", "architect", "engineer", "code_owner",
                                    "release_manager"})
        reviews = [e for e in self.e1 if e["event_type"] == "REVIEW_SUBMITTED"]
        self.assertEqual({e["payload"]["decision"] for e in reviews if e["actor"]["actor_type"] == "agent"},
                         {"commented", "changes_requested"})

    def test_f0_and_f1_differ_in_gates(self):
        self.assertEqual(gate_checks(self.e0), set())
        self.assertEqual(gate_checks(self.e1), {f"ARCH-{i}" for i in range(1, 9)})
        ids0 = {e["payload"]["check_id"] for e in self.e0 if e["event_type"] == "CHECK_COMPLETED"}
        self.assertEqual(ids0, {"typecheck", "unit-tests"})
        orders1 = next(r for r in self.s1["stories"] if r["story"] == "S-2")["ci"][0]["checks"]
        self.assertEqual(orders1, ["typecheck", "unit-tests"] + [f"ARCH-{i}" for i in range(1, 9)])

    def test_replay_export_is_valid(self):
        for cond, events in (("F1", self.e1), ("F0", self.e0)):
            on_disk = json.loads((self.tmp / cond / "replay.json").read_text(encoding="utf-8"))
            self.assertEqual(replay_errors(on_disk), [], cond)
            self.assertEqual(on_disk["meta"]["legend"], "SIMULATED (mock agent) — not a real run")
            self.assertEqual(on_disk["meta"]["trace_sha256"], trace_sha256(events))

    def test_default_variant_omits_devops_agent_and_records_why(self):
        self.assertNotIn("devops_agent", {r["role"] for r in self.e1[0]["payload"]["roster"]})
        self.assertIn("omitted", self.e1[0]["metadata"]["devops_agent"])

    def test_workspace_removed(self):
        self.assertFalse((flow_run.flow_root() / "test-real-F1").exists())


class SlowFlowTests(unittest.TestCase):
    @SLOW
    def test_real_f0_sprint(self):
        out = Path(tempfile.mkdtemp(prefix="avg-flow-f0-"))
        self.addCleanup(shutil.rmtree, out, True)
        s = flow_run.Sprint("F0", False, out, False, ws_name="test-slow-F0").run()
        self.assertTrue(s["trace_valid"], s["violations"])
        events = read_trace(out / "events.jsonl")
        self.assertEqual(gate_checks(events), set())
        self.assertEqual(s["stats"]["stories_merged"], ["S-1", "S-2", "S-4", "S-5"])


if __name__ == "__main__":
    unittest.main()
