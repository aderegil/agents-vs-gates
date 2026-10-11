"""Run Explorer plugin (spec §22.4) through HTTP: table, summary, tabs, blinding, run-id validation, roles.
No runner is started and no model is called; run folders are written by hand into a temp results root."""
import json
import shutil
import unittest
from pathlib import Path

from console.tests.helpers import ConsoleFixture
from harness import paths
from harness.jsonio import write_json_atomic, write_jsonl
from tests._analysis_fixture import record

PLUGINS = ("runs", "replay")
EXAMPLE_TRACE = paths.CONTRACTS / "examples" / "trace-m1-xrename-v0s0.jsonl"
SECRET_FINAL = "SECRET-FINAL-MESSAGE-9f2"
SECRET_DIFF = "SECRET-DIFF-LINE-7c1"
BLIND_MARKERS = ["fixed_code", "passed_first_ci", "still_failing", "ARCH-4", "billing-service", "staging_break",
                 SECRET_FINAL, SECRET_DIFF, "SECRET-TOOL-OUTPUT", "not_done"]

DIFF_GEN = (f"diff --git a/src/core/events.ts b/src/core/events.ts\n--- a/src/core/events.ts\n+++ b/src/core/events.ts\n"
            f"@@ -10,4 +10,4 @@ export interface OrderPlaced {{\n   id: string;\n-  totalCents: number;\n"
            f"+  amountCents: number; // {SECRET_DIFF}\n   currency: string;\n")
DIFF_FIX1 = ("diff --git a/src/core/events.ts b/src/core/events.ts\n--- a/src/core/events.ts\n+++ b/src/core/events.ts\n"
             "@@ -10,5 +10,6 @@ export interface OrderPlaced {\n   id: string;\n+  totalCents: number;\n"
             "   amountCents: number;\n   currency: string;\n")


def transcript_events():
    return [
        {"ts": "2026-10-11T09:00:00Z", "session": "gen", "kind": "text", "text": "I will rename the field."},
        {"ts": "2026-10-11T09:00:01Z", "session": "gen", "kind": "tool_call", "id": "t1", "name": "Edit",
         "input": {"file_path": "src/core/events.ts", "old_string": "totalCents", "new_string": "amountCents"}},
        {"ts": "2026-10-11T09:00:02Z", "session": "gen", "kind": "tool_result", "id": "t1", "status": "success",
         "output": "SECRET-TOOL-OUTPUT " + "x" * 20000 + " C:\\Users\\bob\\project\\file.ts"},
        {"ts": "2026-10-11T09:00:03Z", "session": "gen", "kind": "final",
         "text": SECRET_FINAL, "subtype": "success", "is_error": False, "num_turns": 3, "duration_ms": 5000,
         "usage": {"input_tokens": 100, "output_tokens": 20}, "cost_usd": 0},
    ]


def make_run(ns_dir: Path, rid: str, stage: str, **kw):
    rec = record(rid, stage, kw.pop("ticket", "X-rename"), kw.pop("V", "V0"), kw.pop("S", "S0"),
                 unit="mock", final_message=SECRET_FINAL, **kw)
    rec["namespace"] = "mock"
    rec["ticket_text"] = "Rename totalCents to amountCents."
    rec["sessions"] = [{"kind": "gen", "num_turns": 6, "duration_ms": 20000, "usage": {"input_tokens": 1000}, "subtype": "success"},
                       {"kind": "fix1", "num_turns": 3, "duration_ms": 9000, "usage": {"input_tokens": 400}, "subtype": "success"}]
    rec["repair_attempts"] = 1
    d = ns_dir / "runs" / rid
    write_json_atomic(d / "record.json", rec)
    (d / "diffs").mkdir(parents=True, exist_ok=True)
    (d / "diffs" / "gen.diff").write_text(DIFF_GEN, encoding="utf-8", newline="\n")
    (d / "diffs" / "fix1.diff").write_text(DIFF_FIX1, encoding="utf-8", newline="\n")
    write_jsonl(d / "transcript.jsonl", transcript_events())
    shutil.copyfile(EXAMPLE_TRACE, d / "events.jsonl")
    return rec


