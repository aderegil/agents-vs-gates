# Pre-registration addendum 3 — one make-up `agy-flash` run so every cell reaches 50

> Status: **final text for freezing** (the freeze is proven by `PREREGISTRATION-ADDENDUM-3.lock`). Written
> 2026-10-18 on branch `ext-1016`, after P9 was complete and unblinded and before the make-up run. Frozen by Alfredo
> (🔒, his instruction of 2026-10-18: "100 in every model") with `harness.prereg --freeze-addendum 3`, which hashes
> this file and `results/real/manifest-ext3.json`. The runner starts the make-up run only if the original lock and
> the locks of addenda 1, 2 and 3 verify. Nothing earlier is edited or re-frozen.

## 1. Why
Addendum 2 brought `agy-flash` to 50 runs per cell over P8 + P9, but said P9's own exclusions would not be made up.
One P9 run hit a canary (p9-0155, X-rename V2·S0), so that cell has 49 analysable runs. Alfredo decided that every
model must show 100 runs per condition (50 per ticket), as `cc-sonnet` and `codex` do. **This changes addendum 2's
"P9's own losses are not made up" for this one cell, and is declared here before the make-up run.**

## 2. The run
- One run: `p9-0185`, stage P9, unit `agy-flash`, cell X-rename V2·S0 W1, paraphrase slot p1, seed **20261019**,
  sidecar `results/real/manifest-ext3.json` (`python -m harness.manifest --ext3-sidecar`; the shortfall is computed
  from exclusion flags only, never outcomes). Same scenario, texts, limits, adapter, CI, consumer tests and detectors.
- 8 workers allowed; it is one run.
- If this run is itself excluded (canary, exposed token, isolation breach) or fails for infrastructure past its
  retries, it is reported as such and the cell stays at 49; no further make-up without a new addendum.

## 3. Analysis
- The run belongs to P9 and counts wherever P9 counts: P9's confirmatory tests (new runs only; this cell is in the
  secondary HS-V2 contrast) and the descriptive P8 + P9 view.
- Its outcome is visible as soon as it ends (P9 is already unblinded); nothing about it can change N or the plan.

## 4. Freeze record
Make-up run p9-0185, seed 20261019, decided by Alfredo on 2026-10-18. Frozen with `harness.prereg --freeze-addendum 3`.
