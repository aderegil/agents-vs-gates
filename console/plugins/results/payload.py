"""Results plugin: turns `analysis.summarize.aggregate(ns)` into per-question sections and chart specs (spec 22.3).

No statistics are computed here: every x, N, interval, Holm p and count comes from `aggregate` (WP2). This module only
selects, groups and labels. What it adds on its own, because `aggregate` does not carry it:
  - RQ5 (W2 cells next to their W1 counterparts), picked from `aggregate()["cells"]`;
  - the source-note data (model ids and date window of the visible stages), read from the archived records;
  - the mutation matrix (`results/mutation-matrix.json`, namespace-free).

Blinding: `aggregate` already withholds cells, boxes, H2 and reviewer numbers of a stage that is not unblinded. This
module re-checks every row against `state.unblinded` and drops anything from a blinded stage (defence in depth), and a
section whose stages are all blinded carries `status: "blinded"` and no numbers at all.

A chart spec is plain JSON, rendered by web/charts.js in the browser and by `web/render-cli.mjs` for the server-side
SVG export. Kinds: `interval` (point + interval per row), `stacked` (counts per row) and `matrix` (2×2 panels).
"""
from __future__ import annotations

from collections import defaultdict

from analysis import common, summarize
from harness import blinding, jsonio, paths

MUTATION_COMMAND = "python -m oracle.mutation"
SIM = common.SIM_BANNER

# Which research questions each stage feeds (spec 11.2). Used only to say which blinded stages hide which section.
STAGE_FEEDS = {
    "P1": ("rq1", "rq2", "rq3"), "P2": ("rq3",), "P3": ("rq4",), "P4": ("rq1", "rq2", "rq3"),
    "P5": ("rq1", "rq2", "rq3", "rq5"), "P6": ("rq1", "rq2", "rq3"),
}

UNIT_LABEL = {"cc-sonnet": "Claude Code + Sonnet", "cc-opus": "Claude Code + Opus", "codex": "Codex",
              "gemini": "Gemini", "mock": "mock agent (SIMULATED)"}

QUESTIONS = {
    "rq1": ("RQ1", "Do agents break what they cannot see?"),
    "rq2": ("RQ2", "Does a spec that names the consumers prevent it?"),
    "rq3": ("RQ3", "When CI says no, do agents fix the code or touch the gate?"),
    "rq4": ("RQ4", "Can an AI reviewer catch what CI catches? (grading vs. gating)"),
    "rq5": ("RQ5", "Does the way the story is written change the outcome?"),
}

BOX_SERIES = [
    {"key": "done_safe", "label": "Done & safe", "tone": "pass"},
    {"key": "done_breaks", "label": "Done & breaks", "tone": "fail"},
    {"key": "deprecated", "label": "Deprecated (not removed)", "tone": "n2"},
    {"key": "not_done", "label": "Not done", "tone": "n4"},
]
OUTCOME_SERIES = [
    {"key": "passed_first_ci", "label": "Passed first CI", "tone": "pass-soft"},
    {"key": "fixed_code", "label": "Fixed the code", "tone": "pass"},
    {"key": "passed_with_gate_flag", "label": "Passed, gate touched", "tone": "fail-soft"},
    {"key": "fixed_with_gate_flag", "label": "Fixed, gate touched", "tone": "fail"},
    {"key": "honest_escalation_candidate", "label": "Escalation candidate", "tone": "n1"},
    {"key": "capped", "label": "Hit the cap", "tone": "n2"},
    {"key": "still_failing", "label": "Still failing", "tone": "n3"},
    {"key": "no_change", "label": "No change", "tone": "n4"},
]
NEEDS_NO_REPAIR = ("passed_first_ci", "no_change")
SECONDARY = (("consumer_break_ci", "Consumer break in CI"), ("semantic_break", "Semantic break"),
             ("undeclared_dependency", "Undeclared dependency"), ("arch_layer_violation", "Layer violation"),
             ("arch9_signal", "ARCH-9 signal"))
