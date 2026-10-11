<!-- CANARY-bab633003b4a7775 -->
# web-storefront

Data layer of the Meridian Retail storefront (team Digital): a typed client of `orders-api` and the view models the pages
render. No UI framework and no runtime dependencies.

## Commands
- `npm run build` compiles `src/` and `test/` to `dist/`.
- `npm test` builds and runs the unit tests with `node --test`.
- `npm run arch` runs the dependency-cruiser checks.
- `npm run typecheck` type-checks without emitting.

## Public entry (`dist/src/index.js`)
```js
import { createStorefront, createOrdersClient, buildOrderSummary } from "./dist/src/index.js";

// Transport: any fetch-like (url, { method, headers }) => Promise<{ ok, status, json() }>.
const transport = async (url, init) => ({ ok: true, status: 200, json: async () => body });

const client = createOrdersClient({ baseUrl: "https://orders.checkout.internal", transport });
const order = await client.getOrder("ord-1");               // Promise<Order>, validated
const store = createStorefront({ baseUrl, transport });      // both optional; defaults to the global fetch
const summary = await store.getOrderSummary("ord-1");        // { total: "$24.97", lines: [...], ... }
```
`baseUrl` defaults to `https://orders.checkout.internal`. The client calls `GET {baseUrl}/orders/{id}`.

## Contract with orders-service (`GET /orders/{id}`)
Reads `id`, `status`, `currency`, `totalCents` (integer, minor units) and `lines[]` with `sku`, `name`, `qty`,
`unitPriceCents`. A response without `lines`, with a fractional or missing total, or with a malformed line makes the client
reject with `ContractViolationError`. A 404 rejects with `OrderNotFoundError`. Reads are retried once on network errors
and 5xx answers.

## View models
`buildOrderSummary(order)` formats all money from cents (`$24.97`, `€19.90`, `¥1,980`), counts items and labels the status.
