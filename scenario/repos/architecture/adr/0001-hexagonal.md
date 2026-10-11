<!-- CANARY-dc900bedac960379 -->
# ADR-0001: Hexagonal structure for every service

Status: accepted (2026-03-02) · Owner: Architecture

## Context
Services were growing handlers that talked to databases, queues and HTTP clients directly. Changing one adapter
meant touching business rules, and unit tests needed real infrastructure.

## Decision
Every service is organised in three layers under `src/`:
- `core/`: the domain model, the application service and the **ports** (interfaces) it needs. No framework, no I/O.
- `api/`: inbound handlers. They validate input, call `core/` and map results to responses.
- `adapters/`: outbound implementations of the ports (HTTP clients, event bus, persistence, clock).

`src/main.ts` is the composition root and the only place that wires adapters into the core.

## Consequences
- Dependencies point inwards: ARCH-1 (core imports nothing from `api/` or `adapters/`) and ARCH-2 (`api/` never imports `adapters/`).
- All I/O lives in adapters (ARCH-3), so unit tests inject fakes and never use the network.
- Legacy code that breaks the layering is recorded in the repository's known-violations baseline and shrinks over time; it never grows.
