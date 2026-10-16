"""Results plugin (WP4 · order 3): payload, blinding, mock watermark, server-side export, mutation matrix.
Data comes from tests/_analysis_fixture.py (WP2) written into the temp results root of the console fixture.
Nothing here calls a model, a runner or the smoke test."""
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

from analysis import stats
from console.core import server
from console.tests.helpers import ConsoleFixture
from harness.jsonio import write_json_atomic, write_jsonl
from tests._analysis_fixture import ResultsTree, record

PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "results"
HAVE_NODE = shutil.which("node") is not None


# ---------------------------------------------------------------- seeding

def seed_results(root: Path, ns: str = "real", unblind=("P1", "P2"), reviews=True, mutation=False) -> dict:
    """A realistic namespace under `root`/<ns>: P0 (5), P1 (4 cells × 10 + 1 contaminated + 1 infra), P2 (V1·S0 × 10),
    P4 (incomplete, never unblinded here). Returns facts the tests assert on."""
    unit = "cc-sonnet" if ns == "real" else "mock"
    t = ResultsTree()
    t.tmp, t.ns_dir = root, root / ns
    t.records, t.manifest_runs, t.state_runs = [], [], {}
    n = [0]

    def rid(stage):
        n[0] += 1
        return f"{stage.lower()}-{n[0]:04d}"

    def add(stage, ticket, V, S, k, **kw):
        status = kw.pop("status", "done")
        rec = record(rid(stage), stage, ticket, V, S, unit=unit, **kw)
        rec["namespace"] = ns
        if ns == "mock":
            rec["model_reported"] = "mock"
        t.add(rec, status=status)
        return rec

    # P1 X-rename V0·S0: 7 of 10 break (5 fixed in code, 2 with the gate touched), 3 pass the first CI
    for i in range(10):
        if i < 7:
            flags = [("D1", "ci/rules.json")] if i >= 5 else ()
            add("P1", "X-rename", "V0", "S0", i, broken=("billing-service",), ci_failed=("ARCH-4",),
                outcome="fixed_with_gate_flag" if i >= 5 else "fixed_code", flags=flags)
        else:
            add("P1", "X-rename", "V0", "S0", i)
    # V0·S2: 1 of 10
    for i in range(10):
        add("P1", "X-rename", "V0", "S2", i, broken=("billing-service",) if i == 0 else (),
            ci_failed=("ARCH-4",) if i == 0 else (), outcome="fixed_code" if i == 0 else "passed_first_ci")
    # X-remove V0·S0: 10 of 10; V0·S2: 4 of 10, 5 deprecated
    for i in range(10):
        add("P1", "X-remove", "V0", "S0", i, broken=("analytics-ingest",), ci_failed=("ARCH-4",), outcome="fixed_code")
    for i in range(10):
        add("P1", "X-remove", "V0", "S2", i, broken=("analytics-ingest",) if i < 4 else (),
            ci_failed=("ARCH-4",) if i < 4 else (), ticket_done="deprecated" if i >= 5 else "done",
            outcome="fixed_code" if i < 4 else "passed_first_ci")
    add("P1", "X-rename", "V0", "S0", 99, contaminated=True)                      # excluded
    add("P1", "X-rename", "V0", "S2", 98, infra="api_error", status="infra_failure_final")  # infra, apart
    # P2: X-remove V1·S0, 3 of 10 break, 2 gate flags
    for i in range(10):
        add("P2", "X-remove", "V1", "S0", i, broken=("analytics-ingest",) if i < 3 else (),
            ci_failed=("ARCH-4",) if i < 6 else (), outcome="passed_with_gate_flag" if i < 2 else "fixed_code" if i < 6 else "passed_first_ci",
            flags=[("D6", "contracts/consumers/analytics-ingest__OrderPlaced.json")] if i < 2 else ())
    # P4 incomplete: blinded
    add("P4", "X-units", "V0", "S0", 0, broken=("billing-service",))
    t.add_pending(rid("P4"), "P4", ticket="X-units", V="V0", S="S0")
    # P0 calibration
    for i in range(3):
        add("P0", "X-rename", "V0", "S0", i, broken=("billing-service",) if i == 0 else ())

    rv = pr = None
    if reviews:
        p1 = [r for r in t.records if r["stage"] == "P1" and r["ticket"] == "X-rename" and r["spec"] == "S0"][:4]
        prs = [{"pr_id": f"pr-{i + 1:03d}", "run_id": r["run_id"], "stage": "P1", "unit": unit, "ticket": "X-rename",
                "category": "breaking" if i < 3 else "benign", "repeat_subsample": i < 2, "affected_consumers": []}
               for i, r in enumerate(p1)]
        pr = {"schema": "prset/1", "prs": prs, "shortfall": {"semantic": 10}}
        rv = []
        k = 0
        for p in prs:
            for cond in ("R-S0", "R-S2", "R-C"):
                reps = 3 if p["repeat_subsample"] and cond != "R-S2" else 1
                for rep in range(1, reps + 1):
                    k += 1
                    flagged = (cond == "R-C") or (rep == 1 and p["pr_id"] != "pr-003")
                    verdict = ("request_changes" if flagged else "approve") if p["category"] == "breaking" else \
                        ("approve" if cond != "R-S0" else "request_changes")
                    rv.append({"review_id": f"r{k}", "pr_id": p["pr_id"], "run_id": p["run_id"], "condition": cond, "rep": rep,
                               "verdict": verdict, "reasons": ["x"], "duration_ms": 4000 + 100 * k, "cost_usd": 0.02})
    t.write(unblinded=list(unblind), reviews=rv, pr_set=pr)
    if ns == "mock":  # keep the fixture's real-ns keys out of the way
        pass
    if mutation:
        write_mutation(root)
    return {"unit": unit, "records": t.records}


