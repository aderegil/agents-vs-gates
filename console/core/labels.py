"""The experiment's codes in plain words, for the Python side of the console (Results chart labels, Home figures,
Start here). There is one label map, `console/web/lib/labels.js`; this module reads its data from that file, so the
words cannot drift apart. `console/tests/test_labels.py` checks, with Node, that both sides read the same map and
that the helpers here give the same strings as their JavaScript twins.

Console style (docs/DECISIONS.md, «Plain words instead of codes»): the words first, the code after them,
"Rename two fields (X-rename)".
"""
from __future__ import annotations

import json
import re
from pathlib import Path

LABELS_JS = Path(__file__).resolve().parents[1] / "web" / "lib" / "labels.js"

# The families with {short, long} entries, and the one with plain strings.
FAMILIES = ("GLOSSARY", "STAGES", "HYPOTHESES", "DETECTORS", "QUESTIONS", "REVIEWERS")
_STR = r'"((?:[^"\\]|\\.)*)"'
_ENTRY = re.compile(r'^\s*(?:"([^"]+)"|([A-Za-z_][\w]*))\s*:\s*\{\s*short:\s*' + _STR + r'\s*,\s*long:\s*' + _STR + r'\s*\}\s*,?\s*$')
_PAIR = re.compile(r'^\s*(?:"([^"]+)"|([A-Za-z_][\w]*))\s*:\s*' + _STR + r'\s*,?\s*$')


def _unescape(s: str) -> str:
    return json.loads(f'"{s}"')


def _block(src: str, name: str) -> list[str]:
    m = re.search(rf"^export const {name} = \{{\s*$(.*?)^\}};", src, re.M | re.S)
    if not m:
        raise ValueError(f"labels.js: no `export const {name} = {{ … }};` block")
    return [ln for ln in m.group(1).splitlines() if ln.strip() and not ln.strip().startswith("//")]


def parse(src: str) -> dict:
    """labels.js source → {"GLOSSARY": {code: {"short", "long"}}, …, "OUTCOME_LABEL": {key: words}}. Any line of a
    block that is not one entry is an error: a silent miss would bring a code back on screen."""
    out: dict = {}
    for name in FAMILIES:
        fam = {}
        for ln in _block(src, name):
            m = _ENTRY.match(ln)
            if not m:
                raise ValueError(f"labels.js {name}: cannot read {ln.strip()!r}")
            fam[m.group(1) or m.group(2)] = {"short": _unescape(m.group(3)), "long": _unescape(m.group(4))}
        out[name] = fam
    pairs = {}
    for ln in _block(src, "OUTCOME_LABEL"):
        m = _PAIR.match(ln)
        if not m:
            raise ValueError(f"labels.js OUTCOME_LABEL: cannot read {ln.strip()!r}")
        pairs[m.group(1) or m.group(2)] = _unescape(m.group(3))
    out["OUTCOME_LABEL"] = pairs
    return out


MAP = parse(LABELS_JS.read_text(encoding="utf-8"))
GLOSSARY, STAGES, HYPOTHESES = MAP["GLOSSARY"], MAP["STAGES"], MAP["HYPOTHESES"]
DETECTORS, QUESTIONS, REVIEWERS = MAP["DETECTORS"], MAP["QUESTIONS"], MAP["REVIEWERS"]
OUTCOME_LABEL = MAP["OUTCOME_LABEL"]


def _entry(code):
    for name in FAMILIES:
        if code in MAP[name]:
            return MAP[name][code]
    return None


def short(code) -> str:
    """The plain words of any code in the map; an unknown code stays as it is."""
    e = _entry(code)
    return e["short"] if e else ("" if code is None else str(code))


def meaning_of(code) -> str:
    e = _entry(code)
    return e["long"] if e else ""


def with_code(code, label: str | None = None) -> str:
    """"Rename two fields (X-rename)"; the code alone when it has no words (labels.js withCode)."""
    if not code:
        return ""
    words = label if label is not None else (_entry(code) or {}).get("short")
    return f"{words} ({code})" if words and words != code else str(code)


def plain_condition(V=None, S=None, W=None) -> str:
    """"Own repo · Rule in the spec" (W only when it is not W1), like labels.js plainCondition."""
    parts = [V and GLOSSARY.get(V, {}).get("short", V), S and GLOSSARY.get(S, {}).get("short", S),
             GLOSSARY.get(W, {}).get("short", W) if W and W != "W1" else None]
    return " · ".join(p for p in parts if p)


def condition_code(V=None, S=None, W=None) -> str:
    """"V0·S2" (·W2 when not W1), like labels.js conditionCode."""
    return "·".join(p for p in (V, S, W if W and W != "W1" else None) if p)


def condition_with_code(V=None, S=None, W=None) -> str:
    """Console style for a condition: "Own repo · No rule (V0·S0)"."""
    words, code = plain_condition(V, S, W), condition_code(V, S, W)
    return f"{words} ({code})" if words and words != code else code


def outcome_label(o) -> str:
    return OUTCOME_LABEL.get(o) or (str(o).replace("_", " ") if o else "")


_RUN_ID = re.compile(r"^(?:([pPxXcC]\d)c?-(\d{3,4})|st-(?:demo-)?(\d+))$")


def run_name(run_id) -> str:
    """"Main test · run 2" for p1-0002, "Simulated run 14" for st-0014; anything else unchanged (labels.js runName)."""
    s = "" if run_id is None else str(run_id)
    m = _RUN_ID.match(s)
    if not m:
        return s
    if m.group(3) is not None:
        return f"Simulated run {int(m.group(3))}"
    return f"{short(m.group(1).upper())} · run {int(m.group(2))}"


def run_with_code(run_id) -> str:
    """Console style for a run: "Main test · run 2 (p1-0002)"."""
    name = run_name(run_id)
    return f"{name} ({run_id})" if name != str(run_id) else name
