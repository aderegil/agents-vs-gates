<!-- CANARY-659701fc98899bcc -->
# analytics-ingest

Data ingestion service for Meridian Retail (team Data). It consumes `OrderPlaced` and `OrderCancelled` and writes rows
to a data lake (in memory here).

## Commands
- `npm run build` compiles `src/` and `test/` to `dist/`.
- `npm test` builds and runs the unit tests with `node --test`.
- `npm run arch` runs the dependency-cruiser checks.
- `npm run typecheck` type-checks without emitting.

## Public entry (`dist/src/index.js`)
```js
import { createAnalyticsIngest } from "./dist/src/index.js";

const app = createAnalyticsIngest();                       // optional { lake }
await app.ingestOrderPlaced(orderPlacedEvent);             // Promise<OrderRow>; rejects on a broken contract
await app.ingestOrderCancelled(orderCancelledEvent);       // Promise<CancellationRow>
await app.ingestEvent(event);                              // routes by event.type
await app.handleMessage({ topic: "orders.placed", value }); // bus entry point (value: object or JSON text)
await app.rows("orders");                                  // rows of a lake table
```
Tables: `orders` (`order_id, placed_date, channel, currency, units`), `order_lines` (`order_id, sku, units`),
`order_cancellations` (`order_id, cancelled_date`). Dates are UTC `YYYY-MM-DD`. Writes are upserts keyed by order.

## Contract with orders-service
- `OrderPlaced`: `orderId`, `placedAt` (ISO-8601 datetime), `channel` (`web|store|marketplace`), `currency`,
  `lines[].sku`, `lines[].qty` (positive integer). Other fields are ignored.
- `OrderCancelled`: `orderId`, `cancelledAt` (ISO-8601 datetime).

A missing or mistyped field, an unknown `channel` or an unparseable date makes ingestion reject with
`ContractViolationError`; nothing is written.