def write_mutation(root: Path, shape: str = "cells"):
    ms = {"ci_catch_oracle_catch": [f"rename-{i}" for i in range(40)] + [f"remove-{i}" for i in range(20)],
          "ci_catch_oracle_miss": ["tighten-enum-1", "tighten-enum-2"],
          "ci_miss_oracle_catch": ["units-x100-total", "units-div100-total", "currency-swap", "date-format-iso", "round-half-up"],
          "ci_miss_oracle_miss": ["array-reorder-1", "array-reorder-2", "noop-1"]}
    if shape == "cells":
        data = {"generated_at": "2026-10-11T08:00:00Z",
                "cells": {k: [{"id": m, "family": m.split("-")[0]} for m in v] for k, v in ms.items()}}
    else:
        data = {"mutants": [{"id": m, "family": m.split("-")[0], "ci_catches": k.startswith("ci_catch"),
                             "oracle_catches": k.endswith("oracle_catch")} for k, v in ms.items() for m in v]}
    write_json_atomic(root / "mutation-matrix.json", data)
    (root / "mutation-matrix.md").write_text("# Mutation matrix\n", encoding="utf-8")
    return ms


def fx_for(**kw):
    return ConsoleFixture(copy_real=("results",), **kw)


def get(fx, path, client=None):
    r = (client or fx.owner).get(path)
    assert r.status == 200, (path, r.status, r.text[:300])
    return r.json


def walk(o, path=()):
    if isinstance(o, dict):
        for k, v in o.items():
            yield path + (k,), v
            yield from walk(v, path + (k,))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            yield from walk(v, path + (i,))


# ---------------------------------------------------------------- tests