COND_LABEL = {"R-S0": "R-S0 · reviewer sees S0", "R-S2": "R-S2 · reviewer sees S2",
              "R-C": "R-C · S2 + consumer contracts"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------- small helpers

def _sub(c: dict) -> str:
    s = f"{c.get('V', '?')}·{c.get('S', '?')}"
    return s if c.get("W", "W1") == "W1" else f"{s}·{c['W']}"


def _group(c: dict) -> str:
    return f"{c['stage']} · {c.get('unit', '?')}"


def _fmt_p(p) -> str:
    if p is None:
        return "—"
    return "<0.001" if p < 0.001 else f"{p:.3f}"


def _day(iso: str | None):
    if not iso or len(iso) < 10:
        return None
    try:
        return int(iso[0:4]), int(iso[5:7]), int(iso[8:10])
    except ValueError:
        return None


def format_window(a: str | None, b: str | None) -> str:
    da, db = _day(a), _day(b) or _day(a)
    if not da:
        return "dates n/a"
    db = db or da
    if da == db:
        return f"{da[2]} {MONTHS[da[1] - 1]} {da[0]}"
    if da[:2] == db[:2]:
        return f"{da[2]}–{db[2]} {MONTHS[da[1] - 1]} {da[0]}"
    ya = f" {da[0]}" if da[0] != db[0] else ""
    return f"{da[2]} {MONTHS[da[1] - 1]}{ya} – {db[2]} {MONTHS[db[1] - 1]} {db[0]}"


def _stage_key(s: str) -> int:
    return summarize.STAGE_ORDER.index(s) if s in summarize.STAGE_ORDER else len(summarize.STAGE_ORDER)


class Build:
    """One computation of the whole payload for a namespace."""

    def __init__(self, ns: str):
        self.ns = ns
        self.simulated = ns == "mock"
        self.agg = summarize.aggregate(ns)
        self.state = common.load_state(ns)
        self.records = common.load_records(ns)
        self.stage_visible = {s: bool(v["visible"]) for s, v in self.agg["stages"].items()}
        self.blinded_stages = [s for s, v in self.agg["stages"].items()
                               if not v["visible"] and v.get("runs_total") is not None]
        # source-note facts of the visible stages only (dates and model ids are not outcomes)
        self.windows: dict[str, list] = {}
        self.models: dict[tuple, set] = defaultdict(set)
        for r in self.records:
            st = r.get("stage")
            if not blinding.is_visible(self.state, st):
                continue
            w = self.windows.setdefault(st, [None, None])
            if r.get("started_at") and (w[0] is None or r["started_at"] < w[0]):
                w[0] = r["started_at"]
            if r.get("ended_at") and (w[1] is None or r["ended_at"] > w[1]):
                w[1] = r["ended_at"]
            if r.get("model_reported") and r.get("unit"):
                self.models[(st, r["unit"])].add(r["model_reported"])

    # ------------------------------------------------------------ visibility

    def visible(self, stage) -> bool:
        return blinding.is_visible(self.state, stage)

    def cells(self) -> list[dict]:
        return [c for c in self.agg["cells"] if self.visible(c["stage"])]

    def boxes(self) -> dict:
        return {(b["stage"], b["cell"]): b for b in self.agg["three_box"] if self.visible(b["stage"])}

    # ------------------------------------------------------------ chart plumbing

    def source(self, pairs, n: int) -> str:
        """pairs: iterable of (stage, unit). → 'Source: Agents vs. Gates, P1, Claude Code + Sonnet <id>, N=…, <dates>'."""
        stages = sorted({s for s, _ in pairs}, key=_stage_key)
        units = sorted({u for _, u in pairs})
        who = []
        for u in units:
            ids = sorted({m for (s, uu), ms in self.models.items() if uu == u and s in stages for m in ms})
            label = UNIT_LABEL.get(u, u)
            who.append(label if u == "mock" or not ids else f"{label} {', '.join(ids)}")
        lo = [self.windows[s][0] for s in stages if s in self.windows and self.windows[s][0]]
        hi = [self.windows[s][1] for s in stages if s in self.windows and self.windows[s][1]]
        window = format_window(min(lo) if lo else None, max(hi) if hi else None)
        return f"Source: Agents vs. Gates, {', '.join(stages) or 'no stage'}, {' / '.join(who) or 'no unit'}, N={n}, {window}"

    def finish(self, spec: dict, cells=(), pairs=None, n: int | None = None) -> dict:
        pairs = list(pairs) if pairs is not None else sorted({(c["stage"], c.get("unit", "?")) for c in cells})
        if n is None:
            seen = {(c["stage"], c["cell"]): c["n"] for c in cells}
            n = sum(seen.values())
        spec["n_runs"] = n
        spec["source"] = self.source(pairs, n)
        spec["simulated"] = self.simulated
        spec["banner"] = SIM if self.simulated else None
        return spec

    def interval(self, cid, title, subtitle, rows, cells, tone="fail", axis="share of runs", **kw) -> dict | None:
        rows = [r for r in rows if r.get("n")]
        if not rows:
            return None
        return self.finish({"id": cid, "kind": "interval", "title": title, "subtitle": subtitle, "tone": tone,
                            "axis": axis, "rows": rows, **kw}, cells)

    def stacked(self, cid, title, subtitle, series, rows, cells, **kw) -> dict | None:
        rows = [r for r in rows if r.get("n")]
        if not rows:
            return None
        return self.finish({"id": cid, "kind": "stacked", "title": title, "subtitle": subtitle, "series": series,
                            "rows": rows, **kw}, cells)

    @staticmethod
    def metric_rows(cells, metric, tone=None):
        out = []
        for c in cells:
            m = (c.get("metrics") or {}).get(metric)
            if m and m["n"]:
                out.append({"group": _group(c), "label": c["ticket"], "sub": _sub(c), "x": m["x"], "n": m["n"],
                            "ci": m["ci"], **({"tone": tone} if tone else {})})
        return out

    def box_rows(self, cells, series):
        boxes = self.boxes()
        rows = []
        for c in cells:
            b = boxes.get((c["stage"], c["cell"]))
            if b and b["n"]:
                rows.append({"group": _group(c), "label": c["ticket"], "sub": _sub(c), "n": b["n"],
                             "segments": [{"key": s["key"], "value": b[s["key"]]} for s in series]})
        return rows

    def section(self, rid: str, *, descriptive: bool = True, note: str = "", charts=(), tables=(), **extra) -> dict:
        code, question = QUESTIONS[rid]
        charts = [c for c in charts if c]
        blinded = [s for s in self.blinded_stages if rid in STAGE_FEEDS.get(s, ())]
        status = "ok" if charts else ("blinded" if blinded else "empty")
        return {"id": rid, "code": code, "question": question, "descriptive": descriptive, "note": note,
                "status": status, "blinded_stages": blinded, "charts": charts, "tables": [t for t in tables if t],
                **extra}

    # ------------------------------------------------------------ RQ1, RQ2, RQ3, RQ5

    def rq1(self) -> dict:
        cells = [c for c in self.cells() if c.get("V") == "V0" and c.get("S") == "S0" and c.get("W") == "W1"]
        brk = self.interval("rq1.break", "Staging break with nothing in view (V0·S0)",
                            "Runs where a deployed consumer failed the staging oracle · x of N, 95% Clopper-Pearson interval",
                            self.metric_rows(cells, "staging_break"), cells, tone="fail")
        boxes = self.stacked("rq1.boxes", "Did the ticket, and did it break anything? (V0·S0)",
                             "Runs per box · bars show each cell's share, numbers are runs",
                             BOX_SERIES, self.box_rows(cells, BOX_SERIES), cells)
        sec_rows = []
        for c in cells:
            row = {"cell": f"{c['stage']} · {c['ticket']} {_sub(c)} · {c['unit']}"}
            for key, _ in SECONDARY:
                m = c["metrics"].get(key)
                row[key] = f"{m['x']} of {m['n']}" if m and m["n"] else "—"
            sec_rows.append(row)
        table = {"id": "rq1.secondary", "title": "Secondary metrics (x of N runs)",
                 "columns": [{"key": "cell", "label": "Cell"}] + [{"key": k, "label": l, "num": True} for k, l in SECONDARY],
                 "rows": sec_rows} if sec_rows else None
        return self.section("rq1", note="Descriptive: counts and intervals, no p-values. Primary metric: staging_break, "
                            "measured by the oracle, not by CI.", charts=[brk, boxes], tables=[table])

    def rq2(self) -> dict:
        h2 = self.agg["rq2"]["h2"]
        h2_info, h2_chart = None, None
        if not h2.get("blinded"):
            tickets = []
            rows, hcells = [], []
            for t, v in h2["tickets"].items():
                tickets.append({"ticket": t, "s0": v["s0"], "s2": v["s2"], "p": v["p"], "p_holm": v["p_holm"]})
                head = f"{t} · Fisher exact, Holm-adjusted p = {_fmt_p(v['p_holm'])}" if v["p_holm"] is not None else t
                for lab, key in (("V0·S0", "s0"), ("V0·S2", "s2")):
                    m = v[key]
                    if m["n"]:
                        rows.append({"group": head, "label": lab, "sub": "", "x": m["x"], "n": m["n"], "ci": m["ci"]})
            unit = common.PRIMARY_UNIT[self.ns]
            hcells = [{"stage": h2["stage"], "cell": f"{t}|H2", "n": max(v["s0"]["n"], 0) + max(v["s2"]["n"], 0),
                       "unit": unit} for t, v in h2["tickets"].items()]
            h2_chart = self.interval("rq2.h2", "H2: does naming the consumers (S2) prevent the break?",
                                     "staging_break, V0·S0 vs. V0·S2 · one pre-registered contrast per ticket · "
                                     "Fisher exact two-sided, Holm over the two tickets", rows, hcells, tone="fail")
            h2_info = {"stage": h2["stage"], "note": h2.get("note"), "tickets": tickets, "unit": unit}
        # descriptive comparisons: every W1 cell with S1/S2 or V2, next to the V0·S0 cell of the same ticket
        allc = [c for c in self.cells() if c.get("W") == "W1" and c.get("V") in ("V0", "V2")]
        contrast = [c for c in allc if c.get("S") in ("S1", "S2") or c.get("V") == "V2"]
        keys = {(c["stage"], c["ticket"], c["unit"]) for c in contrast}
        cells = [c for c in allc if (c["stage"], c["ticket"], c["unit"]) in keys
                 and (c in contrast or (c["V"] == "V0" and c["S"] == "S0"))]
        brk = self.interval("rq2.break", "Staging break by what the agent is told or shown",
                            "V0·S0 next to V0·S1, V0·S2 and V2·S0 (the agent sees the consumers) · descriptive, no p-values",
                            self.metric_rows(cells, "staging_break"), cells, tone="fail")
        boxes = self.stacked("rq2.boxes", "Did the ticket, and did it break anything? (S and V contrasts)",
                             "Runs per box · bars show each cell's share, numbers are runs",
                             BOX_SERIES, self.box_rows(cells, BOX_SERIES), cells)
        note = ("Only pre-registered tests carry p-values: H2 (Holm-corrected) and the secondary HS-V2 (uncorrected, "
                "outside the Holm family), on the primary unit and again on the replication unit. Everything else here "
                "is descriptive. \"Differs between units\" is claimed only with p < 0.05 on a pre-registered test.")
        sec = self.section("rq2", descriptive=False, note=note, charts=[h2_chart, brk, boxes], h2=h2_info,
                           secondary_v2=self.secondary_v2(), replication=self.replication())
        if h2.get("blinded") and sec["status"] == "empty":
            sec["status"] = "blinded"
            sec["blinded_stages"] = sorted(set(sec["blinded_stages"]) | {h2["stage"]}, key=_stage_key)
        return sec

    @staticmethod
    def _v2_rows(tickets: dict) -> list[dict]:
        return [{"ticket": t, "v0": v["v0"], "v2": v["v2"], "p": v["p"]} for t, v in tickets.items()]

    @staticmethod
    def _h2_rows(tickets: dict) -> list[dict]:
        return [{"ticket": t, "s0": v["s0"], "s2": v["s2"], "p": v["p"], "p_holm": v["p_holm"]} for t, v in tickets.items()]

    def secondary_v2(self) -> dict | None:
        """HS-V2 on the primary unit (pre-registered secondary, uncorrected), straight from `aggregate`."""
        s = self.agg["rq2"].get("secondary_v2") or {}
        if not s or s.get("blinded") or not self.visible(s.get("stage")):
            return None
        return {"label": s["label"], "stage": s["stage"], "unit": common.PRIMARY_UNIT[self.ns], "note": s.get("note"),
                "available": bool(s.get("available")), "tickets": self._v2_rows(s.get("tickets") or {})}

    def replication(self) -> dict | None:
        """H2 and HS-V2 again on the replication unit (P6's P1 part, its own Holm family), never pooled: from
        `aggregate`. A blinded P6 carries no numbers; no P6 in the manifest → None."""
        r = self.agg["rq2"].get("replication") or {}
        if not r or r.get("stage") not in self.agg["stages"]:
            return None
        out = {k: r.get(k) for k in ("label", "unit", "stage", "part", "blinded", "note", "available")}
        visible = not r.get("blinded") and self.visible(r.get("stage"))
        out["blinded"] = not visible
        out["h2"] = self._h2_rows(r.get("h2") or {}) if visible else []
        out["secondary_v2"] = self._v2_rows(r.get("secondary_v2") or {}) if visible else []
        return out

    V1_METRICS = (("staging_break", "Oracle breaks a consumer (gen)"), ("staging_break_final", "Oracle breaks a consumer (final PR)"),
                  ("consumer_break_ci", "First CI breaks a consumer"), ("semantic_break", "Semantic break (oracle fails, CI passes)"),
                  ("gate_flagged", "Gate touched (detector flag)"))

    def v1_units(self) -> dict | None:
        """X-remove V1·S0 for every unit that ran it (P2 on the primary unit, P6's P2 part on the replication unit),
        side by side. Descriptive: counts and intervals, no test, nothing pooled."""
        cells = sorted([c for c in self.cells() if (c.get("ticket"), c.get("V"), c.get("S"), c.get("W")) ==
                        ("X-remove", "V1", "S0", "W1")], key=lambda c: (_stage_key(c["stage"]), c.get("unit", "")))
        if len(cells) < 2:
            return None
        outs = {(o["stage"], o["cell"]): o["counts"] for o in self.agg["rq3"]["outcomes"] if self.visible(o["stage"])}
        cols = [{"key": f"c{i}", "stage": c["stage"], "unit": c.get("unit"), "n": c["n"]} for i, c in enumerate(cells)]
        rows = []
        for key, label in self.V1_METRICS:
            row = {"measure": label}
            for col, c in zip(cols, cells):
                m = (c.get("metrics") or {}).get(key)
                row[col["key"]] = m if m and m.get("n") else None
            rows.append(row)
        for s in OUTCOME_SERIES:
            vals = [outs.get((c["stage"], c["cell"]), {}).get(s["key"], 0) for c in cells]
            if any(vals):
                rows.append({"measure": f"Outcome: {s['label']}", "count": True,
                             **{col["key"]: {"x": v, "n": col["n"]} for col, v in zip(cols, vals)}})
        return {"id": "rq3.v1_units", "title": "X-remove V1·S0 on each unit, side by side",
                "note": "Descriptive: the same cell run on each unit (P2 on the primary unit, P6's P2 part on the "
                        "replication unit). Counts and 95% intervals, no test, nothing pooled.",
                "columns": cols, "rows": rows,
                "source": self.source([(c["stage"], c.get("unit", "?")) for c in cells], sum(c["n"] for c in cells))}

    def rq3(self) -> dict:
        out = {o["cell"] + "|" + o["stage"]: o for o in self.agg["rq3"]["outcomes"] if self.visible(o["stage"])}
        cells = []
        for c in self.cells():
            o = out.get(c["cell"] + "|" + c["stage"])
            if o and any(k not in NEEDS_NO_REPAIR and v for k, v in o["counts"].items()):
                cells.append(c)
        gate = self.interval("rq3.gate", "Gate touched while repairing",
                             "Runs flagged by a gate-manipulation detector (T1–T3 coded blind) · x of N, 95% interval",
                             self.metric_rows(cells, "gate_flagged"), cells, tone="fail")
        rows = []
        for c in cells:
            o = out[c["cell"] + "|" + c["stage"]]
            rows.append({"group": _group(c), "label": c["ticket"], "sub": _sub(c), "n": o["n"],
                         "segments": [{"key": s["key"], "value": o["counts"].get(s["key"], 0)} for s in OUTCOME_SERIES]})
        outcomes = self.stacked("rq3.outcomes", "What the agent did after CI said no",
                                "Runs per repair outcome · numbers are runs", OUTCOME_SERIES, rows, cells)
        v1 = [r for r in self.agg["rq3"]["v1_vs_v0s2"] if self.visible(r["stage"])]
        vrows, vcells = [], []
        by_cell = {(c["stage"], c["cell"]): c for c in self.cells()}
        for r in v1:
            c = by_cell.get((r["stage"], r["cell"]))
            if not c:
                continue
            vcells.append(c)
            for lab, key, tone in (("First CI breaks a consumer", "consumer_break_ci", "n1"),
                                   ("Oracle breaks a consumer", "staging_break", "fail")):
                m = r[key]
                if m["n"]:
                    vrows.append({"group": f"{c['ticket']} {_sub(c)} · {c['stage']} · {c['unit']}", "label": lab,
                                  "sub": "", "x": m["x"], "n": m["n"], "ci": m["ci"], "tone": tone})
        v1chart = self.interval("rq3.v1", "V1 gives the agent CI's own information",
                                "First-CI consumer break and oracle break, V1 next to V0·S2 · x of N, 95% interval",
                                vrows, vcells, tone="fail")
        cd = self.agg["rq3"]["coding"]
        coding = {"id": "rq3.coding", "title": "Blind coding of gate-flagged runs (runs)",
                  "columns": [{"key": k, "label": l, "num": True} for k, l in
                              (("T2", "T2 edited the check"), ("T3", "T3 weakened the contract"),
                               ("T1", "T1 benign (reported apart)"), ("honest_escalation", "Honest escalation"),
                               ("none", "None"), ("uncoded", "Not coded yet"))],
                  "rows": [{k: cd.get(k, 0) for k in ("T1", "T2", "T3", "honest_escalation", "none", "uncoded")}]}
        any_flag = sum(cd.values()) > 0
        return self.section("rq3", note="Descriptive. Cells where every run passed the first CI are left out: there was "
                            "nothing to repair. V1 is the arm in which the agent has the same information as CI.",
                            charts=[gate, outcomes, v1chart], tables=[coding if any_flag else None],
                            v1_units=self.v1_units())

    def rq5(self) -> dict | None:
        cells = self.cells()
        w2 = [c for c in cells if c.get("W") == "W2"]
        blinded = [s for s in self.blinded_stages if "rq5" in STAGE_FEEDS.get(s, ())]
        if not w2 and not blinded:
            return None
        rows_cells = []
        for c in w2:
            ref = [d for d in cells if d.get("W") == "W1" and (d["ticket"], d["V"], d["S"], d["unit"]) ==
                   (c["ticket"], c["V"], c["S"], c["unit"])]
            ref.sort(key=lambda d: _stage_key(d["stage"]))
            rows_cells += ref[:1] + [c]
        rows = []
        for c in rows_cells:
            m = c["metrics"].get("staging_break")
            if m and m["n"]:
                rows.append({"group": f"{c['ticket']} {c['V']}·{c['S']} · {c['unit']}", "label": c.get("W", "W1"),
                             "sub": c["stage"], "x": m["x"], "n": m["n"], "ci": m["ci"]})
        brk = self.interval("rq5.break", "Staging break by ticket wording (W1 vs. W2)",
                            "W2 states the outcome the ticket wants instead of the mechanical change · descriptive, "
                            "no p-values", rows, rows_cells, tone="fail")
        return self.section("rq5", note="Exploratory. Descriptive counts and intervals only.", charts=[brk])

    # ------------------------------------------------------------ RQ4

    def rq4(self) -> dict:
        r4 = self.agg["rq4"]
        pr_set = common.load_pr_set(self.ns) or {}
        pr_stages = sorted({p.get("stage") for p in pr_set.get("prs", []) if p.get("stage")}, key=_stage_key)
        hidden = [s for s in pr_stages if not self.visible(s) and s in self.agg["stages"]]
        if not r4["available"]:
            sec = self.section("rq4", note="Diff-only reviewer, one tool-less call per PR and condition.")
            sec["blinded_stages"] = hidden or sec["blinded_stages"]
            sec["status"] = "blinded" if sec["blinded_stages"] else "empty"
            sec["empty_hint"] = (f"python -m analysis.build_pr_set --ns {self.ns}  then  "
                                 f"python -m harness.reviewer --ns {self.ns}" + (" --mock" if self.simulated else ""))
            return sec
        conds = r4["conditions"]
        rows = []
        n_reviews = 0
        for cond, v in conds.items():
            n_reviews += v["reviews"]
            g = COND_LABEL.get(cond, cond)
            for lab, key, sub in (("Sensitivity", "sensitivity", "breaking PRs flagged"),
                                  ("… with the right reason", "sensitivity_correct_reason", "names the affected consumer"),
                                  ("Specificity", "specificity", "benign PRs approved")):
                m = v.get(key)
                if m and m["n"]:
                    rows.append({"group": g, "label": lab, "sub": sub, "x": m["x"], "n": m["n"], "ci": m["ci"],
                                 "tone": "pass-soft" if key == "sensitivity_correct_reason" else "pass"})
        pairs = [(s, u) for s, u in {(p.get("stage"), p.get("unit")) for p in pr_set.get("prs", [])
                                     if self.visible(p.get("stage"))} if s and u]
        acc = self.interval("rq4.accuracy", "Reviewer sensitivity and specificity (first review of each PR)",
                            "Sensitivity: breaking or semantic PRs the reviewer sent back · Specificity: benign PRs it "
                            "approved · x of N, 95% interval", rows, [], tone="pass")
        if acc:
            self.finish(acc, pairs=pairs, n=n_reviews)
        mrows = []
        for m in sorted(r4["miss_rate"], key=lambda m: (m["condition"], m["pr_id"])):
            caught = m["reps"] - m["misses"]
            mrows.append({"group": COND_LABEL.get(m["condition"], m["condition"]), "label": m["pr_id"], "sub": "",
                          "n": m["reps"], "segments": [{"key": "caught", "value": caught}, {"key": "missed", "value": m["misses"]}]})
        miss = self.stacked("rq4.miss", "Miss rate per PR across repeated reviews",
                            "Breaking PRs reviewed several times · grading varies, a gate would not · numbers are reviews",
                            [{"key": "caught", "label": "Sent back", "tone": "pass"},
                             {"key": "missed", "label": "Approved (missed)", "tone": "fail"}], mrows, [])
        if miss:
            self.finish(miss, pairs=pairs, n=sum(r["n"] for r in mrows))
        cost_rows = []
        for cond, v in conds.items():
            cost_rows.append({"condition": COND_LABEL.get(cond, cond), "reviews": v["reviews"], "errors": v["errors"],
                              "latency": v["mean_duration_ms"], "cost": v["mean_cost_usd"]})
        cost = {"id": "rq4.cost", "title": "Cost and latency per review, next to CI",
                "columns": [{"key": "condition", "label": "Condition"}, {"key": "reviews", "label": "Reviews", "num": True},
                            {"key": "errors", "label": "Errors", "num": True},
                            {"key": "latency", "label": "Mean latency", "num": True, "fmt": "ms"},
                            {"key": "cost", "label": "Mean cost (USD, nominal)", "num": True, "fmt": "usd"}],
                "rows": cost_rows, "footer": {"ci_mean_duration_ms": r4["ci_mean_duration_ms"]}}
        short = r4.get("shortfall") or {}
        note = "Diff-only reviewer, one tool-less call per PR and condition. Descriptive."
        if short:
            note += " PR-set shortfall: " + ", ".join(f"{k}: {v}" for k, v in short.items()) + "."
        sec = self.section("rq4", note=note, charts=[acc, miss], tables=[cost])
        sec["blinded_stages"] = hidden or sec["blinded_stages"]
        if not sec["charts"]:  # every reviewed PR comes from a blinded stage: no numbers, not even the cost table
            sec["tables"] = []
            sec["status"] = "blinded" if sec["blinded_stages"] else "empty"
        return sec

    # ------------------------------------------------------------ instrument validity: mutation + concordance

    def concordance(self) -> dict:
        conc = {t: v for t, v in self.agg["concordance"].items()}
        panels = []
        for t, v in conc.items():
            total = sum(v[k] for k in ("ci_break_oracle_break", "ci_break_oracle_ok", "ci_ok_oracle_break", "ci_ok_oracle_ok"))
            if not total:
                continue
            panels.append({"title": t, "note": "high by construction" if v["by_construction"] else "",
                           "total": total,
                           "cells": [[{"count": v["ci_break_oracle_break"], "tone": "n3"},
                                      {"count": v["ci_break_oracle_ok"], "tone": "n4"}],
                                     [{"count": v["ci_ok_oracle_break"], "tone": "fail"},
                                      {"count": v["ci_ok_oracle_ok"], "tone": "n4"}]]})
        chart = None
        if panels:
            chart = self.finish({"id": "concordance.matrix", "kind": "matrix",
                                 "title": "CI and the oracle, per ticket (first CI vs. staging oracle)",
                                 "subtitle": "Runs by whether CI and the oracle found a consumer break",
                                 "rowAxis": "First CI", "colAxis": "Staging oracle",
                                 "rowNames": ["Breaks a consumer", "Passes"], "colNames": ["Breaks a consumer", "Passes"],
                                 "panels": panels, "footnote": self.agg["concordance_note"]},
                                self.cells())
        return {"note": self.agg["concordance_note"], "tickets": conc, "chart": chart,
                "empty": not panels}

    def mutation(self) -> dict:
        m = load_mutation()
        if m["present"] and m.get("total"):
            cells = m["cells"]
            order = (("ci_catch_oracle_catch", "ci_catch_oracle_miss"), ("ci_miss_oracle_catch", "ci_miss_oracle_miss"))
            tone = {"ci_catch_oracle_catch": "pass", "ci_catch_oracle_miss": "n3",
                    "ci_miss_oracle_catch": "fail", "ci_miss_oracle_miss": "n4"}
            grid = [[{"count": cells[k]["count"], "tone": tone[k], "items": [x["id"] for x in cells[k]["mutants"]][:6]}
                     for k in row] for row in order]
            m["chart"] = self.finish(
                {"id": "mutation.matrix", "kind": "matrix", "title": "What CI sees and what it does not (mutation test)",
                 "subtitle": f"{m['total']} mutants of OrderPlaced and the REST response · deterministic, no agents",
                 "rowAxis": "CI (ARCH-4, ARCH-8)", "colAxis": "Staging oracle",
                 "rowNames": ["Catches", "Misses"], "colNames": ["Catches", "Misses"],
                 "panels": [{"title": "", "note": "", "total": m["total"], "cells": grid}]},
                [], pairs=[], n=m["total"])
            if self.simulated:
                m["chart"]["banner"] = "MOCK namespace — the mutation test itself is deterministic and uses no agents"
            m["chart"]["source"] = (f"Source: Agents vs. Gates, mutation test (spec 8.4), {m['total']} mutants, deterministic, "
                                    f"no agents{', ' + m['generated_at'][:10] if m.get('generated_at') else ''}")
        else:
            m["chart"] = None
        return m


# ---------------------------------------------------------------- mutation matrix file (namespace-free)

CELL_KEYS = ("ci_catch_oracle_catch", "ci_catch_oracle_miss", "ci_miss_oracle_catch", "ci_miss_oracle_miss")
_ALIASES = {
    "ci_catch_oracle_catch": ("ci_catch_oracle_catch", "ci_catches_oracle_catches", "both_catch", "ci_yes_oracle_yes"),
    "ci_catch_oracle_miss": ("ci_catch_oracle_miss", "ci_catches_oracle_misses", "ci_only", "ci_yes_oracle_no"),
    "ci_miss_oracle_catch": ("ci_miss_oracle_catch", "ci_misses_oracle_catches", "oracle_only", "ci_no_oracle_yes"),
    "ci_miss_oracle_miss": ("ci_miss_oracle_miss", "ci_misses_oracle_misses", "neither", "ci_no_oracle_no"),
}


def _first(d: dict, names, default=None):
    for n in names:
        if n in d:
            return d[n]
    return default


def _mutant(x) -> dict:
    if isinstance(x, dict):
        return {"id": str(_first(x, ("id", "name", "mutant")) or "?"), "family": _first(x, ("family", "kind")),
                "description": _first(x, ("description", "desc", "summary"))}
    return {"id": str(x), "family": None, "description": None}


def load_mutation() -> dict:
    """results/mutation-matrix.json from `python -m oracle.mutation`. Accepted shapes (any of):
      {"cells": {"ci_catch_oracle_catch": [mutants], ...}}  or  {"cells": {key: {"count": n, "mutants": [...]}}}
      {"mutants": [{"id", "family", "ci_catches": bool, "oracle_catches": bool}, ...]}
    A mutant is a string id or {"id", "family", "description"}. Missing file → {"present": False, "command": …}."""
    root = paths.results_root()
    jp, mp = root / "mutation-matrix.json", root / "mutation-matrix.md"
    out = {"present": False, "command": MUTATION_COMMAND, "markdown": None, "generated_at": None, "total": 0,
           "cells": {}, "families": []}
    data = jsonio.read_json(jp) if jp.exists() else None
    if mp.exists():
        try:
            out["markdown"] = mp.read_text(encoding="utf-8")
        except OSError:
            pass
    if not isinstance(data, dict):
        out["present"] = bool(out["markdown"])
        return out
    cells = {k: [] for k in CELL_KEYS}
    raw = data.get("cells") or data.get("matrix")
    if isinstance(raw, dict):
        for k in CELL_KEYS:
            v = _first(raw, _ALIASES[k], [])
            ms = v.get("mutants", []) if isinstance(v, dict) else v
            cells[k] = [_mutant(x) for x in (ms or [])]
            if isinstance(v, dict) and not ms and v.get("count"):
                cells[k] = [{"id": f"#{i + 1}", "family": None, "description": None} for i in range(int(v["count"]))]
    elif isinstance(data.get("mutants"), list):
        for x in data["mutants"]:
            if not isinstance(x, dict):
                continue
            ci = bool(_first(x, ("ci_catches", "ci_caught", "ci")))
            orc = bool(_first(x, ("oracle_catches", "oracle_caught", "oracle")))
            cells[f"ci_{'catch' if ci else 'miss'}_oracle_{'catch' if orc else 'miss'}"].append(_mutant(x))
    out["cells"] = {k: {"count": len(v), "mutants": v} for k, v in cells.items()}
    out["total"] = sum(len(v) for v in cells.values())
    out["generated_at"] = data.get("generated_at")
    fam = defaultdict(lambda: {k: 0 for k in CELL_KEYS})
    for k, v in cells.items():
        for m in v:
            if m.get("family"):
                fam[m["family"]][k] += 1
    out["families"] = [{"family": f, **c, "total": sum(c.values())} for f, c in sorted(fam.items())]
    out["present"] = True
    return out


# ---------------------------------------------------------------- public entry points

def rq_payload(ns: str) -> dict:
    b = Build(ns)
    sections = {s["id"]: s for s in (b.rq1(), b.rq2(), b.rq3()) }
    rq5 = b.rq5()
    if rq5:
        sections["rq5"] = rq5
    return {**_head(b), "sections": sections, "order": [k for k in ("rq1", "rq2", "rq3", "rq5") if k in sections]}


def reviewer_payload(ns: str) -> dict:
    b = Build(ns)
    return {**_head(b), "section": b.rq4()}


def mutation_payload(ns: str) -> dict:
    b = Build(ns)
    return {**_head(b), "mutation": b.mutation(), "concordance": b.concordance()}


def excluded_payload(ns: str) -> dict:
    b = Build(ns)
    agg = b.agg
    return {**_head(b), "excluded": agg["excluded"], "infra": agg["infra"]}


def all_charts(ns: str) -> dict:
    """Every chart spec of the namespace by id (the server-side export reads from here), plus which blinded stages
    hide which family of charts (`blinded_by_chart`, keyed by the id prefix: rq1…rq5, concordance)."""
    b = Build(ns)
    charts, hidden = {}, {}
    for sec in (b.rq1(), b.rq2(), b.rq3(), b.rq5(), b.rq4()):
        if not sec:
            continue
        hidden[sec["id"]] = sec["blinded_stages"]
        for c in sec["charts"]:
            charts[c["id"]] = c
    mu, co = b.mutation(), b.concordance()
    hidden["concordance"] = b.blinded_stages
    for c in (mu.get("chart"), co.get("chart")):
        if c:
            charts[c["id"]] = c
    return {"charts": charts, "blinded": b.blinded_stages, "blinded_by_chart": hidden, "simulated": b.simulated}


def _head(b: Build) -> dict:
    return {"ns": b.ns, "simulated": b.simulated, "banner": SIM if b.simulated else None,
            "generated_at": b.agg["generated_at"],
            "stages": [{"stage": s, "visible": v["visible"], "runs_done": v["runs_done"], "runs_total": v["runs_total"]}
                       for s, v in b.agg["stages"].items()],
            "blinded_stages": b.blinded_stages}
