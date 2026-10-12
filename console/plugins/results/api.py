"""Results plugin API (spec 22.3), all read-only and namespace-bound (`?ns=` or the session switch).

GET /api/results             index: the routes and the exportable chart ids
GET /api/results/rq          RQ1, RQ2, RQ3 and (when there is data) RQ5: sections with chart specs, tables, H2
GET /api/results/reviewer    RQ4: reviewer sensitivity/specificity, miss rate per PR, cost and latency next to CI
GET /api/results/mutation    the mutation matrix (results/mutation-matrix.json, namespace-free) and the CI↔oracle
                             concordance with its pre-registered note
GET /api/results/excluded    excluded runs with their reason, and infrastructure failures
GET /api/results/export      ?chart=<id>&style=app|deck&format=svg → the chart as a 1920×1080 SVG slide (server side,
                             through web/render-cli.mjs, the same drawing code as the browser). Without `chart`:
                             the list of chart ids. PNG is made in the browser (canvas) from the same SVG.

Every number comes from analysis.summarize.aggregate (see payload.py). A stage that is not unblinded contributes no
number: the sections say "blinded" and carry none. In the mock namespace every chart is flagged `simulated` and the
renderer always draws the MOCK watermark; there is no parameter to turn it off.
"""
from __future__ import annotations

import base64
import json
import re
import shutil
import subprocess
from pathlib import Path

from console.core.plugin_api import ApiError, Response
from harness import paths

try:  # loaded by the console as package avg_plugin_results (see console/core/plugins.py)
    from . import payload
except ImportError:  # pragma: no cover - direct import in a scratch script
    import importlib.util
    import sys
    _spec = importlib.util.spec_from_file_location("results_payload", Path(__file__).with_name("payload.py"))
    payload = importlib.util.module_from_spec(_spec)
    sys.modules["results_payload"] = payload
    _spec.loader.exec_module(payload)

HERE = Path(__file__).resolve().parent
RENDER = HERE / "web" / "render-cli.mjs"
FONTS = paths.REPO / "console" / "web" / "fonts"  # not relative to HERE: tests copy the plugin to a temp dir
FONT_FILES = (("400", "ibm-plex-sans-latin-400-normal.woff2"), ("500", "ibm-plex-sans-latin-500-normal.woff2"),
              ("600", "ibm-plex-sans-latin-600-normal.woff2"))
STYLES = ("app", "deck")
CHART_IDS = ("rq1.break", "rq1.boxes", "rq2.h2", "rq2.break", "rq2.boxes", "rq3.gate", "rq3.outcomes", "rq3.v1",
             "rq4.accuracy", "rq4.miss", "rq5.break", "mutation.matrix", "concordance.matrix")
_font_css: str | None = None


def font_css() -> str:
    """@font-face rules with the console's IBM Plex Sans embedded as data: URLs (an SVG drawn as an image cannot load
    files). Graphik is not embedded (licence): the deck style names it first and uses it when it is installed."""
    global _font_css
    if _font_css is None:
        out = []
        for weight, name in FONT_FILES:
            f = FONTS / name
            if f.exists():
                b64 = base64.b64encode(f.read_bytes()).decode("ascii")
                out.append("@font-face{font-family:'IBM Plex Sans';font-weight:%s;src:url(data:font/woff2;base64,%s) "
                           "format('woff2');}" % (weight, b64))
        _font_css = "".join(out)
    return _font_css


def render_svg(spec: dict, style: str) -> str:
    node = shutil.which("node")
    if not node:
        raise ApiError(503, "Node.js was not found on PATH: the server-side SVG export draws with web/charts.js")
    job = json.dumps({"spec": spec, "style": style, "fontCss": font_css()}).encode("utf-8")
    try:
        r = subprocess.run([node, str(RENDER)], input=job, capture_output=True, timeout=30)
    except subprocess.TimeoutExpired:
        raise ApiError(504, "The SVG renderer timed out")
    if r.returncode != 0:
        raise ApiError(500, "The SVG renderer failed: " + r.stderr.decode("utf-8", "replace")[-300:])
    return r.stdout.decode("utf-8")


def register(router, ctx):
    def index(req):
        return {"ns": req.ns, "routes": ["rq", "mutation", "reviewer", "excluded", "pilot", "export"], "styles": list(STYLES),
                "charts": list(CHART_IDS)}

    def rq(req):
        return payload.rq_payload(req.ns)

    def reviewer(req):
        return payload.reviewer_payload(req.ns)

    def mutation(req):
        return payload.mutation_payload(req.ns)

    def excluded(req):
        return payload.excluded_payload(req.ns)

    def pilot(req):
        """Pilots X1 / X2 (exploratory, always visible like P0): analysis.pilot_x1, computed on request.
        ?stage=X1 (default) or X2."""
        from analysis import pilot_x1
        stage = (req.query.get("stage") or "X1").strip()
        if stage not in pilot_x1.STAGE_TICKETS:
            raise ApiError(400, "stage must be X1 or X2")
        return pilot_x1.summarize(req.ns, stage)

    def export(req):
        chart = (req.query.get("chart") or "").strip()
        style = (req.query.get("style") or "app").strip().lower()
        fmt = (req.query.get("format") or "svg").strip().lower()
        data = payload.all_charts(req.ns)
        if not chart:
            return {"ns": req.ns, "styles": list(STYLES), "formats": ["svg"], "blinded_stages": data["blinded"],
                    "charts": [{"id": k, "kind": v["kind"], "title": v["title"]} for k, v in data["charts"].items()]}
        if not re.fullmatch(r"[a-z0-9.]{3,40}", chart):
            raise ApiError(400, "Invalid chart id")
        if style not in STYLES:
            raise ApiError(400, "style must be app or deck")
        if fmt != "svg":
            raise ApiError(400, "This route returns SVG. PNG (1920×1080) is drawn in the browser from the same SVG.")
        spec = data["charts"].get(chart)
        if spec is None:
            if chart not in CHART_IDS:
                raise ApiError(404, f"Unknown chart {chart!r}")
            if data["blinded_by_chart"].get(chart.split(".")[0]):
                raise ApiError(409, "Blinded until stage complete")
            raise ApiError(404, "No data for this chart yet")
        svg = render_svg(spec, style)
        ctx.audit("results.export", {"chart": chart, "style": style, "ns": req.ns}, req.user)
        name = f"agents-vs-gates_{req.ns}_{chart.replace('.', '-')}_{style}.svg"
        return Response(body=svg.encode("utf-8"), content_type="image/svg+xml; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})

    router.get("", index)
    router.get("/rq", rq)
    router.get("/reviewer", reviewer)
    router.get("/mutation", mutation)
    router.get("/excluded", excluded)
    router.get("/pilot", pilot)
    router.get("/export", export)