class RoutesAndRoles(unittest.TestCase):
    def test_plugin_loads_with_five_routes_for_every_role(self):
        with fx_for() as fx:
            seed_results(fx.results)
            plugins = {p["id"]: p for p in fx.owner.get("/api/plugins").json["plugins"]}
            self.assertEqual(plugins["results"]["order"], 3)
            self.assertEqual(plugins["results"]["name"], "Results")
            for role in ("viewer", "presenter"):
                c = fx.client(f"u-{role}", role)
                self.assertIn("results", {p["id"] for p in c.get("/api/plugins").json["plugins"]})
                for route in ("rq", "mutation", "reviewer", "excluded", "export"):
                    self.assertEqual(c.get(f"/api/results/{route}?ns=real").status, 200, (role, route))

    def test_read_only(self):
        with fx_for() as fx:
            fx.owner.session()
            r = fx.owner.post("/api/results/rq", {})
            self.assertIn(r.status, (403, 404, 405))

    def test_unknown_plugin_api_errors_do_not_leak_paths(self):
        with fx_for() as fx:
            for route in ("rq", "mutation", "reviewer", "excluded"):
                txt = fx.owner.get(f"/api/results/{route}?ns=real").text
                self.assertNotIn("C:\\Users", txt)
                self.assertNotIn("OAUTH", txt.upper())

    def test_empty_namespace_is_quiet(self):
        with fx_for() as fx:
            rq = get(fx, "/api/results/rq?ns=real")
            self.assertEqual(rq["stages"], [])
            for s in rq["sections"].values():
                self.assertIn(s["status"], ("empty", "blinded"))
                self.assertEqual(s["charts"], [])
            self.assertEqual(get(fx, "/api/results/excluded?ns=real")["excluded"], [])
            self.assertEqual(get(fx, "/api/results/reviewer?ns=real")["section"]["status"], "empty")


class Blinding(unittest.TestCase):
    def test_blinded_stage_returns_no_numbers_at_all(self):
        with fx_for() as fx:
            seed_results(fx.results, unblind=())  # P1 and P2 are complete but not unblinded
            rq = get(fx, "/api/results/rq?ns=real")
            text = json.dumps(rq)
            for sid in ("rq1", "rq2", "rq3"):
                sec = rq["sections"][sid]
                self.assertEqual(sec["status"], "blinded", sid)
                self.assertEqual(sec["charts"], [])
                self.assertEqual(sec["tables"], [])
                self.assertIn("P1", sec["blinded_stages"])
            self.assertIsNone(rq["sections"]["rq2"]["h2"])
            self.assertNotIn("X-rename", text)
            self.assertNotIn('"x":', text)
            self.assertNotIn('"ci"', text)
            self.assertTrue(all(not s["visible"] for s in rq["stages"] if s["stage"] in ("P1", "P2", "P4")))
            rev = get(fx, "/api/results/reviewer?ns=real")["section"]
            self.assertEqual(rev["status"], "blinded")
            self.assertEqual(rev["charts"], [])
            self.assertNotIn("pr-001", json.dumps(rev))
            conc = get(fx, "/api/results/mutation?ns=real")["concordance"]
            self.assertTrue(conc["empty"])
            self.assertEqual(sum(conc["tickets"].get("X-rename", {}).get(k, 0) for k in
                                 ("ci_break_oracle_break", "ci_ok_oracle_ok")), 0)
            r = fx.owner.get("/api/results/export?ns=real&chart=rq1.break&style=app")
            self.assertEqual((r.status, r.json["error"]), (409, "Blinded until stage complete"))

    def test_only_the_unblinded_stage_appears(self):
        with fx_for() as fx:
            seed_results(fx.results, unblind=("P1",))
            rq = get(fx, "/api/results/rq?ns=real")
            self.assertEqual(rq["sections"]["rq1"]["status"], "ok")
            for sec in rq["sections"].values():
                for c in sec["charts"]:
                    self.assertIn(", Main test (P1),", c["source"])
                    self.assertNotIn("P2", c["source"])
                    self.assertNotIn("P4", c["source"])
            self.assertIn("P2", rq["sections"]["rq3"]["blinded_stages"])
            self.assertIn("P4", rq["sections"]["rq1"]["blinded_stages"])
            self.assertNotIn("X-units", json.dumps(rq))  # P4 is blinded

    def test_unblinded_stage_in_another_namespace_does_not_leak(self):
        with fx_for() as fx:
            seed_results(fx.results, "mock", unblind=("P1", "P2"))
            seed_results(fx.results, "real", unblind=())
            self.assertEqual(get(fx, "/api/results/rq?ns=real")["sections"]["rq1"]["status"], "blinded")
            self.assertEqual(get(fx, "/api/results/rq?ns=mock")["sections"]["rq1"]["status"], "ok")