def seed_explorer(results: Path, unblind=()):
    """mock namespace: P0 (3 runs, always visible), P1 (4 runs, blinded unless unblind has P1), selftest st-demo-1."""
    ns = results / "mock"
    manifest_runs, st_runs = [], {}
    for i in range(1, 4):
        rid = f"p0-{i:04d}"
        make_run(ns, rid, "P0", ci_failed=("ARCH-4",) if i == 1 else (), broken=("billing-service",) if i == 1 else (),
                 outcome="fixed_code" if i == 1 else "passed_first_ci")
        manifest_runs.append({"run_id": rid, "stage": "P0", "unit": "mock", "ticket": "X-rename", "wording": "W1",
                              "visibility": "V0", "spec": "S0", "replicate": i, "round": i, "cell": "X-rename|V0|S0|W1|mock"})
        st_runs[rid] = {"status": "done"}
    for i in range(1, 5):
        rid = f"p1-{i:04d}"
        ticket, spec = ("X-rename", "S0") if i <= 2 else ("X-remove", "S2")
        make_run(ns, rid, "P1", ticket=ticket, S=spec, ci_failed=("ARCH-4",), broken=("billing-service",),
                 outcome="fixed_code", flags=(("D1", "ci/check.mjs"),) if i == 1 else (), contaminated=(i == 2))
        manifest_runs.append({"run_id": rid, "stage": "P1", "unit": "mock", "ticket": ticket, "wording": "W1",
                              "visibility": "V0", "spec": spec, "replicate": i, "round": i, "cell": f"{ticket}|V0|{spec}|W1|mock"})
        st_runs[rid] = {"status": "done"}
    make_run(ns, "st-demo-1", "selftest", outcome="fixed_code", ci_failed=("ARCH-4",))
    write_json_atomic(ns / "manifest.json", {"schema": "manifest/1", "seed": 1, "namespace": "mock",
                                             "generated_at": "2026-10-11T00:00:00Z", "runs": manifest_runs})
    write_json_atomic(ns / "state.json", {
        "schema": "state/1", "namespace": "mock", "runs": st_runs, "runner": {"pid": None, "status": "idle"},
        "workers": {}, "usage": {}, "updated_at": "2026-10-11T10:00:00Z",
        "unblinded": {s: {"at": "2026-10-11T10:00:00Z", "forced": False, "by": "t"} for s in unblind}})
    write_json_atomic(ns / "coding" / "labels.json", {"gate": {"p1-0001": "T2", "p0-0001": "T1"}, "reviewer_reasons": {},
                                                       "unlabelled": []})


class RunsListTest(unittest.TestCase):
    def test_table_and_filters_hide_blinded_fields(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results)
            d = fx.owner.get("/api/runs?ns=mock").json
            ids = [r["run_id"] for r in d["runs"]]
            self.assertEqual(ids, ["p0-0001", "p0-0002", "p0-0003", "p1-0001", "p1-0002", "p1-0003", "p1-0004", "st-demo-1"])
            by = {r["run_id"]: r for r in d["runs"]}
            self.assertEqual(by["p0-0001"]["outcome"], "fixed_code")           # P0 is always visible
            self.assertEqual(by["st-demo-1"]["outcome"], "fixed_code")
            p1 = by["p1-0001"]
            self.assertTrue(p1["blinded"])
            self.assertIsNone(p1["outcome"])
            self.assertIsNone(p1["detectors"])
            self.assertIsNone(p1["ticket_done"])
            self.assertEqual((p1["turns"], p1["tokens"]), (10, 1100))             # resource use is not an outcome
            self.assertTrue(by["p1-0002"]["contaminated"])                        # exclusion flags stay visible
            self.assertEqual(d["blinded_stages"], ["P1"])
            self.assertEqual(d["facets"]["tickets"], ["X-remove", "X-rename"])
            self.assertEqual(d["facets"]["stages"], ["P0", "P1", "selftest"])
            blob = json.dumps([r for r in d["runs"] if r["stage"] == "P1"])
            for marker in ("fixed_code", "still_failing", "ARCH-4", "billing-service"):
                self.assertNotIn(marker, blob)

            def ids_of(q):
                return [r["run_id"] for r in fx.owner.get(f"/api/runs?ns=mock&{q}").json["runs"]]
            self.assertEqual(ids_of("stage=P0"), ["p0-0001", "p0-0002", "p0-0003"])
            self.assertEqual(ids_of("ticket=X-remove"), ["p1-0003", "p1-0004"])
            self.assertEqual(ids_of("S=S2&stage=P1"), ["p1-0003", "p1-0004"])
            self.assertEqual(ids_of("V=V1"), [])
            self.assertEqual(ids_of("unit=mock&W=W1&status=selftest"), ["st-demo-1"])
            self.assertEqual(ids_of("q=0002"), ["p0-0002", "p1-0002"])
            self.assertEqual(fx.owner.get("/api/runs?ns=mock&limit=abc").status, 400)

    def test_unblinded_stage_shows_outcomes_and_flags(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results, unblind=("P1",))
            by = {r["run_id"]: r for r in fx.owner.get("/api/runs?ns=mock").json["runs"]}
            self.assertEqual(by["p1-0001"]["outcome"], "fixed_code")
            self.assertEqual(by["p1-0001"]["detectors"], 1)
            self.assertFalse(by["p1-0001"]["blinded"])

    def test_namespaces_never_mix(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results)
            self.assertEqual(fx.owner.get("/api/runs?ns=real").json["runs"], [])
            self.assertEqual(fx.owner.get("/api/runs/p0-0001?ns=real").status, 404)


