<!-- CANARY-dc900bedac960379 -->
# ADR-0003: Money in minor units

Status: accepted (2026-04-06) · Owners: Finance, Architecture

## Context
Floating point amounts produced rounding differences between ordering and invoicing, and a field named `total` could mean
dollars in one service and cents in another.

## Decision
- Money is an **integer amount in minor units** (cents for USD and EUR) plus an **ISO-4217 currency code**, end to end.
- Field names carry the unit: `totalCents`, `unitPriceCents`, `amountMinor`.
- Conversion to major units (for example 12.50) happens only at the presentation edge.
- A currency code is always sent together with an amount.

## Consequences
- ARCH-9: services keep integer minor units in events, APIs and storage. CI cannot fully verify the semantics (a field can
  stay an integer and still change unit), so consumers' tests and reviews remain the safety net.