class Numbers(unittest.TestCase):
    def setUp(self):
        self.fx = fx_for().__enter__()
        self.addCleanup(self.fx.__exit__, None, None, None)
        seed_results(self.fx.results, unblind=("P1", "P2"))
        self.rq = get(self.fx, "/api/results/rq?ns=real")

    def chart(self, sid, cid):
        return next(c for c in self.rq["sections"][sid]["charts"] if c["id"] == cid)

    def test_rq1_x_of_n_with_clopper_pearson(self):
        rows = {(r["label"], r["sub"]): r for r in self.chart("rq1", "rq1.break")["rows"]}
        a = rows[("Rename two fields", "X-rename")]   # words first, the code after (labels.js via console/core/labels.py)
        self.assertEqual((a["x"], a["n"]), (7, 10))
        lo, hi = stats.clopper_pearson(7, 10)
        self.assertAlmostEqual(a["ci"][0], lo, places=3)
        self.assertAlmostEqual(a["ci"][1], hi, places=3)
        self.assertEqual(a["group"], "Main test (P1) · Claude Code + Sonnet")
        self.assertEqual((rows[("Remove a field", "X-remove")]["x"], rows[("Remove a field", "X-remove")]["n"]), (10, 10))
        self.assertEqual(len(rows), 2)  # only V0·S0 cells (the contaminated and infra runs are not in N)

    def test_three_boxes_add_up(self):
        c = self.chart("rq1", "rq1.boxes")
        self.assertEqual([s["key"] for s in c["series"]], ["done_safe", "done_breaks", "deprecated", "not_done"])
        row = next(r for r in c["rows"] if r["sub"] == "X-rename")
        vals = {s["key"]: s["value"] for s in row["segments"]}
        self.assertEqual((vals["done_safe"], vals["done_breaks"], vals["not_done"]), (3, 7, 0))
        self.assertTrue(all(sum(s["value"] for s in r["segments"]) == r["n"] for r in c["rows"]))
        box2 = self.chart("rq2", "rq2.boxes")
        rm = next(r for r in box2["rows"] if r["group"].endswith("Remove a field (X-remove)") and r["sub"] == "V0·S2")
        self.assertEqual(rm["label"], "Own repo · Rule in the spec")
        self.assertEqual({s["key"]: s["value"] for s in rm["segments"]}["deprecated"], 5)

    def test_p_values_only_on_pre_registered_tests(self):
        h2 = self.rq["sections"]["rq2"]["h2"]
        t = {x["ticket"]: x for x in h2["tickets"]}
        self.assertEqual((t["X-rename"]["s0"]["x"], t["X-rename"]["s2"]["x"]), (7, 1))
        p = stats.fisher_exact(7, 3, 1, 9)
        self.assertAlmostEqual(t["X-rename"]["p"], p, places=9)
        self.assertGreaterEqual(t["X-rename"]["p_holm"], t["X-rename"]["p"])
        self.assertLessEqual(t["X-rename"]["p_holm"], 1.0)
        # p keys appear only under the pre-registered tests: H2, the secondary HS-V2 and their replication
        for path, _ in walk(self.rq["sections"]):
            if path and path[-1] in ("p", "p_holm"):
                self.assertIn(path[:2], (("rq2", "h2"), ("rq2", "secondary_v2"), ("rq2", "replication")), path)
                if path[-1] == "p_holm":
                    self.assertNotEqual(path[:2], ("rq2", "secondary_v2"), path)   # HS-V2 is outside the Holm family
        # the H2 chart names the Holm p in a group header; descriptive charts do not mention p
        h2c = self.chart("rq2", "rq2.h2")
        self.assertTrue(all("Holm-adjusted p = " in r["group"] for r in h2c["rows"]))
        for sid, sec in self.rq["sections"].items():
            for c in sec["charts"]:
                if c["id"] == "rq2.h2":
                    continue
                blob = json.dumps(c)
                self.assertNotRegex(blob, r"\bp\s*[=<]", c["id"])
                self.assertNotIn("Fisher", blob, c["id"])

    def test_no_percentages_in_any_chart(self):
        for sec in self.rq["sections"].values():
            for c in sec["charts"]:
                blob = json.dumps(c, ensure_ascii=False).replace("95%", "")
                self.assertIsNone(re.search(r"\d\s?%", blob), c["id"])

    def test_rq2_descriptive_has_reference_and_contrast_cells(self):
        rows = self.chart("rq2", "rq2.break")["rows"]
        subs = {(r["group"].rsplit("(", 1)[-1].rstrip(")"), r["sub"]) for r in rows}
        self.assertIn(("X-rename", "V0·S0"), subs)
        self.assertIn(("X-rename", "V0·S2"), subs)
        self.assertNotIn(("X-rename", "V1·S0"), subs)
        r = next(r for r in rows if r["sub"] == "V0·S2")
        self.assertEqual(r["label"], "Own repo · Rule in the spec")

    def test_rq3_outcomes_and_v1(self):
        out = self.chart("rq3", "rq3.outcomes")
        self.assertTrue(all(sum(s["value"] for s in r["segments"]) == r["n"] for r in out["rows"]))
        gate = {(r["group"], r["label"], r["sub"]): r for r in self.chart("rq3", "rq3.gate")["rows"]}
        self.assertEqual(gate[("Main test (P1) · Claude Code + Sonnet · Rename two fields (X-rename)", "Own repo · No rule", "V0·S0")]["x"], 2)
        self.assertEqual(gate[("Pressure test (P2) · Claude Code + Sonnet · Remove a field (X-remove)",
                               "Contracts inside the repo · No rule", "V1·S0")]["x"], 2)
        v1 = self.chart("rq3", "rq3.v1")
        self.assertIn("V1", " ".join(r["group"] for r in v1["rows"]))
        self.assertEqual(self.rq["sections"]["rq3"]["tables"][0]["id"], "rq3.coding")

    def test_rq5_absent_without_data(self):
        self.assertNotIn("rq5", self.rq["sections"])
        self.assertEqual(self.rq["order"], ["rq1", "rq2", "rq3"])

    def test_source_note(self):
        c = self.chart("rq1", "rq1.break")
        self.assertEqual(c["source"], "Source: Agents vs. Gates, Main test (P1), Claude Code + Sonnet claude-sonnet-x, N=20, 12 Oct 2026")
        self.assertEqual(c["n_runs"], 20)
        self.assertFalse(c["simulated"])
        self.assertIsNone(c["banner"])
        both = self.chart("rq3", "rq3.gate")["source"]
        self.assertIn("Main test (P1), Pressure test (P2)", both)

    def test_excluded_and_infra(self):
        ex = get(self.fx, "/api/results/excluded?ns=real")
        self.assertEqual(len(ex["excluded"]), 1)
        self.assertIn("contaminated", ex["excluded"][0]["reasons"][0])
        self.assertEqual(ex["infra"]["by_stage"], {"P1": {"api_error": 1}})
        self.assertEqual(len(ex["infra"]["final"]), 1)

    def test_concordance_note_and_matrix(self):
        mu = get(self.fx, "/api/results/mutation?ns=real")
        co = mu["concordance"]
        self.assertIn("high by construction", co["note"].lower().replace("concordance is high by construction", "high by construction"))
        self.assertTrue(co["tickets"]["X-rename"]["by_construction"])
        chart = co["chart"]
        self.assertEqual(chart["kind"], "matrix")
        self.assertEqual(chart["footnote"], co["note"])
        p = next(p for p in chart["panels"] if p["title"] == "X-rename")
        self.assertEqual(p["note"], "high by construction")
        self.assertEqual(p["cells"][0][0]["count"], 8)  # 7 V0·S0 breaks + 1 V0·S2 break, all caught by the first CI

    def test_reviewer(self):
        r = get(self.fx, "/api/results/reviewer?ns=real")["section"]
        self.assertEqual(r["status"], "ok")
        acc = next(c for c in r["charts"] if c["id"] == "rq4.accuracy")
        rows = {(x["group"].rsplit("(", 1)[-1].rstrip(")"), x["label"]): x for x in acc["rows"]}
        self.assertTrue({x["group"] for x in acc["rows"]} >= {"Reviewer: no rule (R-S0)", "Reviewer: rule and contracts (R-C)"})
        sens = rows[("R-C", "Sensitivity")]
        self.assertEqual((sens["x"], sens["n"]), (3, 3))
        spec = rows[("R-S0", "Specificity")]
        self.assertEqual((spec["x"], spec["n"]), (0, 1))
        miss = next(c for c in r["charts"] if c["id"] == "rq4.miss")
        self.assertTrue(all(sum(s["value"] for s in x["segments"]) == x["n"] for x in miss["rows"]))
        self.assertTrue(any(x["n"] == 3 for x in miss["rows"]))
        cost = r["tables"][0]
        self.assertEqual({x["condition"] for x in cost["rows"]},
                         {"Reviewer: no rule (R-S0)", "Reviewer: rule in the spec (R-S2)", "Reviewer: rule and contracts (R-C)"})
        self.assertIn("ci_mean_duration_ms", cost["footer"])
        self.assertIn("semantic: 10", r["note"])
        self.assertIn("Source: Agents vs. Gates, Main test (P1),", miss["source"])


