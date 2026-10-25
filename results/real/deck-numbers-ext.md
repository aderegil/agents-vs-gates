# Deck numbers — addendum 1 (real)

Generated 2026-10-19T02:26:53+00:00. Exact counts "x of N [95% Clopper-Pearson]" (percentages only when N ≥ 20). One table per unit; **units are never compared**. Breaks = the other teams' tests (consumer tests, `oracle/`) fail on the first attempt (`gen`); CI caught = of those breaks, the first CI failed; final PR = the PR as it ends; repaired to green CI, still breaks = of the runs that needed at least one repair and ended with CI green, how many still fail another team's tests (right form, wrong meaning); gate edits = runs that touched the gate, with the blind-coded T2/T3 (manipulation).

## Claude Code + Sonnet 5.5 (`cc-sonnet`)

### P7 — new runs only

| Condition | Ticket | Breaks (first attempt) | CI caught | Final PR breaks | Repaired to green CI, still breaks another team | Gate edits |
|---|---|---|---|---|---|---|
| **no rule (V0·S0)** | both | 80 of 80 [0.955, 1.000] (100%) | 80 of 80 | 1 of 80 [0.000, 0.068] (1%) | 0 of 79 | 0 of 80 |
| | X-rename | 40 of 40 [0.912, 1.000] (100%) | 40 of 40 | 0 of 40 [0.000, 0.088] (0%) | 0 of 40 | 0 of 40 |
| | X-remove | 40 of 40 [0.912, 1.000] (100%) | 40 of 40 | 1 of 40 [0.001, 0.132] (2%) | 0 of 39 | 0 of 40 |
| **sees every repo (V2·S0)** | both | 40 of 80 [0.386, 0.614] (50%) | 40 of 40 | 0 of 80 [0.000, 0.045] (0%) | 0 of 40 | 0 of 80 |
| | X-rename | 39 of 40 [0.868, 0.999] (98%) | 39 of 39 | 0 of 40 [0.000, 0.088] (0%) | 0 of 39 | 0 of 40 |
| | X-remove | 1 of 40 [0.001, 0.132] (2%) | 1 of 1 | 0 of 40 [0.000, 0.088] (0%) | 0 of 1 | 0 of 40 |
| **rule in the spec (V0·S2)** | both | 0 of 80 [0.000, 0.045] (0%) | 0 of 0 | 0 of 80 [0.000, 0.045] (0%) | 0 of 1 | 0 of 80 |
| | X-rename | 0 of 40 [0.000, 0.088] (0%) | 0 of 0 | 0 of 40 [0.000, 0.088] (0%) | 0 of 1 | 0 of 40 |
| | X-remove | 0 of 40 [0.000, 0.088] (0%) | 0 of 0 | 0 of 40 [0.000, 0.088] (0%) | 0 of 0 | 0 of 40 |

### P1 + P7 — combined (descriptive, no p-values)

| Condition | Ticket | Breaks (first attempt) | CI caught | Final PR breaks | Repaired to green CI, still breaks another team | Gate edits |
|---|---|---|---|---|---|---|
| **no rule (V0·S0)** | both | 100 of 100 [0.964, 1.000] (100%) | 100 of 100 | 1 of 100 [0.000, 0.054] (1%) | 0 of 99 | 0 of 100 |
| | X-rename | 50 of 50 [0.929, 1.000] (100%) | 50 of 50 | 0 of 50 [0.000, 0.071] (0%) | 0 of 50 | 0 of 50 |
| | X-remove | 50 of 50 [0.929, 1.000] (100%) | 50 of 50 | 1 of 50 [0.001, 0.106] (2%) | 0 of 49 | 0 of 50 |
| **sees every repo (V2·S0)** | both | 51 of 100 [0.408, 0.611] (51%) | 51 of 51 | 0 of 100 [0.000, 0.036] (0%) | 0 of 51 | 0 of 100 |
| | X-rename | 49 of 50 [0.894, 0.999] (98%) | 49 of 49 | 0 of 50 [0.000, 0.071] (0%) | 0 of 49 | 0 of 50 |
| | X-remove | 2 of 50 [0.005, 0.137] (4%) | 2 of 2 | 0 of 50 [0.000, 0.071] (0%) | 0 of 2 | 0 of 50 |
| **rule in the spec (V0·S2)** | both | 0 of 100 [0.000, 0.036] (0%) | 0 of 0 | 0 of 100 [0.000, 0.036] (0%) | 0 of 1 | 0 of 100 |
| | X-rename | 0 of 50 [0.000, 0.071] (0%) | 0 of 0 | 0 of 50 [0.000, 0.071] (0%) | 0 of 1 | 0 of 50 |
| | X-remove | 0 of 50 [0.000, 0.071] (0%) | 0 of 0 | 0 of 50 [0.000, 0.071] (0%) | 0 of 0 | 0 of 50 |

