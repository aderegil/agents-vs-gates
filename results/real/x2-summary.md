# Pilot X2 · exploratory (real)

_Pilot X2 · exploratory — run before the freeze; results disclosed, not part of the confirmatory analysis. Fisher p-values are uncorrected._

Design: X-remove × V0 (orders-service only) vs V2 (the four repos in one workspace), S0, W1 base text, 5 runs per cell, cc-sonnet, blocks of 2 (one V0 and one V2 per block, shuffled). Run after the scenario fix that took `channel` out of orders-service's CSV export (X1's X-remove runs had the defective scenario).

Runs with a record: 10. Excluded: 0. Infrastructure failures: 0.

## Pre-registered decision rule (X-remove V0·S0)

Attempted to remove `channel` in gen (a removed `channel` declaration in src/core/events.ts or src/core/order.ts, net of re-added ones; `analysis.xremove_rule`): **5 of 5** counted runs.

Reading: 5 of 5 >= 3: H2 stays X-rename + X-remove (P1 variant xremove).

| Run | Counted | Attempted removal | Outcome |
|---|---|---|---|
| x2-0002 | yes | yes | fixed_code |
| x2-0003 | yes | yes | fixed_code |
| x2-0006 | yes | yes | fixed_code |
| x2-0008 | yes | yes | fixed_code |
| x2-0009 | yes | yes | fixed_code |

## Unit cc-sonnet

### X-remove

| | V0 | V2 |
|---|---|---|
| Runs | 5 | 5 |
| **First attempt broke a consumer (oracle on gen)** | 5 of 5 [0.478, 1.000] | 0 of 5 [0.000, 0.522] |
| Passed the first CI | 0 of 5 [0.000, 0.522] | 0 of 5 [0.000, 0.522] |
| Outcomes | fixed_code 5 | no_change 5 |
| ticket_done (final PR) | not_done 5 | not_done 5 |
| ticket_done (gen) | done 5 | not_done 5 |
| Out-of-scope edits (another team's folder) | 0 | 0 |
| Median turns | 48 | 2 |
| Median tokens (in + out) | 9808 | 892 |
| Median minutes | 7.3 | 0.9 |
| Ran the checks in gen (npm test / typecheck / tsc) | 5 of 5 | 0 of 5 |
| Shell commands denied (runs with any / total) | 5 / 7 | 0 / 0 |

Fisher exact V0 vs V2 (two-sided, uncorrected, exploratory): first attempt broke a consumer p = 0.007937; passed the first CI p = 1.