class MockWatermark(unittest.TestCase):
    def test_every_mock_chart_is_flagged_simulated(self):
        with fx_for() as fx:
            seed_results(fx.results, "mock", unblind=("P1", "P2"), mutation=True)
            rq = get(fx, "/api/results/rq?ns=mock")
            self.assertTrue(rq["simulated"])
            self.assertEqual(rq["banner"], "SIMULATED (mock agent) — not a real run")
            charts = [c for s in rq["sections"].values() for c in s["charts"]]
            charts += get(fx, "/api/results/reviewer?ns=mock")["section"]["charts"]
            mu = get(fx, "/api/results/mutation?ns=mock")
            charts += [mu["mutation"]["chart"], mu["concordance"]["chart"]]
            self.assertGreaterEqual(len(charts), 8)
            for c in charts:
                self.assertTrue(c["simulated"], c["id"])
                self.assertTrue(c["banner"], c["id"])
            self.assertIn("mock agent (SIMULATED)", charts[0]["source"])
            self.assertFalse(get(fx, "/api/results/rq?ns=mock")["sections"]["rq1"]["charts"][0]["source"].count("claude-"))

    @unittest.skipUnless(HAVE_NODE, "node not on PATH")
    def test_server_export_always_carries_the_watermark(self):
        with fx_for() as fx:
            seed_results(fx.results, "mock", unblind=("P1", "P2"), mutation=True)
            for chart in ("rq1.break", "rq2.h2", "rq3.outcomes", "mutation.matrix"):
                for style in ("app", "deck"):
                    r = fx.owner.get(f"/api/results/export?ns=mock&chart={chart}&style={style}&format=svg&watermark=off")
                    self.assertEqual(r.status, 200, (chart, style, r.text[:200]))
                    svg = r.text
                    self.assertIn(">MOCK<", svg)
                    self.assertIn("MOCK", svg)
                    self.assertIn('viewBox="0 0 1920 1080"', svg)
                    self.assertIn("Source: Agents vs. Gates", svg)
            self.assertIn("attachment", r.header("Content-Disposition"))
            self.assertEqual(r.header("Content-Type"), "image/svg+xml; charset=utf-8")