## Codex CLI + gpt-5.6-terra (`codex`)

### P7 — new runs only

| Condition | Ticket | Breaks (first attempt) | CI caught | Final PR breaks | Repaired to green CI, still breaks another team | Gate edits |
|---|---|---|---|---|---|---|
| **no rule (V0·S0)** | both | 80 of 80 [0.955, 1.000] (100%) | 80 of 80 | 7 of 80 [0.036, 0.172] (9%) | 7 of 80 | 0 of 80 |
| | X-rename | 40 of 40 [0.912, 1.000] (100%) | 40 of 40 | 0 of 40 [0.000, 0.088] (0%) | 0 of 40 | 0 of 40 |
| | X-remove | 40 of 40 [0.912, 1.000] (100%) | 40 of 40 | 7 of 40 [0.073, 0.328] (18%) | 7 of 40 | 0 of 40 |
| **sees every repo (V2·S0)** | both | 80 of 80 [0.955, 1.000] (100%) | 80 of 80 | 5 of 80 [0.021, 0.140] (6%) | 2 of 77 | 0 of 80 |
| | X-rename | 40 of 40 [0.912, 1.000] (100%) | 40 of 40 | 0 of 40 [0.000, 0.088] (0%) | 0 of 40 | 0 of 40 |
| | X-remove | 40 of 40 [0.912, 1.000] (100%) | 40 of 40 | 5 of 40 [0.042, 0.268] (12%) | 2 of 37 | 0 of 40 |
| **rule in the spec (V0·S2)** | both | 28 of 80 [0.247, 0.465] (35%) | 28 of 28 | 8 of 80 [0.044, 0.188] (10%) | 8 of 28 | 0 of 80 |
| | X-rename | 0 of 40 [0.000, 0.088] (0%) | 0 of 0 | 0 of 40 [0.000, 0.088] (0%) | 0 of 0 | 0 of 40 |
| | X-remove | 28 of 40 [0.535, 0.834] (70%) | 28 of 28 | 8 of 40 [0.091, 0.356] (20%) | 8 of 28 | 0 of 40 |

### P6 (P1 part) + P7 — combined (descriptive, no p-values)

| Condition | Ticket | Breaks (first attempt) | CI caught | Final PR breaks | Repaired to green CI, still breaks another team | Gate edits |
|---|---|---|---|---|---|---|
| **no rule (V0·S0)** | both | 100 of 100 [0.964, 1.000] (100%) | 100 of 100 | 8 of 100 [0.035, 0.152] (8%) | 8 of 100 | 0 of 100 |
| | X-rename | 50 of 50 [0.929, 1.000] (100%) | 50 of 50 | 0 of 50 [0.000, 0.071] (0%) | 0 of 50 | 0 of 50 |
| | X-remove | 50 of 50 [0.929, 1.000] (100%) | 50 of 50 | 8 of 50 [0.072, 0.291] (16%) | 8 of 50 | 0 of 50 |
| **sees every repo (V2·S0)** | both | 100 of 100 [0.964, 1.000] (100%) | 100 of 100 | 6 of 100 [0.022, 0.126] (6%) | 2 of 96 | 0 of 100 |
| | X-rename | 50 of 50 [0.929, 1.000] (100%) | 50 of 50 | 0 of 50 [0.000, 0.071] (0%) | 0 of 50 | 0 of 50 |
| | X-remove | 50 of 50 [0.929, 1.000] (100%) | 50 of 50 | 6 of 50 [0.045, 0.243] (12%) | 2 of 46 | 0 of 50 |
| **rule in the spec (V0·S2)** | both | 35 of 100 [0.257, 0.452] (35%) | 35 of 35 | 9 of 100 [0.042, 0.164] (9%) | 9 of 35 | 0 of 100 |
| | X-rename | 0 of 50 [0.000, 0.071] (0%) | 0 of 0 | 0 of 50 [0.000, 0.071] (0%) | 0 of 0 | 0 of 50 |
| | X-remove | 35 of 50 [0.554, 0.821] (70%) | 35 of 35 | 9 of 50 [0.086, 0.314] (18%) | 9 of 35 | 0 of 50 |

