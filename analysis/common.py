"""Loading archived runs and classifying them for analysis (shared by every analysis/ tool)."""
from __future__ import annotations

from pathlib import Path

from harness import blinding, paths
from harness.jsonio import read_json, read_jsonl

MAIN_STAGES = ("P1", "P2", "P4", "P5", "P6", "selftest")
CALIBRATION = "P0"
PRIMARY_UNIT = {"real": "cc-sonnet", "mock": "mock"}
SIM_BANNER = "SIMULATED (mock agent) — not a real run"


def load_records(ns: str) -> list[dict]:
    out = []
    root = paths.runs_dir(ns)
    if not root.exists():
        return out
    for d in sorted(root.iterdir()):
        rec = read_json(d / "record.json")
        if isinstance(rec, dict) and rec.get("run_id"):
            rec["_dir"] = str(d)
            out.append(rec)
    return out


def load_manifest(ns: str) -> dict | None:
    return read_json(paths.manifest_path(ns))


def load_state(ns: str) -> dict | None:
    return read_json(paths.state_path(ns))


def load_reviews(ns: str) -> list[dict]:
    return read_jsonl(paths.ns_dir(ns) / "reviews" / "reviews.jsonl")


def load_pr_set(ns: str) -> dict | None:
    return read_json(paths.ns_dir(ns) / "reviews" / "pr_set.json")


def load_labels(ns: str) -> dict:
    return read_json(paths.ns_dir(ns) / "coding" / "labels.json", {}) or {}


def exclusion_reasons(rec: dict) -> list[str]:
    """Reasons that keep a run out of the main analysis (spec 10.3, 14.1). Infra failures are counted apart."""
    reasons = []
    if (rec.get("contamination") or {}).get("flag"):
        hits = (rec.get("contamination") or {}).get("hits") or []
        origins = sorted({h.get("origin", "?") for h in hits})
        reasons.append("contaminated (canary: " + ", ".join(origins) + ")")
    if rec.get("token_exposed"):
        reasons.append("token exposed")
    if (rec.get("infra_failure") or {}).get("kind") == "isolation_breach":
        reasons.append("isolation breach")
    return reasons


def is_infra(rec: dict) -> bool:
    return rec.get("outcome") == "infra_failure"


def visible(rec: dict, state: dict | None) -> bool:
    return blinding.is_visible(state, rec.get("stage"))


def analyzable(rec: dict, state: dict | None) -> bool:
    """Main-analysis record: visible stage, not calibration, not excluded, not an infra failure."""
    return (rec.get("stage") in MAIN_STAGES and visible(rec, state)
            and not exclusion_reasons(rec) and not is_infra(rec))


def first_ci(rec: dict) -> dict | None:
    for c in rec.get("ci") or []:
        if c.get("attempt") == 0:
            return c.get("verdict")
    return None


def first_ci_ok(rec: dict) -> bool | None:
    v = first_ci(rec)
    return None if v is None else bool(v.get("ok"))


def oracle_gen(rec: dict) -> dict | None:
    return (rec.get("oracle") or {}).get("gen")


def affected_consumers(rec: dict) -> list[str]:
    g = oracle_gen(rec) or {}
    return sorted(k for k, v in (g.get("consumers") or {}).items() if not v.get("ok"))


def cell_parts(cell: str) -> dict:
    keys = ("ticket", "V", "S", "W", "unit")
    return dict(zip(keys, (cell or "").split("|")))


def run_files(rec: dict) -> Path:
    return Path(rec["_dir"]) if rec.get("_dir") else paths.run_dir(rec.get("namespace", "real"), rec["run_id"])
