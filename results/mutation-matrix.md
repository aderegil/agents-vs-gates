# Mutation test: CI vs. staging oracle

Generated 2026-10-11T07:27:45+00:00 by `python -m oracle.mutation` (deterministic, 0 model calls). 104 mutants of the canonical orders-service's `OrderPlaced` / `OrderCancelled` events and `GET /orders/{id}` response, applied by a wrapping publisher and handler (service code untouched). CI = ARCH-4 + ARCH-8 against the central broker; oracle = the three consumer suites. Control mutant (no change): CI passed, oracle passed.

## Confusion matrix

| | Oracle catches | Oracle misses | Total |
|---|---:|---:|---:|
| **CI catches** | 78 | 0 | 78 |
| **CI misses** | 15 | 11 | 26 |
| **Total** | 93 | 11 | 104 |

## By family

| Family | both | CI only | oracle only | neither |
|---|---:|---:|---:|---:|
| array | 2 | 0 | 3 | 1 |
| currency | 0 | 0 | 6 | 0 |
| date | 7 | 0 | 0 | 3 |
| null | 12 | 0 | 0 | 0 |
| remove | 20 | 0 | 0 | 2 |
| rename | 21 | 0 | 0 | 2 |
| type | 13 | 0 | 0 | 2 |
| units | 3 | 0 | 6 | 1 |

## CI misses, oracle catches (what CI does not see) — 15

| Mutant | Family | Target | Change | CI | Oracle failed |
|---|---|---|---|---|---|
| `ev-units-total-x100` | units | OrderPlaced | totalCents x100 | pass | billing-service |
| `ev-units-total-round` | units | OrderPlaced | totalCents in rounded dollars | pass | billing-service |
| `ev-units-total-floor` | units | OrderPlaced | totalCents in truncated dollars | pass | billing-service |
| `rest-units-total-x100` | units | GET /orders/{id} | totalCents x100 | pass | web-storefront |
| `rest-units-total-round` | units | GET /orders/{id} | totalCents in rounded dollars | pass | web-storefront |
| `rest-units-price-round` | units | GET /orders/{id} | lines[].unitPriceCents in rounded dollars | pass | web-storefront |
| `ev-array-lines-duplicate` | array | OrderPlaced | lines duplicate | pass | analytics-ingest |
| `rest-array-lines-duplicate` | array | GET /orders/{id} | lines duplicate | pass | web-storefront |
| `rest-array-lines-reverse` | array | GET /orders/{id} | lines reverse | pass | web-storefront |
| `ev-currency-EUR` | currency | OrderPlaced | currency -> EUR | pass | analytics-ingest, billing-service |
| `ev-currency-lower` | currency | OrderPlaced | currency -> lower | pass | analytics-ingest, billing-service |
| `ev-currency-numeric` | currency | OrderPlaced | currency -> 840 | pass | analytics-ingest, billing-service |
| `ev-currency-symbol` | currency | OrderPlaced | currency -> $ | pass | analytics-ingest, billing-service |
| `rest-currency-EUR` | currency | GET /orders/{id} | currency -> EUR | pass | web-storefront |
| `rest-currency-lower` | currency | GET /orders/{id} | currency -> lower | pass | web-storefront |

## CI catches, oracle misses (CI stricter than the consumers' real needs) — 0

(none)

## CI catches, oracle catches — 78