class RunsDetailTest(unittest.TestCase):
    def test_blinded_run_leaks_nothing(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results)
            d = fx.owner.get("/api/runs/p1-0001?ns=mock")
            self.assertEqual(d.status, 200)
            self.assertTrue(d.json["blinded"])
            self.assertEqual(d.json["blinded_message"], "Blinded until stage complete")
            rec = d.json["record"]
            for k in ("outcome", "ticket_done", "metrics", "oracle", "ci", "detectors", "final_message", "repair_attempts",
                      "sessions", "out_of_scope_edits", "reviews"):
                self.assertNotIn(k, rec)
            self.assertEqual(rec["ticket"], "X-rename")
            self.assertEqual(rec["totals"]["turns"], 10)
            self.assertIsNone(d.json["coding_label"])
            for tab in ("diff", "ci", "oracle", "detectors", "transcript"):
                r = fx.owner.get(f"/api/runs/p1-0001/{tab}?ns=mock")
                self.assertEqual(r.status, 403, tab)
                self.assertEqual(r.json["error"], "Blinded until stage complete")
            tr = fx.owner.get("/api/runs/p1-0001/trace?ns=mock")      # structure only
            self.assertEqual(tr.status, 200)
            self.assertTrue(tr.json["blinded"])
            self.assertNotIn("violations", tr.json)
            self.assertEqual(fx.owner.get("/api/runs/p1-0001/replay?ns=mock").status, 403)
            for t in ("", "/trace"):
                body = fx.owner.get(f"/api/runs/p1-0001{t}?ns=mock").text
                for marker in BLIND_MARKERS:
                    self.assertNotIn(marker, body, f"{marker} leaked in {t or 'summary'}")

    def test_visible_run_all_tabs(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results)
            get = lambda p: fx.owner.get(f"/api/runs/p0-0001{p}?ns=mock")  # noqa: E731
            s = get("")
            self.assertEqual(s.status, 200, s.text)
            rec = s.json["record"]
            self.assertEqual((rec["outcome"], rec["ticket_done"]), ("fixed_code", "done"))
            self.assertTrue(rec["metrics"]["staging_break"])
            self.assertEqual(rec["ci_attempts"], 1)
            self.assertNotIn("ci", rec)                                          # heavy parts have their own endpoints
            self.assertEqual(s.json["files"]["diffs"], ["gen", "fix1"])
            self.assertEqual(s.json["coding_label"], "T1")

            diff = get("/diff").json["diffs"]
            self.assertEqual([x["ref"] for x in diff], ["gen", "fix1"])
            self.assertIn(SECRET_DIFF, diff[0]["text"])
            self.assertTrue(diff[1]["incremental"])

            ci = get("/ci").json["attempts"][0]
            self.assertEqual(ci["failed"], ["ARCH-4"])
            self.assertEqual(len(ci["checks"]), 10)
            orc = get("/oracle").json
            self.assertFalse(orc["gen"]["consumers"]["billing-service"]["ok"])
            self.assertTrue(orc["final"]["ok"])
            det = fx.owner.get("/api/runs/p0-0001/detectors?ns=mock").json
            self.assertEqual(det["coding_label"], "T1")
            self.assertIn("D1", det["names"])

            tr = get("/transcript").json
            self.assertEqual(tr["total"], 4)
            self.assertEqual([e["kind"] for e in tr["events"]], ["text", "tool_call", "tool_result", "final"])
            self.assertTrue(tr["truncated_strings"])
            self.assertLess(len(tr["events"][2]["output"]), 13000)
            self.assertNotIn("bob", get("/transcript").text)                     # C:\Users\<name> sanitized by the core
            page = fx.owner.get("/api/runs/p0-0001/transcript?ns=mock&limit=2&offset=1").json
            self.assertEqual([e["kind"] for e in page["events"]], ["tool_call", "tool_result"])

            trace = get("/trace").json
            self.assertTrue(trace["valid"])
            self.assertGreater(trace["events"], 10)
            self.assertEqual(trace["violation_count"], 0)

    def test_detector_flags_visible_after_unblinding(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results, unblind=("P1",))
            det = fx.owner.get("/api/runs/p1-0001/detectors?ns=mock").json
            self.assertEqual(det["coding_label"], "T2")
            self.assertEqual(det["entries"][0]["flags"][0]["detector"], "D1")

    def test_trace_violations_reported(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results)
            bad = paths.REPO / "trace" / "examples" / "invalid-rule02-seq-gap.jsonl"
            shutil.copyfile(bad, fx.results / "mock" / "runs" / "p0-0002" / "events.jsonl")
            t = fx.owner.get("/api/runs/p0-0002/trace?ns=mock").json
            self.assertFalse(t["valid"])
            self.assertIn("2", t["rules"])
            self.assertTrue(t["violations"])

    def test_missing_files_are_404_not_500(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results)
            run = fx.results / "mock" / "runs" / "p0-0003"
            (run / "transcript.jsonl").unlink()
            (run / "events.jsonl").unlink()
            shutil.rmtree(run / "diffs")
            self.assertEqual(fx.owner.get("/api/runs/p0-0003/transcript?ns=mock").status, 404)
            self.assertEqual(fx.owner.get("/api/runs/p0-0003/trace?ns=mock").status, 404)
            self.assertEqual(fx.owner.get("/api/runs/p0-0003/diff?ns=mock").json["diffs"], [])
            self.assertEqual(fx.owner.get("/api/runs/p0-0003/replay?ns=mock").status, 404)

    def test_replay_delegates_to_service(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results)
            r = fx.owner.get("/api/runs/p0-0001/replay?ns=mock")
            self.assertIn(r.status, (200, 503), r.text[:200])    # 503 only while WP5's module is missing
            if r.status == 200:
                self.assertIn("meta", r.json)

    def test_replay_503_when_service_unavailable(self):
        import sys
        from unittest import mock
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results)
            with mock.patch.dict(sys.modules, {"replay.service": None}):
                r = fx.owner.get("/api/runs/p0-0001/replay?ns=mock")
            self.assertEqual(r.status, 503)


