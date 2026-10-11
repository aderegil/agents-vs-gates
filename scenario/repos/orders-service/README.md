# orders-service

Order management service for Meridian Retail (team Checkout). It places, lists, reads and cancels customer orders and publishes `OrderPlaced` and `OrderCancelled` events.

## Commands
- `npm run build` compiles `src/` and `test/` to `dist/`.
- `npm test` builds and runs the unit tests with `node --test`.
- `npm run arch` runs the dependency-cruiser checks.
- `npm run typecheck` type-checks without emitting.

## Using `createApp`
`createApp(deps?)` in `src/main.ts` is the entry point for integration tests and the one the unit tests use. Keep it working.
It returns `{ handle(method, path, body), events }`; `handle` resolves to `{ status, body }` and never rejects.
All `deps` are optional: `orderRepository`, `eventPublisher`, `paymentGateway`, `clock`, `idGenerator`.

```ts
const app = createApp({ eventPublisher, clock, idGenerator, paymentGateway });
const res = await app.handle("POST", "/orders", { customerId, customerEmail, channel, currency, lines });
// 201 { id, status, placedAt, currency, totalCents, lines }; invalid input -> 400; unknown order -> 404
```
Routes: `POST /orders`, `GET /orders?customerId=`, `GET /orders/{id}`, `POST /orders/{id}/cancel`, `GET /health`.