## Antigravity CLI + Gemini 3.8 Flash (`agy-flash`)

### P8 — new runs only

| Condition | Ticket | Breaks (first attempt) | CI caught | Final PR breaks | Repaired to green CI, still breaks another team | Gate edits |
|---|---|---|---|---|---|---|
| **no rule (V0·S0)** | both | 40 of 40 [0.912, 1.000] (100%) | 40 of 40 | 0 of 40 [0.000, 0.088] (0%) | 0 of 40 | 0 of 40 |
| | X-rename | 20 of 20 [0.832, 1.000] (100%) | 20 of 20 | 0 of 20 [0.000, 0.168] (0%) | 0 of 20 | 0 of 20 |
| | X-remove | 20 of 20 [0.832, 1.000] (100%) | 20 of 20 | 0 of 20 [0.000, 0.168] (0%) | 0 of 20 | 0 of 20 |
| **sees every repo (V2·S0)** | both | 26 of 36 [0.548, 0.858] (72%) | 26 of 26 | 0 of 36 [0.000, 0.097] (0%) | 0 of 26 | 0 of 36 |
| | X-rename | 18 of 19 [0.740, 0.999] | 18 of 18 | 0 of 19 [0.000, 0.176] | 0 of 18 | 0 of 19 |
| | X-remove | 8 of 17 [0.230, 0.722] | 8 of 8 | 0 of 17 [0.000, 0.195] | 0 of 8 | 0 of 17 |
| **rule in the spec (V0·S2)** | both | 0 of 40 [0.000, 0.088] (0%) | 0 of 0 | 0 of 40 [0.000, 0.088] (0%) | 0 of 0 | 0 of 40 |
| | X-rename | 0 of 20 [0.000, 0.168] (0%) | 0 of 0 | 0 of 20 [0.000, 0.168] (0%) | 0 of 0 | 0 of 20 |
| | X-remove | 0 of 20 [0.000, 0.168] (0%) | 0 of 0 | 0 of 20 [0.000, 0.168] (0%) | 0 of 0 | 0 of 20 |

### P9 — new runs only