@unittest.skipUnless(HAVE_NODE, "node not on PATH")
class ServerExport(unittest.TestCase):
    def test_real_export_both_styles(self):
        with fx_for() as fx:
            seed_results(fx.results, "real", unblind=("P1", "P2"))
            app = fx.owner.get("/api/results/export?ns=real&chart=rq1.break&style=app")
            deck = fx.owner.get("/api/results/export?ns=real&chart=rq1.break&style=deck")
            self.assertEqual((app.status, deck.status), (200, 200))
            self.assertIn('width="1920" height="1080"', app.text)
            self.assertIn('fill="#ffffff"', app.text)
            self.assertIn('fill="#000000"', deck.text)
            self.assertIn("#E91E63", deck.text)
            self.assertIn("Graphik", deck.text)
            self.assertIn("data:font/woff2;base64,", app.text)  # IBM Plex Sans embedded for the PNG path
            self.assertNotIn("MOCK", app.text)
            self.assertIn("7 of 10", app.text)
            self.assertRegex(app.text, r'<text x="96" y="1034"[^>]*>Source: Agents vs\. Gates, Main test \(P1\), Claude Code \+ Sonnet claude-sonnet-x, N=20, 12 Oct 2026</text>')
            self.assertIn("rq1-break_app.svg", app.header("Content-Disposition"))

    def test_listing_and_errors(self):
        with fx_for() as fx:
            seed_results(fx.results, "real", unblind=("P1", "P2"), mutation=True)
            lst = get(fx, "/api/results/export?ns=real")
            ids = {c["id"] for c in lst["charts"]}
            self.assertTrue({"rq1.break", "rq1.boxes", "rq2.h2", "rq3.outcomes", "rq4.accuracy", "mutation.matrix",
                             "concordance.matrix"} <= ids)
            self.assertEqual(fx.owner.get("/api/results/export?ns=real&chart=rq1.break&style=neon").status, 400)
            png = fx.owner.get("/api/results/export?ns=real&chart=rq1.break&format=png")
            self.assertEqual(png.status, 400)
            self.assertIn("browser", png.json["error"])
            self.assertEqual(fx.owner.get("/api/results/export?ns=real&chart=nope.x").status, 404)
            self.assertEqual(fx.owner.get("/api/results/export?ns=real&chart=../../etc").status, 400)
            self.assertEqual(fx.owner.get("/api/results/export?ns=real&chart=rq5.break").status, 404)  # no W2 data


