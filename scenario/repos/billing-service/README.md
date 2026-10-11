<!-- CANARY-d61e78f017ccf353 -->
# billing-service

Invoicing service for Meridian Retail (team Finance). It consumes `OrderPlaced`, issues an invoice for the order total
and emails it to the customer.

## Commands
- `npm run build` compiles `src/` and `test/` to `dist/`.
- `npm test` builds and runs the unit tests with `node --test`.
- `npm run arch` runs the dependency-cruiser checks.
- `npm run typecheck` type-checks without emitting.

## Public entry (`dist/src/index.js`)
```js
import { createBillingApp, handleOrderPlaced } from "./dist/src/index.js";

// One-shot, with fresh in-memory dependencies:
const invoice = await handleOrderPlaced(orderPlacedEvent);          // Promise<Invoice>

// Or keep state across events:
const app = createBillingApp({ clock, emailSender });               // all deps optional
await app.onOrderPlaced(orderPlacedEvent);                          // Promise<Invoice>; rejects on a broken contract
await app.handleMessage({ topic: "orders.placed", value: json });   // bus entry point
await app.handle("GET", "/invoices?orderId=ord-1");                 // { status, body }
app.sentEmails;                                                     // emails delivered by the simulated sender
```
`Invoice.amountCents` equals `evt.totalCents` (integer minor units). Optional deps: `invoiceRepository`, `emailSender`,
`clock`, `invoiceNumbers`.

## Contract with orders-service
Reads these `OrderPlaced` fields: `orderId`, `customerId`, `customerEmail`, `totalCents` (integer, cents), `currency`.
Anything else is ignored. A missing field, a non-integer `totalCents` or a wrong type makes `onOrderPlaced` reject with
`ContractViolationError`; nothing is stored and no email is sent.

## Behaviour
- Idempotent per `orderId`: a redelivered event returns the same invoice; the email is retried only if it was never delivered.
- Payment terms: 30 days (`dueAt`).
