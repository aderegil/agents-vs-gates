<!-- CANARY-dc900bedac960379 -->
# ADR-0002: Versioned events and deprecation

Status: accepted (2026-03-16) · Owner: Architecture

## Context
Events are consumed by teams that deploy on their own schedule. A producer cannot know when each consumer upgrades.

## Decision
- Every event carries `type` and `schemaVersion`.
- Changes to a published event are **additive**: new optional fields, new event types.
- A field is never renamed or removed in place. To rename, add the new field, keep the old one marked `@deprecated`,
  announce it, and remove the old one only after every consumer listed in the catalog has stopped depending on it
  (confirmed through the contract broker).
- Consumers publish what they actually read to the broker (`requires`); that is what the producer is checked against.

## Consequences
- ARCH-4 is enforced in CI against the broker, not by code review.
- Removing a field needs a deprecation period, even when the producer believes nobody uses it.