| Mutant | Family | Target | Change | CI | Oracle failed |
|---|---|---|---|---|---|
| `ev-rename-orderId` | rename | OrderPlaced | rename orderId -> id | ARCH-4 fail | analytics-ingest, billing-service |
| `ev-rename-customerId` | rename | OrderPlaced | rename customerId -> customer_id | ARCH-4 fail | billing-service |
| `ev-rename-customerEmail` | rename | OrderPlaced | rename customerEmail -> email | ARCH-4 fail | billing-service |
| `ev-rename-placedAt` | rename | OrderPlaced | rename placedAt -> createdAt | ARCH-4 fail | analytics-ingest |
| `ev-rename-channel` | rename | OrderPlaced | rename channel -> salesChannel | ARCH-4 fail | analytics-ingest |
| `ev-rename-currency` | rename | OrderPlaced | rename currency -> currencyCode | ARCH-4 fail | analytics-ingest, billing-service |
| `ev-rename-totalCents` | rename | OrderPlaced | rename totalCents -> amountCents | ARCH-4 fail | billing-service |
| `ev-rename-lines` | rename | OrderPlaced | rename lines -> items | ARCH-4 fail | analytics-ingest |
| `ev-rename-lines[].sku` | rename | OrderPlaced | rename lines[].sku -> productSku | ARCH-4 fail | analytics-ingest |
| `ev-rename-lines[].qty` | rename | OrderPlaced | rename lines[].qty -> quantity | ARCH-4 fail | analytics-ingest |
| `ev-remove-orderId` | remove | OrderPlaced | remove orderId | ARCH-4 fail | analytics-ingest, billing-service |
| `ev-remove-customerId` | remove | OrderPlaced | remove customerId | ARCH-4 fail | billing-service |
| `ev-remove-customerEmail` | remove | OrderPlaced | remove customerEmail | ARCH-4 fail | billing-service |
| `ev-remove-placedAt` | remove | OrderPlaced | remove placedAt | ARCH-4 fail | analytics-ingest |
| `ev-remove-channel` | remove | OrderPlaced | remove channel | ARCH-4 fail | analytics-ingest |
| `ev-remove-currency` | remove | OrderPlaced | remove currency | ARCH-4 fail | analytics-ingest, billing-service |
| `ev-remove-totalCents` | remove | OrderPlaced | remove totalCents | ARCH-4 fail | billing-service |
| `ev-remove-lines` | remove | OrderPlaced | remove lines | ARCH-4 fail | analytics-ingest |
| `ev-remove-lines[].sku` | remove | OrderPlaced | remove lines[].sku | ARCH-4 fail | analytics-ingest |
| `ev-remove-lines[].qty` | remove | OrderPlaced | remove lines[].qty | ARCH-4 fail | analytics-ingest |
| `rest-rename-id` | rename | GET /orders/{id} | rename id -> orderId | ARCH-8 fail | web-storefront |
| `rest-rename-status` | rename | GET /orders/{id} | rename status -> state | ARCH-8 fail | web-storefront |
| `rest-rename-currency` | rename | GET /orders/{id} | rename currency -> currencyCode | ARCH-8 fail | web-storefront |
| `rest-rename-totalCents` | rename | GET /orders/{id} | rename totalCents -> amountCents | ARCH-8 fail | web-storefront |
| `rest-rename-lines` | rename | GET /orders/{id} | rename lines -> items | ARCH-8 fail | web-storefront |
| `rest-rename-lines[].sku` | rename | GET /orders/{id} | rename lines[].sku -> productSku | ARCH-8 fail | web-storefront |
| `rest-rename-lines[].name` | rename | GET /orders/{id} | rename lines[].name -> title | ARCH-8 fail | web-storefront |
| `rest-rename-lines[].qty` | rename | GET /orders/{id} | rename lines[].qty -> quantity | ARCH-8 fail | web-storefront |
| `rest-rename-lines[].unitPriceCents` | rename | GET /orders/{id} | rename lines[].unitPriceCents -> unitPrice | ARCH-8 fail | web-storefront |
| `rest-remove-id` | remove | GET /orders/{id} | remove id | ARCH-8 fail | web-storefront |
| `rest-remove-status` | remove | GET /orders/{id} | remove status | ARCH-8 fail | web-storefront |
| `rest-remove-currency` | remove | GET /orders/{id} | remove currency | ARCH-8 fail | web-storefront |
| `rest-remove-totalCents` | remove | GET /orders/{id} | remove totalCents | ARCH-8 fail | web-storefront |
| `rest-remove-lines` | remove | GET /orders/{id} | remove lines | ARCH-8 fail | web-storefront |
| `rest-remove-lines[].sku` | remove | GET /orders/{id} | remove lines[].sku | ARCH-8 fail | web-storefront |
| `rest-remove-lines[].name` | remove | GET /orders/{id} | remove lines[].name | ARCH-8 fail | web-storefront |
| `rest-remove-lines[].qty` | remove | GET /orders/{id} | remove lines[].qty | ARCH-8 fail | web-storefront |
| `rest-remove-lines[].unitPriceCents` | remove | GET /orders/{id} | remove lines[].unitPriceCents | ARCH-8 fail | web-storefront |
| `ev-type-orderId-number` | type | OrderPlaced | orderId as a number | ARCH-4 fail | analytics-ingest, billing-service |
| `ev-type-customerId-number` | type | OrderPlaced | customerId as a number | ARCH-4 fail | billing-service |
| `ev-type-totalCents-string` | type | OrderPlaced | totalCents as a string | ARCH-4 fail | billing-service |
| `ev-type-qty-string` | type | OrderPlaced | lines[].qty as a string | ARCH-4 fail | analytics-ingest |
| `ev-type-currency-object` | type | OrderPlaced | currency wrapped in an object | ARCH-4 fail | analytics-ingest, billing-service |
| `ev-type-lines-object` | type | OrderPlaced | lines wrapped in an object | ARCH-4 fail | analytics-ingest |
| `rest-type-id-number` | type | GET /orders/{id} | id as a number | ARCH-8 fail | web-storefront |
| `rest-type-totalCents-string` | type | GET /orders/{id} | totalCents as a string | ARCH-8 fail | web-storefront |
| `rest-type-qty-string` | type | GET /orders/{id} | lines[].qty as a string | ARCH-8 fail | web-storefront |
| `rest-type-unitPrice-string` | type | GET /orders/{id} | lines[].unitPriceCents as a string | ARCH-8 fail | web-storefront |
| `rest-type-status-boolean` | type | GET /orders/{id} | status as a boolean | ARCH-8 fail | web-storefront |
| `ev-null-totalCents` | null | OrderPlaced | totalCents = null | ARCH-4 fail | billing-service |
| `ev-null-currency` | null | OrderPlaced | currency = null | ARCH-4 fail | analytics-ingest, billing-service |
| `ev-null-channel` | null | OrderPlaced | channel = null | ARCH-4 fail | analytics-ingest |
| `ev-null-placedAt` | null | OrderPlaced | placedAt = null | ARCH-4 fail | analytics-ingest |
| `ev-null-customerEmail` | null | OrderPlaced | customerEmail = null | ARCH-4 fail | billing-service |
| `ev-null-lines` | null | OrderPlaced | lines = null | ARCH-4 fail | analytics-ingest |
| `ev-null-lines[].sku` | null | OrderPlaced | lines[].sku = null | ARCH-4 fail | analytics-ingest |
| `rest-null-totalCents` | null | GET /orders/{id} | totalCents = null | ARCH-8 fail | web-storefront |
| `rest-null-currency` | null | GET /orders/{id} | currency = null | ARCH-8 fail | web-storefront |
| `rest-null-lines` | null | GET /orders/{id} | lines = null | ARCH-8 fail | web-storefront |
| `rest-null-status` | null | GET /orders/{id} | status = null | ARCH-8 fail | web-storefront |
| `rest-null-lines[].name` | null | GET /orders/{id} | lines[].name = null | ARCH-8 fail | web-storefront |
| `ev-units-total-div100` | units | OrderPlaced | totalCents /100 (dollars) | ARCH-4 fail | billing-service |
| `rest-units-total-div100` | units | GET /orders/{id} | totalCents /100 (dollars) | ARCH-8 fail | web-storefront |
| `rest-units-price-div100` | units | GET /orders/{id} | lines[].unitPriceCents /100 | ARCH-8 fail | web-storefront |
| `ev-date-date_only` | date | OrderPlaced | placedAt as date_only | ARCH-4 fail | analytics-ingest |
| `ev-date-epoch_ms` | date | OrderPlaced | placedAt as epoch_ms | ARCH-4 fail | analytics-ingest |
| `ev-date-epoch_s` | date | OrderPlaced | placedAt as epoch_s | ARCH-4 fail | analytics-ingest |
| `ev-date-utc_string` | date | OrderPlaced | placedAt as utc_string | ARCH-4 fail | analytics-ingest |
| `ev-date-no_zone` | date | OrderPlaced | placedAt as no_zone | ARCH-4 fail | analytics-ingest |
| `ev-date-us_date` | date | OrderPlaced | placedAt as us_date | ARCH-4 fail | analytics-ingest |
| `cancel-date-date_only` | date | OrderCancelled | OrderCancelled.cancelledAt as date only | ARCH-4 fail | analytics-ingest |
| `cancel-rename-cancelledAt` | rename | OrderCancelled | OrderCancelled: rename cancelledAt -> createdAt | ARCH-4 fail | analytics-ingest |
| `cancel-remove-cancelledAt` | remove | OrderCancelled | OrderCancelled: remove cancelledAt | ARCH-4 fail | analytics-ingest |
| `ev-array-lines-empty` | array | OrderPlaced | lines empty | ARCH-4 fail | analytics-ingest |
| `rest-array-lines-empty` | array | GET /orders/{id} | lines empty | ARCH-8 fail | web-storefront |
| `ev-enum-channel-upper` | type | OrderPlaced | channel upper-cased (WEB) | ARCH-4 fail | analytics-ingest |
| `ev-enum-channel-online` | type | OrderPlaced | channel = online (not an allowed value) | ARCH-4 fail | analytics-ingest |
| `ev-type-name` | rename | OrderPlaced | type OrderPlaced -> OrderCreated | ARCH-4 fail | analytics-ingest, billing-service, web-storefront |