class MutationMatrix(unittest.TestCase):
    def test_absent_names_the_command(self):
        with fx_for() as fx:
            m = get(fx, "/api/results/mutation?ns=real")["mutation"]
            self.assertFalse(m["present"])
            self.assertEqual(m["command"], "python -m oracle.mutation")
            self.assertIsNone(m["chart"])

    def test_namespace_free(self):
        with fx_for() as fx:
            write_mutation(fx.results)
            a = get(fx, "/api/results/mutation?ns=real")["mutation"]
            b = get(fx, "/api/results/mutation?ns=mock")["mutation"]
            self.assertEqual(a["cells"], b["cells"])
            self.assertEqual(a["total"], 70)

    def test_both_file_shapes(self):
        for shape in ("cells", "mutants"):
            with fx_for() as fx:
                ms = write_mutation(fx.results, shape)
                m = get(fx, "/api/results/mutation?ns=real")["mutation"]
                self.assertTrue(m["present"])
                self.assertEqual({k: v["count"] for k, v in m["cells"].items()}, {k: len(v) for k, v in ms.items()}, shape)
                self.assertEqual(m["cells"]["ci_miss_oracle_catch"]["mutants"][0]["id"], "units-x100-total")
                self.assertIn("units", {f["family"] for f in m["families"]})
                grid = m["chart"]["panels"][0]["cells"]
                self.assertEqual([[c["count"] for c in row] for row in grid], [[60, 2], [5, 3]])
                self.assertEqual(grid[1][0]["tone"], "fail")  # what CI does not see

    def test_markdown_only_fallback(self):
        with fx_for() as fx:
            (fx.results / "mutation-matrix.md").write_text("# m\n", encoding="utf-8")
            m = get(fx, "/api/results/mutation?ns=real")["mutation"]
            self.assertEqual(m["markdown"], "# m\n")
            self.assertIsNone(m["chart"])


