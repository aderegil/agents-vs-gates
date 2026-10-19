"""Home plugin API: GET /api/story → the question-first home and the Talk figures (figures.py), namespace-bound."""
from __future__ import annotations

from pathlib import Path

try:  # loaded by the console as package avg_plugin_story (see console/core/plugins.py)
    from . import figures
except ImportError:  # pragma: no cover - direct import in a scratch script
    import importlib.util
    import sys
    _spec = importlib.util.spec_from_file_location("story_figures", Path(__file__).with_name("figures.py"))
    figures = importlib.util.module_from_spec(_spec)
    sys.modules["story_figures"] = figures
    _spec.loader.exec_module(figures)


def register(router, ctx):
    def story(req):
        return figures.story(req.ns)

    router.get("", story)
