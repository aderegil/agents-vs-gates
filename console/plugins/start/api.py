"""Start here plugin API: GET /api/start → the first page after sign-in, in simple English.

Five short blocks, all in words (no experiment codes; console/tests/test_start.py checks it): what the experiment is,
what each page does, how to watch one run in the Replay Theater in three clicks, where the results are, and how the
codes are shown. Facts checked against PREREGISTRATION.md §1-§7 (the question, Meridian Retail, the three main-test
setups) and scenario/README.md (the teams). The click path is the Replay Theater's own: the run list "Select a run…"
and the Play button (console/plugins/replay/app/src/App.tsx, components/Player.tsx).

`pages` holds one line per console plugin; the page shows the lines of the plugins the user's role can open (from
GET /api/plugins), in rail order, and marks those that only Expert view shows.
"""
from __future__ import annotations

BLOCKS = [
    {"id": "what", "title": "What we tested",
     "text": ["One question: does a rule written in the spec stop a coding agent from breaking other teams' code?",
              "We test it on Meridian Retail, a made-up company. The agent works on the orders team's code. Three other "
              "teams (billing, analytics and the web store) use data that this code sends out. Each run gives the agent "
              "one ticket, in one of three setups:"],
     "list": ["It sees only its own code, and its spec has no rule.",
              "It sees only its own code, and its spec has the rule.",
              "It sees every team's code, and its spec has no rule."],
     "after": ["The same CI checks run on every change the agent makes."]},
    {"id": "pages", "title": "What each page does",
     "text": ["Pages marked Expert show up when you pick Expert in the bar at the bottom."]},
    {"id": "watch", "title": "Watch one run in three clicks",
     "steps": ["Click Replay Theater in the bar on the left.",
               "Pick a run in the list at the top, for example Main test · run 2.",
               "Press Play, or the space bar."],
     "link": {"label": "Open the Replay Theater", "plugin": "replay", "icon": "clapperboard"}},
    {"id": "results", "title": "Where the results are",
     "text": ["Results, in the bar on the left, has one tab per question. Each tab shows counts like 7 of 10 and a "
              "chart you can save as a picture. Home shows the short answers first.",
              "A lock means that part is still sealed: its numbers stay hidden until the owner opens it. In the bar at "
              "the bottom, REAL shows the real runs and MOCK shows practice runs with a stand-in agent."],
     "link": {"label": "Open Results", "plugin": "results", "icon": "bar-chart-3"}},
    {"id": "codes", "title": "Words first",
     "text": ["Every page puts plain words first. The short code from the data comes after, in brackets. "
              "Open What the codes mean, on Home or Results, to see them all."]},
]

# One line per console plugin (the folders in console/plugins).
PAGES = {
    "start": "This page.",
    "story": "The short answers, with links to see each one.",
    "overview": "Where the work stands and what to do next.",
    "run-control": "Start, stop and follow groups of runs.",
    "results": "Every number, one tab per question, with charts.",
    "runs": "One run in detail: the code change, the CI checks and what the agent said.",
    "replay": "Watch one run play out as a short scene with people and agents.",
    "teams": "How each AI way of working staffs a team, and the faces used in the Theater.",
    "scenario": "The made-up company: its code, its rules and its tickets.",
    "readiness": "Checks that the setup is healthy before real runs.",
    "users": "Accounts, roles and a log of who did what.",
}


def payload() -> dict:
    return {"title": "Start here", "subtitle": "What this console shows, in five short parts.",
            "blocks": BLOCKS, "pages": PAGES}


def register(router, ctx):
    router.get("", lambda req: payload())
