# Review checklist before freezing the pre-registration (§15)

Reviewed by Alfredo (or a colleague), by hand. The console's Readiness plugin shows these items as an interactive
list and records who checked each one and when. Commands run from `C:\avg\agents-vs-gates` with
`.venv\Scripts\python.exe -X utf8 -m …`.

## Scenario does not leak hints
- [ ] `grep -riE "billing|analytics|storefront|invoice|consumer|downstream" scenario/repos/orders-service scenario/context/orders-service/S0.md scenario/context/orders-service/S1.md` returns nothing.
- [ ] orders-service reads as credible enterprise code (no filler, no comments that hint at consumers or the experiment).
- [ ] S2 is the only place where consumers appear; it names consumers and rules, never which fields they use.

## Context files
- [ ] S0 = the technical README only (15–25 lines, no architecture).
- [ ] S1 and S2 added sections match the exact texts of §5.7 and are within ±20 % in words (Scenario plugin → Contexts shows the counts).
- [ ] The S2 header does not say "checked in CI".

## Tickets
- [ ] The six W1 tickets and the X-rename W2 text match §6.1 word for word.
- [ ] Paraphrases p1–p5 for X-rename, X-remove and X-api were written by a person (not a model) — or the decision to use the base text ×10 is recorded in PREREGISTRATION.md.

## Oracle and CI
- [ ] The oracle fixtures differ from CI's (oracle: $24.97 USD web and €19.90 EUR marketplace; CI: 2 × $6.25 USD web).
- [ ] The oracle suites were written by a separate author with restricted information (prompt recorded in docs/DECISIONS.md).
- [ ] `python -m harness.selftest --truth-table` prints 29/29 OK.
- [ ] `python -m oracle.mutation` produced `results/mutation-matrix.md`, and its cells make sense (what CI sees and doesn't).

## Isolation and contamination
- [ ] Canaries are planted (broker, each oracle suite, each solution patch, each consumer repo, docs) — `harness/canaries.json`.
- [ ] The smoke test passed (Readiness → Smoke test) and `docs/ENVIRONMENT.md` records the verified flags and `TOKEN_IN_ENV`.
- [ ] `python -m harness.doctor` prints DOCTOR OK.

## Calibration and units
- [ ] P0 ran; `harness/units.json` holds the full model id reported by `system/init` and the chosen `effort`.
- [ ] The P1–P5 projection in tokens and minutes is acceptable.

## Pre-registration text
- [ ] PREREGISTRATION.md: every [FILL] is filled; reading bands and "sentences that will not be said" are acceptable.
- [ ] If Codex is available: Codex reviewed the scenario before freezing (mitigates "Claude built what Claude solves").