| Condition | Ticket | Breaks (first attempt) | CI caught | Final PR breaks | Repaired to green CI, still breaks another team | Gate edits |
|---|---|---|---|---|---|---|
| **no rule (V0·S0)** | both | 60 of 60 [0.940, 1.000] (100%) | 60 of 60 | 0 of 60 [0.000, 0.060] (0%) | 0 of 59 | 1 of 60 (T2/T3 0) |
| | X-rename | 30 of 30 [0.884, 1.000] (100%) | 30 of 30 | 0 of 30 [0.000, 0.116] (0%) | 0 of 30 | 0 of 30 |
| | X-remove | 30 of 30 [0.884, 1.000] (100%) | 30 of 30 | 0 of 30 [0.000, 0.116] (0%) | 0 of 29 | 1 of 30 (T2/T3 0) |
| **sees every repo (V2·S0)** | both | 54 of 64 [0.731, 0.922] (84%) | 54 of 54 | 2 of 64 [0.004, 0.108] (3%) | 0 of 51 | 1 of 64 (T2/T3 0) |
| | X-rename | 30 of 31 [0.833, 0.999] (97%) | 30 of 30 | 0 of 31 [0.000, 0.112] (0%) | 0 of 30 | 0 of 31 |
| | X-remove | 24 of 33 [0.545, 0.867] (73%) | 24 of 24 | 2 of 33 [0.007, 0.202] (6%) | 0 of 21 | 1 of 33 (T2/T3 0) |
| **rule in the spec (V0·S2)** | both | 0 of 60 [0.000, 0.060] (0%) | 0 of 0 | 0 of 60 [0.000, 0.060] (0%) | 0 of 0 | 0 of 60 |
| | X-rename | 0 of 30 [0.000, 0.116] (0%) | 0 of 0 | 0 of 30 [0.000, 0.116] (0%) | 0 of 0 | 0 of 30 |
| | X-remove | 0 of 30 [0.000, 0.116] (0%) | 0 of 0 | 0 of 30 [0.000, 0.116] (0%) | 0 of 0 | 0 of 30 |

### P8 + P9 — combined (descriptive, no p-values)

| Condition | Ticket | Breaks (first attempt) | CI caught | Final PR breaks | Repaired to green CI, still breaks another team | Gate edits |
|---|---|---|---|---|---|---|
| **no rule (V0·S0)** | both | 100 of 100 [0.964, 1.000] (100%) | 100 of 100 | 0 of 100 [0.000, 0.036] (0%) | 0 of 99 | 1 of 100 (T2/T3 0) |
| | X-rename | 50 of 50 [0.929, 1.000] (100%) | 50 of 50 | 0 of 50 [0.000, 0.071] (0%) | 0 of 50 | 0 of 50 |
| | X-remove | 50 of 50 [0.929, 1.000] (100%) | 50 of 50 | 0 of 50 [0.000, 0.071] (0%) | 0 of 49 | 1 of 50 (T2/T3 0) |
| **sees every repo (V2·S0)** | both | 80 of 100 [0.708, 0.873] (80%) | 80 of 80 | 2 of 100 [0.002, 0.070] (2%) | 0 of 77 | 1 of 100 (T2/T3 0) |
| | X-rename | 48 of 50 [0.863, 0.995] (96%) | 48 of 48 | 0 of 50 [0.000, 0.071] (0%) | 0 of 48 | 0 of 50 |
| | X-remove | 32 of 50 [0.492, 0.771] (64%) | 32 of 32 | 2 of 50 [0.005, 0.137] (4%) | 0 of 29 | 1 of 50 (T2/T3 0) |
| **rule in the spec (V0·S2)** | both | 0 of 100 [0.000, 0.036] (0%) | 0 of 0 | 0 of 100 [0.000, 0.036] (0%) | 0 of 0 | 0 of 100 |
| | X-rename | 0 of 50 [0.000, 0.071] (0%) | 0 of 0 | 0 of 50 [0.000, 0.071] (0%) | 0 of 0 | 0 of 50 |
| | X-remove | 0 of 50 [0.000, 0.071] (0%) | 0 of 0 | 0 of 50 [0.000, 0.071] (0%) | 0 of 0 | 0 of 50 |

## First attempt: breaks that CI caught, per unit (every visible stage; units are not summed)

| Unit | Stages | Gate outside the agent's repo (V0, V2): CI caught | Gate copied into the repo (V1): CI caught |
|---|---|---|---|
| Claude Code + Sonnet 5.5 | P1, P2, P4, P7 | 172 of 172 | — |
| Codex CLI + gpt-5.6-terra | P6, P7 | 256 of 256 | 1 of 10 |
| Antigravity CLI + Gemini 3.8 Flash | P8, P9 | 180 of 180 | — |
| Claude Code + Opus 5.5 | P5 | 20 of 20 | — |

In V1 the consumer contracts sit inside the agent's repo, so the agent can edit them and CI passes; that is the gate-edit case, counted apart. — = no break in those runs.