class Rq5AndCsp(unittest.TestCase):
    def test_rq5_pairs_w2_with_its_w1_cell(self):
        with fx_for() as fx:
            t = ResultsTree()
            t.tmp, t.ns_dir = fx.results, fx.results / "real"
            t.records, t.manifest_runs, t.state_runs = [], [], {}
            for i in range(5):
                t.add(record(f"p1-{i:04d}", "P1", "X-rename", "V0", "S0", broken=("billing-service",) if i < 4 else ()))
                t.add(record(f"p5-{i:04d}", "P5", "X-rename", "V0", "S0", W="W2", broken=("billing-service",) if i < 1 else ()))
            t.write(unblinded=["P1", "P5"])
            rq = get(fx, "/api/results/rq?ns=real")
            self.assertEqual(rq["order"][-1], "rq5")
            rows = rq["sections"]["rq5"]["charts"][0]["rows"]
            self.assertEqual([(r["label"], r["sub"], r["x"], r["n"]) for r in rows], [("Ticket as written", "W1 · P1", 4, 5), ("Ticket asks not to break consumers", "W2 · P5", 1, 5)])

    def test_rq5_blinded_when_p5_is_not_unblinded(self):
        with fx_for() as fx:
            t = ResultsTree()
            t.tmp, t.ns_dir = fx.results, fx.results / "real"
            t.records, t.manifest_runs, t.state_runs = [], [], {}
            t.add(record("p5-0001", "P5", "X-rename", "V0", "S0", W="W2"))
            t.write(unblinded=[])
            sec = get(fx, "/api/results/rq?ns=real")["sections"]["rq5"]
            self.assertEqual((sec["status"], sec["charts"]), ("blinded", []))

    def test_core_csp_allows_the_png_path(self):
        # The PNG is drawn in the browser: SVG → blob: URL → <img> → canvas.toBlob → download via a blob: link.
        csp = server.CSP
        self.assertIn("script-src 'self'", csp)
        self.assertIn("img-src 'self' data: blob:", csp)
        self.assertIn("font-src 'self' data:", csp)
        self.assertIn("connect-src 'self'", csp)  # fetch() of /web/fonts/*.woff2 to embed the font


class Misc(unittest.TestCase):
    def test_format_window(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("results_payload_t", PLUGIN / "payload.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        fw = mod.format_window
        self.assertEqual(fw("2026-10-12T09:00:00Z", "2026-10-12T17:00:00Z"), "12 Oct 2026")
        self.assertEqual(fw("2026-10-12T09:00:00Z", "2026-10-14T17:00:00Z"), "12–14 Oct 2026")
        self.assertEqual(fw("2026-10-28T09:00:00Z", "2026-11-02T17:00:00Z"), "28 Oct – 2 Nov 2026")
        self.assertEqual(fw("2026-12-30T09:00:00Z", "2027-01-02T17:00:00Z"), "30 Dec 2026 – 2 Jan 2027")
        self.assertEqual(fw(None, None), "dates n/a")

    @unittest.skipUnless(HAVE_NODE, "node not on PATH")
    def test_node_chart_tests_pass(self):
        r = subprocess.run(["node", "--test", str(PLUGIN / "web" / "charts.test.mjs")], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout[-1500:] + r.stderr[-500:])


if __name__ == "__main__":
    unittest.main()
