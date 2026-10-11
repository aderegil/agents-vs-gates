import unittest

from harness import covariates


def call(i, cmd, session="gen", name="Bash"):
    return {"kind": "tool_call", "id": f"t{i}", "name": name, "session": session, "input": {"command": cmd}}


def result(i, status="success", output="", session="gen"):
    return {"kind": "tool_result", "id": f"t{i}", "status": status, "session": session, "output": output}


class CovariatesTest(unittest.TestCase):
    def test_ran_tests_and_denials(self):
        tr = [call(1, "sed -i 's/a/b/' x.ts"), result(1, "denied"),
              call(2, "cd orders-service && npm test 2>&1 | tail -15"), result(2),
              call(3, "npm run typecheck", session="fix1"), result(3, session="fix1"),
              call(4, "sed -i 's/x/y/' y.ts"), result(4, "error", "Permission for this tool use was denied. It requires approval")]
        self.assertEqual(covariates.compute(tr), {"ran_tests": True, "ran_tests_any": True, "shell_denials": 2,
                                                  "shell_denials_gen": 2})

    def test_denied_test_command_and_other_tools_do_not_count(self):
        tr = [call(1, "npm test"), result(1, "denied"),
              {"kind": "tool_call", "id": "r", "name": "Read", "session": "gen", "input": {"file_path": "npm test"}},
              {"kind": "tool_result", "id": "r", "status": "denied", "session": "gen"},
              call(2, "npm run arch", session="fix1"), result(2, session="fix1"),
              call(3, "npx tsc --noEmit"), result(3, "error", "error TS2322")]
        c = covariates.compute(tr)
        self.assertTrue(c["ran_tests"])           # a failing tsc still ran the checks
        self.assertTrue(c["ran_tests_any"])
        self.assertEqual((c["shell_denials"], c["shell_denials_gen"]), (1, 1))
        self.assertFalse(covariates.compute([call(1, "npm install"), result(1)])["ran_tests"])
        self.assertFalse(covariates.compute([call(1, "ls test"), result(1)])["ran_tests"])


if __name__ == "__main__":
    unittest.main()
