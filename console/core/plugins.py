"""Plugin discovery (spec §21.2): scan console/plugins/*/plugin.json, validate, sort by order, load api.py.

An invalid manifest is skipped and recorded in the audit log; a plugin whose api.py fails to import or register
is still listed (its UI can show the problem) but its routes answer 503. Nothing here may crash the console.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path

from .plugin_api import Ctx, Router
from .sanitize import sanitize_text

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "docs" / "contracts" / "plugin.schema.json"


@dataclass
class Plugin:
    id: str
    manifest: dict
    dir: Path
    router: Router = field(default_factory=Router)
    api_error: str | None = None
    ctx: Ctx | None = None

    @property
    def roles(self) -> list[str]:
        return list(self.manifest.get("roles") or [])

    @property
    def readonly_roles(self) -> list[str]:
        return list(self.manifest.get("readonly_roles") or [])

    def public(self, role: str | None = None) -> dict:
        m = self.manifest
        entry = m["entry"].lstrip("/")
        out = {
            "id": m["id"], "name": m["name"], "icon": m["icon"], "order": m["order"],
            "description": m["description"], "kind": m["kind"], "roles": self.roles,
            "readonly_roles": self.readonly_roles,
            "entry_url": f"/plugins/{m['id']}/{entry}",
            "style_url": f"/plugins/{m['id']}/web/style.css" if (self.dir / "web" / "style.css").exists() else None,
            "has_api": bool(m.get("api")),
            "api_ok": self.api_error is None,
        }
        if role is not None:
            out["readonly"] = role in self.readonly_roles
        return out


def _validator():
    try:
        import jsonschema
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        return jsonschema.Draft7Validator(schema)
    except Exception:  # noqa: BLE001 — fall back to the minimal checks below
        return None


REQUIRED = ("id", "name", "icon", "order", "description", "roles", "kind", "entry")


def validate_manifest(m, folder: str) -> list[str]:
    errs: list[str] = []
    if not isinstance(m, dict):
        return ["manifest is not a JSON object"]
    v = _validator()
    if v is not None:
        errs = [f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in v.iter_errors(m)]
    else:
        errs = [f"missing {k}" for k in REQUIRED if k not in m]
    if not errs and m.get("id") != folder:
        errs.append(f"id {m.get('id')!r} does not match folder {folder!r}")
    return errs


def discover(plugins_dir: Path) -> tuple[list[Plugin], list[dict]]:
    """→ (valid plugins sorted by order then id, [{folder, errors}] for the invalid ones)."""
    good: list[Plugin] = []
    bad: list[dict] = []
    if not plugins_dir.is_dir():
        return good, bad
    seen: set[str] = set()
    for d in sorted(p for p in plugins_dir.iterdir() if p.is_dir()):
        mf = d / "plugin.json"
        if not mf.exists():
            continue
        try:
            m = json.loads(mf.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError) as e:
            bad.append({"folder": d.name, "errors": [f"plugin.json unreadable: {e}"]})
            continue
        errs = validate_manifest(m, d.name)
        if not errs and m["id"] in seen:
            errs = [f"duplicate id {m['id']}"]
        if not errs:
            entry = (d / m["entry"]).resolve()
            if not str(entry).startswith(str(d.resolve())):
                errs = ["entry points outside the plugin folder"]
        if errs:
            bad.append({"folder": d.name, "errors": errs})
            continue
        seen.add(m["id"])
        good.append(Plugin(id=m["id"], manifest=m, dir=d))
    good.sort(key=lambda p: (p.manifest["order"], p.id))
    return good, bad


def load_api(plugin: Plugin, ctx: Ctx) -> None:
    """Import api.py as its own package (so `from . import x` works inside the plugin folder) and register."""
    plugin.ctx = ctx
    plugin.router = Router(plugin.id)
    api_rel = plugin.manifest.get("api")
    if not api_rel:
        return
    api_path = (plugin.dir / api_rel).resolve()
    if not api_path.exists() or not str(api_path).startswith(str(plugin.dir.resolve())):
        plugin.api_error = f"{api_rel} not found"
        return
    mod_name = "avg_plugin_" + plugin.id.replace("-", "_")
    try:
        spec = importlib.util.spec_from_file_location(mod_name, api_path,
                                                      submodule_search_locations=[str(plugin.dir)])
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        reg = getattr(mod, "register", None)
        if not callable(reg):
            raise AttributeError("api.py has no register(router, ctx)")
        reg(plugin.router, ctx)
    except Exception as e:  # noqa: BLE001
        plugin.api_error = sanitize_text(f"{type(e).__name__}: {e}")
        plugin.router = Router(plugin.id)
        plugin.traceback = sanitize_text(traceback.format_exc())  # type: ignore[attr-defined]
