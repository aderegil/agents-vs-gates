"""CI gates fail closed on empty input (Alfredo's research, 2026-10-11: "a gate that analyses nothing always passes").

Each case breaks one input of the real CI (`ci.run`, Node toolchain, no model call) in a temp copy of
scenario/repos/orders-service (or of scenario/repos/architecture) and asserts that the check reading that input does
not pass and the verdict is not ok. A canonical control in the same kind of temp dir must be all green, so the
assertions are not vacuous.

Speed: the cases run in a thread pool. Cases that are not about the unit tests replace `npm test` with a stub that
passes (the rest of the CI is real); the unit-test cases run the real `npm test`.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from ci import run as cirun
from harness import paths

WORKERS = 4
ARCH_CHECKS = ("ARCH-1", "ARCH-2", "ARCH-3", "ARCH-4", "ARCH-5", "ARCH-6", "ARCH-7", "ARCH-8")
COPY_IGNORE = shutil.ignore_patterns("node_modules", "dist", ".ci-build", ".git")
STUB_TESTS = {"status": "pass", "output": "unit-tests PASS: (stubbed by tests/test_ci_empty_inputs.py)", "ms": 0}


def _link_node_modules(root: Path) -> None:
    """Workspaces live under a worker dir that holds node_modules; mimic that with a junction (no copy)."""
    target = paths.NODE_MODULES.resolve()
    if sys.platform == "win32":
        import _winapi
        _winapi.CreateJunction(str(target), str(root / "node_modules"))
    else:
        os.symlink(target, root / "node_modules", target_is_directory=True)


def _unlink_node_modules(root: Path) -> None:
    link = root / "node_modules"
    if link.exists() or os.path.islink(link):
        try:
            os.rmdir(link)          # removes the junction itself, never what it points to
        except OSError:
            os.unlink(link)


def _write(p: Path, text: str) -> None:
    p.write_text(text, encoding="utf-8", newline="\n")


def _replace(p: Path, old: str, new: str) -> None:
    text = p.read_text(encoding="utf-8")
    assert old in text, f"{old!r} not in {p}"
    _write(p, text.replace(old, new))


# ---- breakages: each takes (svc, arch) and edits the temp copy -------------------------------------------------

def _empty_src(svc, arch):
    shutil.rmtree(svc / "src")
    (svc / "src").mkdir()


def _no_src(svc, arch):
    shutil.rmtree(svc / "src")


def _no_depcruise_config(svc, arch):
    (svc / ".dependency-cruiser.cjs").unlink()


def _broken_depcruise_config(svc, arch):
    _write(svc / ".dependency-cruiser.cjs", "module.exports = {\n")


def _depcruise_includes_nothing(svc, arch):
    _replace(svc / ".dependency-cruiser.cjs", "options: {", "options: {\n    includeOnly: \"^nowhere/\",")


def _no_test_files(svc, arch):
    shutil.rmtree(svc / "test")


def _test_script_echo(svc, arch):
    _replace(svc / "package.json", '"npm run build && node --test \\"dist/test/**/*.test.js\\""', '"echo tests ok"')


def _test_glob_matches_nothing(svc, arch):
    _replace(svc / "package.json", 'dist/test/**/*.test.js', 'dist/nowhere/**/*.test.js')


def _tsconfig_includes_nothing(svc, arch):
    _replace(svc / "tsconfig.json", '"include": ["src", "test"]', '"include": ["nowhere"]')


def _v1_contracts_emptied(svc, arch):
    for p in (svc / "contracts" / "consumers").glob("*.json"):
        p.unlink()


def _v1_contracts_dir_removed(svc, arch):
    shutil.rmtree(svc / "contracts")


def _v1_contract_unparseable(svc, arch):
    _write(svc / "contracts" / "consumers" / "billing-service__OrderPlaced.json", "{ not json\n")


def _v1_contract_requires_nothing(svc, arch):
    p = svc / "contracts" / "consumers" / "billing-service__OrderPlaced.json"
    data = json.loads(p.read_text(encoding="utf-8"))
    data["requires"] = {}
    _write(p, json.dumps(data, indent=2) + "\n")


def _broker_empty(svc, arch):
    for p in (arch / "broker").glob("*.json"):
        p.unlink()


def _broker_no_rest(svc, arch):
    (arch / "broker" / "web-storefront__GET-orders-id.json").unlink()


def _broker_rest_unparseable(svc, arch):
    _write(arch / "broker" / "web-storefront__GET-orders-id.json", "{ not json\n")


def _catalog_empty(svc, arch):
    for p in (arch / "catalog").glob("*.yaml"):
        p.unlink()


def _catalog_unparseable(svc, arch):
    _write(arch / "catalog" / "orders-service.yaml", "name: orders-service\nprovides:\n  apis: [{ name: x,\n")


def _catalog_without_me(svc, arch):
    (arch / "catalog" / "orders-service.yaml").unlink()


def _baseline_missing(svc, arch):
    (arch / "pii-baseline.json").unlink()


def _baseline_unparseable(svc, arch):
    _write(arch / "pii-baseline.json", "{ not json\n")


# case -> (visibility, breakage, checks that must not pass, real npm test?)
CASES = {
    "control": ("V0", None, (), True),
    "empty_src": ("V0", _empty_src, ("ARCH-1", "ARCH-2", "ARCH-3", "ARCH-5", "ARCH-6", "ARCH-7"), False),
    "no_src": ("V0", _no_src, ("ARCH-1", "ARCH-2", "ARCH-3", "ARCH-5", "ARCH-6", "ARCH-7"), False),
    "v2_empty_src": ("V2", _empty_src, ("ARCH-1", "ARCH-2", "ARCH-3", "ARCH-5", "ARCH-6", "ARCH-7"), False),
    "no_depcruise_config": ("V0", _no_depcruise_config, ("ARCH-1", "ARCH-2", "ARCH-3"), False),
    "broken_depcruise_config": ("V0", _broken_depcruise_config, ("ARCH-1", "ARCH-2", "ARCH-3"), False),
    "depcruise_includes_nothing": ("V0", _depcruise_includes_nothing, ("ARCH-1", "ARCH-2", "ARCH-3"), False),
    "no_test_files": ("V0", _no_test_files, ("unit-tests",), True),
    "test_script_echo": ("V0", _test_script_echo, ("unit-tests",), True),
    "test_glob_matches_nothing": ("V0", _test_glob_matches_nothing, ("unit-tests",), True),
    "tsconfig_includes_nothing": ("V0", _tsconfig_includes_nothing, ("typecheck",), False),
    "v1_contracts_emptied": ("V1", _v1_contracts_emptied, ("ARCH-4",), False),
    "v1_contracts_dir_removed": ("V1", _v1_contracts_dir_removed, ("ARCH-4",), False),
    "v1_contract_unparseable": ("V1", _v1_contract_unparseable, ("ARCH-4",), False),
    "v1_contract_requires_nothing": ("V1", _v1_contract_requires_nothing, ("ARCH-4",), False),
    "broker_empty": ("V0", _broker_empty, ("ARCH-4", "ARCH-8"), False),
    "broker_no_rest_contract": ("V0", _broker_no_rest, ("ARCH-8",), False),
    "broker_rest_contract_unparseable": ("V0", _broker_rest_unparseable, ("ARCH-8",), False),
    "catalog_empty": ("V0", _catalog_empty, ("ARCH-5", "ARCH-6", "ARCH-7"), False),
    "catalog_unparseable": ("V0", _catalog_unparseable, ("ARCH-5", "ARCH-6", "ARCH-7"), False),
    "catalog_without_orders_service": ("V0", _catalog_without_me, ("ARCH-5", "ARCH-6", "ARCH-7"), False),
    "pii_baseline_missing": ("V0", _baseline_missing, ("ARCH-6",), False),
    "pii_baseline_unparseable": ("V0", _baseline_unparseable, ("ARCH-6",), False),
}


def _build(tmp: Path, V: str, breakage) -> tuple[Path, Path, Path]:
    """-> (workspace, service dir, arch dir) under tmp."""
    root = tmp / "w"
    root.mkdir()
    _link_node_modules(root)
    ws = root / "r"
    if V == "V2":
        for repo in ("orders-service", "billing-service", "analytics-ingest", "web-storefront"):
            shutil.copytree(paths.REPOS / repo, ws / repo, ignore=COPY_IGNORE)
        svc = ws / "orders-service"
    else:
        shutil.copytree(paths.REPOS / "orders-service", ws, ignore=COPY_IGNORE)
        svc = ws
        if V == "V1":
            from harness.workspace import _v1_extras
            _v1_extras(ws, [])
    arch = tmp / "arch"
    for d in ("broker", "catalog"):
        shutil.copytree(cirun.ARCH_SRC / d, arch / d)
    shutil.copyfile(cirun.ARCH_SRC / "pii-baseline.json", arch / "pii-baseline.json")
    if breakage:
        breakage(svc, arch)
    return ws, svc, arch


def _run_case(name: str) -> dict:
    V, breakage, _, _ = CASES[name]
    tmp = Path(tempfile.mkdtemp(prefix=f"avg-ci-empty-{name}-"))
    try:
        ws, svc, arch = _build(tmp, V, breakage)
        verdict = cirun._run(svc, V, arch)
        cirun.toolchain.rmtree(svc / cirun.CI_BUILD)
        return verdict
    finally:
        _unlink_node_modules(tmp / "w")
        cirun.toolchain.rmtree(tmp)


class CiEmptyInputsTest(unittest.TestCase):
    verdicts: dict[str, dict] = {}
    errors: dict[str, str] = {}

    @classmethod
    def setUpClass(cls):
        if not (paths.NODE_MODULES / "typescript").exists() or shutil.which("node") is None:
            raise unittest.SkipTest("node / repo node_modules not available")
        stubbed = [n for n, c in CASES.items() if not c[3]]
        real = [n for n, c in CASES.items() if c[3]]

        def go(names):
            with ThreadPoolExecutor(max_workers=WORKERS) as pool:
                futs = {n: pool.submit(_run_case, n) for n in names}
            for n, f in futs.items():
                try:
                    cls.verdicts[n] = f.result()
                except Exception as ex:  # reported by the case's own test
                    cls.errors[n] = f"{type(ex).__name__}: {ex}"

        with mock.patch.object(cirun, "_stage_tests", lambda svc: dict(STUB_TESTS)):
            go(stubbed)
        go(real)

    def verdict(self, name: str) -> dict:
        self.assertNotIn(name, self.errors, self.errors.get(name))
        return self.verdicts[name]

    def assert_fails_closed(self, name: str) -> None:
        v = self.verdict(name)
        by_id = {c["id"]: c for c in v["checks"]}
        for cid in CASES[name][2]:
            with self.subTest(check=cid):
                c = by_id[cid]
                self.assertNotEqual(c["status"], "pass", f"{name}: {cid} passed on empty/broken input:\n{c['output']}")
                self.assertIn(c["status"], ("fail", "error"))
                self.assertIn(c["output"].splitlines()[0][:40], v["feedback_text"])
        self.assertFalse(v["ok"], f"{name}: verdict ok on empty/broken input")

    def test_control_is_green(self):
        v = self.verdict("control")
        self.assertTrue(v["ok"], v["feedback_text"])
        out = {c["id"]: c["output"] for c in v["checks"]}
        self.assertRegex(out["ARCH-1"], r"PASS: no violations \(dependency-cruiser, \d+ modules\)")

    # dependency-cruiser / source scans
    def test_empty_src(self):
        self.assert_fails_closed("empty_src")
        out = {c["id"]: c["output"] for c in self.verdict("empty_src")["checks"]}
        self.assertIn("ARCH-1 ERROR: dependency-cruiser analysed 0 modules under src/", out["ARCH-1"])
        self.assertIn("ARCH-5 ERROR: the source scan found 0 code files under src/", out["ARCH-5"])

    def test_no_src(self):
        self.assert_fails_closed("no_src")

    def test_v2_empty_src(self):
        self.assert_fails_closed("v2_empty_src")

    def test_no_depcruise_config(self):
        self.assert_fails_closed("no_depcruise_config")

    def test_broken_depcruise_config(self):
        self.assert_fails_closed("broken_depcruise_config")

    def test_depcruise_includes_nothing(self):
        self.assert_fails_closed("depcruise_includes_nothing")
        out = {c["id"]: c["output"] for c in self.verdict("depcruise_includes_nothing")["checks"]}
        self.assertIn("analysed 0 modules", out["ARCH-2"])

    # unit tests / typecheck
    def test_no_test_files(self):
        self.assert_fails_closed("no_test_files")

    def test_test_script_echo(self):
        self.assert_fails_closed("test_script_echo")

    def test_test_glob_matches_nothing(self):
        self.assert_fails_closed("test_glob_matches_nothing")

    def test_tsconfig_includes_nothing(self):
        self.assert_fails_closed("tsconfig_includes_nothing")

    # consumer contracts
    def test_v1_contracts_emptied(self):
        self.assert_fails_closed("v1_contracts_emptied")
        out = {c["id"]: c["output"] for c in self.verdict("v1_contracts_emptied")["checks"]}
        self.assertIn("ARCH-4 ERROR: found 0 event consumer contracts", out["ARCH-4"])

    def test_v1_contracts_dir_removed(self):
        self.assert_fails_closed("v1_contracts_dir_removed")

    def test_v1_contract_unparseable(self):
        self.assert_fails_closed("v1_contract_unparseable")

    def test_v1_contract_requires_nothing(self):
        self.assert_fails_closed("v1_contract_requires_nothing")

    def test_broker_empty(self):
        self.assert_fails_closed("broker_empty")

    def test_broker_no_rest_contract(self):
        self.assert_fails_closed("broker_no_rest_contract")

    def test_broker_rest_contract_unparseable(self):
        self.assert_fails_closed("broker_rest_contract_unparseable")

    # catalog / PII baseline
    def test_catalog_empty(self):
        self.assert_fails_closed("catalog_empty")

    def test_catalog_unparseable(self):
        self.assert_fails_closed("catalog_unparseable")

    def test_catalog_without_orders_service(self):
        self.assert_fails_closed("catalog_without_orders_service")

    def test_pii_baseline_missing(self):
        self.assert_fails_closed("pii_baseline_missing")

    def test_pii_baseline_unparseable(self):
        self.assert_fails_closed("pii_baseline_unparseable")


class MaterializeArchitectureTest(unittest.TestCase):
    """A missing broker/catalog/baseline in the architecture source no longer crashes the CI: it is materialized as
    empty/absent, and the checks above report `error`."""

    def test_missing_pieces_materialize_empty(self):
        src = Path(tempfile.mkdtemp(prefix="avg-ci-empty-archsrc-"))
        try:
            with mock.patch.object(cirun, "ARCH_SRC", src):
                arch = cirun.materialize_architecture("empty-inputs-test")
            try:
                self.assertEqual(list((arch / "broker").iterdir()), [])
                self.assertEqual(list((arch / "catalog").iterdir()), [])
                self.assertFalse((arch / "pii-baseline.json").exists())
                cat, err = cirun.load_catalog(arch / "catalog")
                self.assertIn("missing or empty", err)
            finally:
                cirun.toolchain.rmtree(arch)
        finally:
            cirun.toolchain.rmtree(src)


class UnitTestCountTest(unittest.TestCase):
    def test_counts(self):
        self.assertEqual(cirun._test_counts(["ℹ tests 39", "ℹ pass 39", "ℹ fail 0"]), {"tests": 39, "pass": 39})
        self.assertEqual(cirun._test_counts(["# tests 2", "# pass 0", "# tests 3", "# pass 3"]),
                         {"tests": 5, "pass": 3})
        self.assertEqual(cirun._test_counts([]), {})


if __name__ == "__main__":
    unittest.main()
