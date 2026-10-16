"""The units table: harness/units.json (frozen with PREREGISTRATION.lock) plus harness/units-ext.json (addendum 1,
frozen with PREREGISTRATION-ADDENDUM-1.lock). units.json is never edited for the extension: it is in the original
lock's GLOBS, so adding a unit there would make `prereg --verify` fail (docs/DECISIONS.md, ext-1016)."""
from __future__ import annotations

import json

from harness import paths


def load_units() -> dict:
    units = json.loads(paths.UNITS.read_text(encoding="utf-8"))
    if paths.UNITS_EXT.exists():
        for name, u in json.loads(paths.UNITS_EXT.read_text(encoding="utf-8")).items():
            if name in units:
                raise ValueError(f"unit {name!r} is in both units.json and units-ext.json")
            units[name] = u
    return units
