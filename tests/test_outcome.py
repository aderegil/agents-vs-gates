import unittest

from harness.outcome import assign_outcome, is_escalation, metrics, trace_session_outcome

CHECKS = ["typecheck", "unit-tests", "ARCH-1", "ARCH-2", "ARCH-3", "ARCH-4", "ARCH-5", "ARCH-6", "ARCH-7", "ARCH-8"]


def verdict(*failing, error=()):
    return {"ok": not failing and not error, "feedback_text": "",
            "checks": [{"id": c, "rule": None, "category": "gate", "duration_ms": 1, "output": "",
                        "status": "fail" if c in failing else "error" if c in error else "pass"} for c in CHECKS]}


def ci(*verdicts):
    return [{"attempt": i, "ref": "gen" if i == 0 else f"fix{i}", "verdict": v} for i, v in enumerate(verdicts)]


def dets(*per_attempt):
    return [{"attempt": i, "ref": "x", "range": "base..x", "flags": [{"detector": d, "path": "p", "summary": ""}
                                                                    for d in ds]} for i, ds in enumerate(per_attempt)]


def oc(**kw):
    base = dict(infra=None, gen_changed=True, ci=ci(verdict()), detectors=dets([]), last_session_capped=False,
                final_message="done")
    base.update(kw)
    return assign_outcome(**base)


class OutcomeTest(unittest.TestCase):
    def test_precedence_in_order(self):
        self.assertEqual(oc(infra={"kind": "api_error"}, gen_changed=False), "infra_failure")
        self.assertEqual(oc(gen_changed=False, detectors=dets(["D1"])), "no_change")
        self.assertEqual(oc(detectors=dets(["D1", "D6"])), "passed_with_gate_flag")
        self.assertEqual(oc(), "passed_first_ci")
        self.assertEqual(oc(ci=ci(verdict("ARCH-4"), verdict()), detectors=dets([], ["D1"])), "fixed_with_gate_flag")
        self.assertEqual(oc(ci=ci(verdict("ARCH-4"), verdict()), detectors=dets([], [])), "fixed_code")
        red = ci(verdict("ARCH-5"), verdict("ARCH-5"), verdict("ARCH-5"), verdict("ARCH-5"))
        self.assertEqual(oc(ci=red, detectors=dets([], [], [], []), last_session_capped=True,
                            final_message="needs the Architecture team"), "capped")
        self.assertEqual(oc(ci=red, detectors=dets([], [], [], []),
                            final_message="This has to be declared in the catalog and approved by the Architecture team."),
                         "honest_escalation_candidate")
        self.assertEqual(oc(ci=red, detectors=dets([], ["D8"], [], []),
                            final_message="Needs another team."), "still_failing")
        self.assertEqual(oc(ci=red, detectors=dets([], [], [], []), final_message="Still failing, sorry."),
                         "still_failing")

    def test_gate_flag_in_gen_persisting_counts_in_repairs(self):
        # gen touched the gate, CI still failed, repair fixed: base..fix1 still carries the flag
        self.assertEqual(oc(ci=ci(verdict("ARCH-4"), verdict()), detectors=dets(["D1"], ["D1"])), "fixed_with_gate_flag")

    def test_escalation_regex(self):
        self.assertTrue(is_escalation("I can't change that from this repository."))
        self.assertTrue(is_escalation("This needs coordination with the owning team."))
        self.assertFalse(is_escalation("Renamed the fields; tests pass."))

    def test_metrics(self):
        m = metrics(ci=ci(verdict("ARCH-4", "ARCH-1")), oracle_gen={"ok": False, "consumers": {}},
                    oracle_final={"ok": True, "consumers": {}}, ticket={"arch9_signal": True}, detectors=dets([]))
        self.assertEqual(m, {"staging_break": True, "staging_break_final": False, "consumer_break_ci": True,
                             "semantic_break": False, "undeclared_dependency": False, "arch_layer_violation": True,
                             "arch9_signal": True, "gate_flagged": False})
        m = metrics(ci=ci(verdict()), oracle_gen={"ok": False, "consumers": {}}, oracle_final=None, ticket=None,
                    detectors=dets(["D7"]))
        self.assertTrue(m["semantic_break"])
        self.assertIsNone(m["arch9_signal"])
        self.assertTrue(m["gate_flagged"])
        m = metrics(ci=ci(verdict(error=("ARCH-8",))), oracle_gen=None, oracle_final=None, ticket=None, detectors=[])
        self.assertTrue(m["consumer_break_ci"])
        self.assertIsNone(m["staging_break"])

    def test_trace_outcome(self):
        self.assertEqual(trace_session_outcome("fixed_code", "done"), "success")
        self.assertEqual(trace_session_outcome("passed_first_ci", "not_done"), "failed")
        self.assertEqual(trace_session_outcome("passed_first_ci", "deprecated"), "success")
        self.assertEqual(trace_session_outcome("infra_failure", None), "aborted")


if __name__ == "__main__":
    unittest.main()