class RunIdValidationTest(unittest.TestCase):
    def test_bad_ids_are_404(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results)
            secret = fx.results / "secret.json"
            secret.write_text('{"stage":"P0","run_id":"x"}', encoding="utf-8")
            for bad in ("..", "..%2F..%2Fsecret", "p1-00011", "P1-0001", "p9-0001", "p1-1", "st-", "st-demo-1-2-3-4-5",
                        "p1-0001%00", "p1-0001%5C..", "C:%5Cx", "%2e%2e", "p1-0001.json", "%20p1-0001"):
                for tail in ("", "/diff", "/ci", "/transcript", "/replay"):
                    r = fx.owner.get(f"/api/runs/{bad}{tail}?ns=mock")
                    self.assertIn(r.status, (400, 404), f"{bad}{tail} → {r.status}")
            self.assertEqual(fx.owner.get("/api/runs/p1-0099?ns=mock").status, 404)


class RunsRolesTest(unittest.TestCase):
    def test_roles(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results)
            self.assertEqual(fx.client("pres", "presenter").get("/api/runs?ns=mock").status, 200)
            self.assertEqual(fx.client("op", "operator").get("/api/runs?ns=mock").status, 200)
            viewer = fx.client("vic", "viewer")
            self.assertEqual(viewer.get("/api/runs?ns=mock").status, 403)
            self.assertEqual(viewer.get("/api/runs/p0-0001?ns=mock").status, 403)

    def test_presenter_is_read_only(self):
        with ConsoleFixture(copy_real=PLUGINS) as fx:
            seed_explorer(fx.results)
            plugins = fx.client("pres2", "presenter").get("/api/plugins").json["plugins"]
            runs = next(p for p in plugins if p["id"] == "runs")
            self.assertTrue(runs.get("readonly"))


if __name__ == "__main__":
    unittest.main()