## CI misses, oracle misses (harmless to the deployed consumers) — 11

| Mutant | Family | Target | Change | CI | Oracle failed |
|---|---|---|---|---|---|
| `ev-rename-lines[].unitPriceCents` | rename | OrderPlaced | rename lines[].unitPriceCents -> unitPrice | pass | — |
| `ev-remove-lines[].unitPriceCents` | remove | OrderPlaced | remove lines[].unitPriceCents | pass | — |
| `rest-rename-placedAt` | rename | GET /orders/{id} | rename placedAt -> createdAt | pass | — |
| `rest-remove-placedAt` | remove | GET /orders/{id} | remove placedAt | pass | — |
| `ev-type-unitPrice-string` | type | OrderPlaced | lines[].unitPriceCents as a string | pass | — |
| `ev-units-price-div100` | units | OrderPlaced | lines[].unitPriceCents /100 | pass | — |
| `rest-date-date_only` | date | GET /orders/{id} | placedAt as date_only | pass | — |
| `rest-date-epoch_ms` | date | GET /orders/{id} | placedAt as epoch_ms | pass | — |
| `rest-date-utc_string` | date | GET /orders/{id} | placedAt as utc_string | pass | — |
| `ev-array-lines-reverse` | array | OrderPlaced | lines reverse | pass | — |
| `ev-schemaVersion-4` | type | OrderPlaced | schemaVersion 3 -> 4 | pass | — |
