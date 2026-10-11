"""Teams & Avatars API (docs/contracts/console-api.md §2; spec 22.6). Read-only over console/plugins/teams/data/.

GET /api/teams            the models (id, name, short, label, date, summary, counts)
GET /api/teams/avatars    every member of every model as an avatar spec {style, seed, badge} (stands in for
                          spec 23's /api/avatars); the browser draws them with web/avatar.js, the module compiled
                          from the Replay Theater's avatar code, so a seed renders identically in both plugins
GET /api/teams/{model}    one model's data file
Teams are not measured in the experiment (spec 22.6): this is the visual demo of how each model staffs a team.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

try:
    from console.core.plugin_api import ApiError
except ImportError:  # pragma: no cover - only before the shell exists
    class ApiError(Exception):  # type: ignore[no-redef]
        def __init__(self, status: int, message: str):
            super().__init__(message)
            self.status = status
            self.message = message

DATA = Path(__file__).resolve().parent / "data"
MODEL_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
PHASES = ["discovery", "planning", "implementation", "review", "testing", "deployment", "maintenance"]
# Model short names shown on agent badges ("AI · Claude"); only where the source names the model family.
BADGES = {"anthropic": "Claude"}


def register(router, ctx) -> None:
    router.get("", list_models)
    router.get("/avatars", avatars)
    router.get("/{model}", get_model)


def _load(model_id: str) -> dict:
    if not MODEL_ID.match(model_id or ""):
        raise ApiError(404, f"unknown model {model_id!r}")
    path = DATA / f"{model_id}.json"
    if not path.is_file():
        raise ApiError(404, f"unknown model {model_id!r}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_all() -> list[dict]:
    out = []
    for p in sorted(DATA.glob("*.json")):
        with open(p, encoding="utf-8") as f:
            out.append(json.load(f))
    return sorted(out, key=lambda m: (m.get("order", 99), m["id"]))


def list_models(req):
    models = []
    for m in load_all():
        counts = {t: sum(1 for x in m["members"] if x["actor_type"] == t) for t in ("human", "agent", "system")}
        models.append({k: m.get(k) for k in ("id", "order", "name", "short", "publisher", "date", "label", "summary")}
                      | {"members": len(m["members"]), "counts": counts, "gaps": len(m.get("gaps", []))})
    return {"models": models, "phases": PHASES}


def get_model(req):
    m = _load((getattr(req, "params", None) or {}).get("model", ""))
    return m | {"phases": PHASES, "badge": BADGES.get(m["id"])}


def avatars(req):
    out = []
    for m in load_all():
        for x in m["members"]:
            out.append({
                "model": m["id"], "model_short": m.get("short"), "id": x["id"], "role": x["role"],
                "v21_role": x.get("v21_role"), "actor_type": x["actor_type"], "display_name": x["display_name"],
                "phase": x.get("phase"),
                "avatar": {"style": x["actor_type"], "seed": x["seed"], "role": x.get("v21_role") or x["role"],
                           "badge": BADGES.get(m["id"]) if x["actor_type"] == "agent" else None},
            })
    return {"avatars": out}
