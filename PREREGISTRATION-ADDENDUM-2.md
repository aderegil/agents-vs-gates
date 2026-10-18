# Pre-registration addendum 2 — P9 (more `agy-flash` runs on the P8 cells)

> Status: **final text for freezing** (the freeze is proven by `PREREGISTRATION-ADDENDUM-2.lock`, not by this line).
> Written 2026-10-18 on branch `ext-1016`, after P8 was complete and unblinded and before any P9 run. It is frozen by
> Alfredo (🔒) with `.venv\Scripts\python.exe -X utf8 -m harness.prereg --freeze-addendum 2`, which writes
> `PREREGISTRATION-ADDENDUM-2.lock` with the UTC time, the SHA-256 of this file and of
> `results/real/manifest-ext2.json`, and the hashes of the original lock it extends. The runner starts P9 only if the
> original lock **and both addendum locks** verify (P9 uses addendum 1's unit, adapter and prices, which stay frozen
> by `PREREGISTRATION-ADDENDUM-1.lock`).
>
> `PREREGISTRATION.md`, addendum 1 and their locks are **not edited and not re-frozen**. Where this addendum says
> nothing, addendum 1 applies, and where that says nothing, the original. P0–P8, their records and their p-values are
> not touched.

## 1. Why this addendum exists, and what was already known
- **Same depth for the three units.** `cc-sonnet` and `codex` have 50 runs per cell (100 per condition) after P7;
  `agy-flash` has 20 per cell from P8. Alfredo decided on 2026-10-18 to bring `agy-flash` to the same 100 runs per
  condition (50 per cell).
- **Declared: this was decided after P8 was seen.** P8 ended and was unblinded on 2026-10-18 01:19 UTC; its results
  are in `results/real/summary.md`. The decision to run more `agy-flash` runs is therefore not blind to P8. For that
  reason the confirmatory tests below use **P9's new runs only**, which nobody has seen; P8 + P9 together are
  descriptive only.

## 2. Stage, N, seed

| Stage | Unit | Cells | Runs per cell | Runs |
|---|---|---|---|---|
| **P9** (extension of P8) | `agy-flash` | the 6 P1 cells: {X-rename, X-remove} × {V0·S0, V0·S2, V2·S0} | 30 + that cell's P8 shortfall | 184 |

- **P8 shortfall.** Each P8 cell was planned with 20 runs. A run that is not in the main analysis (a canary hit, an
  exposed token, an isolation breach or a final infrastructure failure) is made up once, in P9. From the P8 records:
  X-rename V2·S0 lost 1 run and X-remove V2·S0 lost 3 (canary hits); the other four cells lost none. So P9 has 30 runs
  in four cells, 31 in X-rename V2·S0 and 33 in X-remove V2·S0. The shortfall is computed from exclusion flags only,
  never from outcomes, and is written into the sidecar (`p8_shortfall`, `p9_n`).
- **P9's own losses are not made up.** The same exclusion rule as everywhere else: a P9 run with a canary hit, an
  exposed token or an isolation breach is excluded and listed apart; it is not replaced. P8 + P9 may then end below
  50 in a cell, and is reported with its real N.
- **Same as P8:** unit `agy-flash` (Antigravity CLI + Gemini 3.8 Flash, `gemini-3.8-flash-medium`), adapter, ticket
  texts and paraphrases, context texts, scenario, limits, CI feedback text, oracle, detectors and blinding.
  Paraphrases: in round r every cell uses slot p((r − 1) mod 5 + 1); the cells with 31 and 33 runs get p1 (and p2,
  p3) once more than the others.
- **Manifest:** generated once with the new seed **20261018** into the sidecar `results/real/manifest-ext2.json`
  (`python -m harness.manifest --ext2-sidecar`, refused before P8 is complete and after this addendum is frozen),
  block-randomized by rounds like P8 (round r holds one replicate of every cell that has at least r runs, shuffled
  with `random.Random(f"20261018:P9:{r}")`). Run ids `p9-0001..0184`. Neither `manifest.json` nor
  `manifest-ext1.json` is touched.
- **Workers:** 3, one runner at a time; nothing else runs beside P9.
- **Stopping rule:** N is fixed. P9 is not unblinded before it is complete. An infrastructure failure is re-queued
  with the same id, at most twice, then `infra_failure_final`. A rate limit pauses the runner (exit 3) and is resumed
  later; it is never a reason to stop. There is no stop for results.
- **P9 quota stop (declared before any P9 run).** If the Google AI Pro quota (5-hour window or weekly cap) cannot
  complete P9 by **24 Oct 2026, 12:00 Monterrey time**, P9 ends at the last complete round k (every cell with at least
  k planned runs has k runs) and is reported as "stopped by quota after k rounds", a deviation caused by quota, not by
  results. Runs of the incomplete round are listed but not analysed. Raising the Google plan to finish in time is
  allowed and recorded; nothing is unblinded to make these decisions.

## 3. Analysis plan (written before any run)
1. **Confirmatory, on P9's new runs only** (one family for `agy-flash` in P9):
   - **H2:** `staging_break` (oracle on `gen`) V0·S0 vs V0·S2, two-sided Fisher exact per ticket (X-rename,
     X-remove), **Holm over the 2 tickets**.
   - **HS-V2** (secondary): V2·S0 vs V0·S0, two-sided Fisher per ticket, **uncorrected**, labelled secondary.
   - P8's own tests (addendum 1) stand as they are; they are not recomputed and are not corrected for P9.
2. **Descriptive:** P8 + P9 combined for `agy-flash`, per cell and per condition (both tickets): counts and 95 %
   Clopper-Pearson intervals only, **no p-values on combined data**; percentages only with N ≥ 20.
3. **Units are never compared with each other** (addendum 1 §3.3, §5).
4. Everything else as in addendum 1 §3.4: three boxes, CI↔oracle, repair outcomes, gate edits (T1/T2/T3) and
   `no_change` confirmed by blind coding (two independent AI coders), exclusions listed apart.
5. **Deck table** (`results/real/deck-numbers-ext.md`): for `agy-flash`, P8 alone, P9 alone and P8 + P9 combined,
   with exact numerators and denominators, like P1 + P7 for `cc-sonnet`.

## 4. Sentences that will not be said (added to addendum 1 §5)
- p-values on P8 + P9 combined.
- "P9 confirms P8" as if P9 had been planned before P8 was seen.
- Any comparison between units, or counts that pool units.

## 5. Freeze record
P9: 184 runs, seed 20261018, decided by Alfredo on 2026-10-18. Frozen by Alfredo De Regil with
`harness.prereg --freeze-addendum 2`; the UTC time and the hashes are in `PREREGISTRATION-ADDENDUM-2.lock`.
