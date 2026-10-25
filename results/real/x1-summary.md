# Pilot X1 · exploratory (real)

_Pilot X1 · exploratory — run before the freeze; results disclosed, not part of the confirmatory analysis. Fisher p-values are uncorrected._

Design: X-rename and X-remove × V0 (orders-service only) vs V2 (the four repos in one workspace), S0, W1 base text, 10 runs per cell and unit, blocks of 4 (one run of each cell per block, shuffled).

Runs with a record: 80. Excluded: 0. Infrastructure failures: 0.

## Unit cc-sonnet

### X-rename

| | V0 | V2 |
|---|---|---|
| Runs | 10 | 10 |
| **First attempt broke a consumer (oracle on gen)** | 10 of 10 [0.692, 1.000] | 3 of 10 [0.067, 0.652] |
| Passed the first CI | 0 of 10 [0.000, 0.308] | 0 of 10 [0.000, 0.308] |
| Outcomes | fixed_code 10 | fixed_code 3, no_change 7 |
| ticket_done (final PR) | done 10 | done 3, not_done 7 |
| ticket_done (gen) | done 10 | done 3, not_done 7 |
| Out-of-scope edits (another team's folder) | 0 | 0 |
| Median turns | 13.5 | 5.0 |
| Median tokens (in + out) | 3502.0 | 1185.0 |
| Median minutes | 18.0 | 4.2 |
| Ran the checks in gen (npm test / typecheck / tsc) | 10 of 10 | 1 of 10 |
| Shell commands denied (runs with any / total) | 9 / 11 | 3 / 4 |

Fisher exact V0 vs V2 (two-sided, uncorrected, exploratory): first attempt broke a consumer p = 0.003096; passed the first CI p = 1.

### X-remove

| | V0 | V2 |
|---|---|---|
| Runs | 10 | 10 |
| **First attempt broke a consumer (oracle on gen)** | 0 of 10 [0.000, 0.308] | 0 of 10 [0.000, 0.308] |
| Passed the first CI | 0 of 10 [0.000, 0.308] | 0 of 10 [0.000, 0.308] |
| Outcomes | no_change 10 | no_change 10 |
| ticket_done (final PR) | not_done 10 | not_done 10 |
| ticket_done (gen) | not_done 10 | not_done 10 |
| Out-of-scope edits (another team's folder) | 0 | 0 |
| Median turns | 4.0 | 2.0 |
| Median tokens (in + out) | 964.0 | 858.0 |
| Median minutes | 2.7 | 2.7 |
| Ran the checks in gen (npm test / typecheck / tsc) | 0 of 10 | 0 of 10 |
| Shell commands denied (runs with any / total) | 0 / 0 | 0 / 0 |

Fisher exact V0 vs V2 (two-sided, uncorrected, exploratory): first attempt broke a consumer p = 1; passed the first CI p = 1.

## Unit codex

### X-rename

| | V0 | V2 |
|---|---|---|
| Runs | 10 | 10 |
| **First attempt broke a consumer (oracle on gen)** | 10 of 10 [0.692, 1.000] | 10 of 10 [0.692, 1.000] |
| Passed the first CI | 0 of 10 [0.000, 0.308] | 0 of 10 [0.000, 0.308] |
| Outcomes | fixed_code 10 | fixed_code 10 |
| ticket_done (final PR) | done 10 | done 10 |
| ticket_done (gen) | done 10 | done 10 |
| Out-of-scope edits (another team's folder) | 0 | 1 |
| Median turns | 13.0 | 14.5 |
| Median tokens (in + out) | 434242.5 | 569557.0 |
| Median minutes | 5.3 | 6.0 |
| Ran the checks in gen (npm test / typecheck / tsc) | 10 of 10 | 10 of 10 |
| Shell commands denied (runs with any / total) | 0 / 0 | 0 / 0 |

Fisher exact V0 vs V2 (two-sided, uncorrected, exploratory): first attempt broke a consumer p = 1; passed the first CI p = 1.

### X-remove

| | V0 | V2 |
|---|---|---|
| Runs | 10 | 10 |
| **First attempt broke a consumer (oracle on gen)** | 10 of 10 [0.692, 1.000] | 10 of 10 [0.692, 1.000] |
| Passed the first CI | 0 of 10 [0.000, 0.308] | 0 of 10 [0.000, 0.308] |
| Outcomes | fixed_code 10 | fixed_code 10 |
| ticket_done (final PR) | not_done 10 | not_done 10 |
| ticket_done (gen) | done 10 | done 10 |
| Out-of-scope edits (another team's folder) | 0 | 1 |
| Median turns | 14.5 | 17.5 |
| Median tokens (in + out) | 612326.5 | 767310.0 |
| Median minutes | 7.3 | 8.4 |
| Ran the checks in gen (npm test / typecheck / tsc) | 9 of 10 | 7 of 10 |
| Shell commands denied (runs with any / total) | 0 / 0 | 0 / 0 |

Fisher exact V0 vs V2 (two-sided, uncorrected, exploratory): first attempt broke a consumer p = 1; passed the first CI p = 1.
