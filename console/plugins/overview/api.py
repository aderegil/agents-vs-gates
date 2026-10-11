"""Overview plugin API (spec §22.1): GET /api/overview → one payload for the executive screen."""
from __future__ import annotations

from console.core import experiment, runner_ctl


def register(router, ctx):
    def overview(req):
        ns = req.ns
        return {
            "ns": ns,
            "generated_at": experiment.utc_now(),
            **experiment.phase_and_next(ctx.data_dir),
            "prereg": {k: v for k, v in experiment.prereg_status().items() if k != "files"},
            "smoke": {"status": experiment.smoke_status()["status"]},
            "stages": experiment.stage_progress(ns),
            "counts": {n: experiment.run_counts(n) for n in ("real", "mock")},
            "last_quota_event": experiment.last_quota_event(),
            "headlines": experiment.headlines(ns),
            "runner": runner_ctl.status(ns),
        }

    router.get("", overview)
