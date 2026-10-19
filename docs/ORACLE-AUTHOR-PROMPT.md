# Prompt given to the oracle-suite author (§8.2, information independence)

Wording as given (line wrapping reflowed). Author: a separate Claude Sonnet subagent of the build session, launched 2026-10-11 after WP1a closed. It was given only this prompt. It was told to read nothing but the three consumer repos. The prompt does not give it the broker, CI, tickets, contexts, architecture repo, orders-service source or the spec. It is not vendor independence (the author is still Claude), only information independence.

---

You write integration tests for three consumer services of an `orders-service`. Work ONLY in `C:\avg\agents-vs-gates\oracle\suites\` (create it). Do not `git commit`.

**Your task, in one line:** write integration tests of what each consumer needs from the orders-service.

**What you may read:** ONLY the three consumer repos under `C:\avg\agents-vs-gates\scenario\repos\`: `billing-service`, `analytics-ingest`, `web-storefront` (their `src/`, `test/`, `README.md`, `package.json`), plus the orders-service API description below. Do NOT open anything else in the repository (no `docs/`, `ci/`, `harness/`, `scenario/tasks`, `scenario/context`, `scenario/repos/architecture`, `scenario/repos/orders-service`, no other `oracle/` files) and do not search the repo for them. This independence of information is the point: your tests must come from the consumers' point of view only.

**orders-service API (`createApp`)** — the module exports `createApp(deps?)` with all-optional deps `{ orderRepository?, eventPublisher?, paymentGateway?, clock?, idGenerator? }`:
- `eventPublisher`: `{ publish(event): Promise<void> }` — receives every domain event the service emits.
- `paymentGateway`: `{ authorize({orderId, customerId, amountMinor, currency}): Promise<{authorized: boolean, reference?: string, declineReason?: string}> }`.
- `clock`: `{ now(): Date }`; `idGenerator`: `{ nextId(): string }`.
- Defaults are in-memory/real implementations; the test process has a global `fetch` stub that answers 2xx for internal hosts, but you should inject a fake `paymentGateway` that authorizes everything and an `eventPublisher` that collects events into an array.
- Returns `{ handle(method, path, body?) => Promise<{status, body}>, events }`; `handle` never rejects.
- Routes: `POST /orders` body `{customerId, customerEmail, channel: "web"|"store"|"marketplace", currency, lines: [{sku, name, qty, unitPriceCents}]}` → 201 + the order; `GET /orders/{id}` → 200 + the order; `POST /orders/{id}/cancel` (optional body `{reason?}`) → 200.
- Events published: `OrderPlaced` (topic `orders.placed`) and `OrderCancelled` (topic `orders.cancelled`). Do not assume the exact field names of events/responses beyond what the consumer code itself requires: feed the real emitted event objects / real response bodies to the real consumer code and assert on what the consumer produces.

**Fixtures (use exactly these):**
- A: 3 × $4.99 + 1 × $10.00 = $24.97, currency USD, channel `web` (two lines: qty 3 @ 499 cents, qty 1 @ 1000 cents).
- B: 1 × €19.90 (1990 cents), currency EUR, channel `marketplace`, cancelled after it is placed. Use a fixed clock and fixed customer ids/emails.

**Suites** (one file per consumer, `node:test` + `node:assert/strict` only, no dependencies):
- `oracle/suites/billing.test.mjs`: place A and B, take each emitted order-placed event, pass it through the billing service's real entry point (`createBillingApp().onOrderPlaced` or equivalent you find), require invoices of **2497** USD and **1990** EUR sent to each order's `customerEmail`.
- `oracle/suites/analytics.test.mjs`: pass the placed and cancelled events through the real ingest; require the correct channel, a parseable date, units 4 (A) and 1 (B), and the cancellation recorded.
- `oracle/suites/storefront.test.mjs`: fetch `GET /orders/{id}` through the storefront's real orders client and summary (a transport that maps the client's HTTP call onto `app.handle`); require that it lists the lines and shows "$24.97" and "€19.90".
- Failing assertions must have a plain message saying what the consumer could not do (e.g. "billing could not invoice order A: ContractViolationError totalCents missing").

**How modules are located (the runner's contract):** tests are run as `node --test <file>` with these env vars, each an absolute path to a compiled ESM module: `ORACLE_ORDERS_MODULE` (orders-service `dist/src/main.js`, exports `createApp`), `ORACLE_BILLING_MODULE`, `ORACLE_ANALYTICS_MODULE`, `ORACLE_STOREFRONT_MODULE` (each consumer's `dist/src/index.js`). Load with `await import(pathToFileURL(process.env.X).href)`. Put shared loading/fixtures in `oracle/suites/_common.mjs`.

**First line of each file** (a required comment): billing → `// CANARY-216c8b7177c4c660`, analytics → `// CANARY-e09fd4f6874fc540`, storefront → `// CANARY-f383584d82151f6c`, `_common.mjs` → `// CANARY-216c8b7177c4c660`.

**Verify:** you may not read orders-service source, but to test against a real build: run `npm run build` in each of the four repos (`cd C:/avg/agents-vs-gates/scenario/repos/<repo> && npm run build`; tsc resolves from the root node_modules) — including `orders-service` (building it is allowed; reading its source is not) — then run the three suites with the env vars pointing at the `dist` outputs. All three must pass. Afterwards delete every `dist/` folder you created. Builds take ~15–20 s each.

**Final report (short):** files written; test output summary; any decision you took, one line each as `date · decision · alternative · reason`.

<!-- CANARY-24ad572afb0dcd7d -->
