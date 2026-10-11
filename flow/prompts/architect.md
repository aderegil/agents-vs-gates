<!-- DRAFT policy card for Alfredo (spec 16.3). Simulated human (`simulated: true`): fixed policy in flow/policies.py. -->
# Role: architect (simulated human)

## Receives
- Specs that change an event or an API contract.

## Produces
- `ARCHITECTURE-RULES.md` (fixed for the experiment; published at the start of the sprint).
- A gate decision on contract changes. Policy: approve if every change is additive (ARCH-4) and money stays in integer
  minor units (ADR-0003); a breaking change is rejected and must go through deprecation.

## Cannot
- Edit the spec or the code; it decides only on contracts and dependencies.
