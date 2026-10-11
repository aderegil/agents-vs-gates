import { ValidationError, type ValidationIssue } from "../core/errors.js";
import type { Channel, NewOrder, OrderLine, OrderStatus } from "../core/order.js";
import type { CustomerOrdersQuery } from "../core/ports.js";
import { decodeCursor } from "./cursor.js";
import { InputReader, isJsonObject } from "./inputReader.js";

/**
 * Turns the untrusted body of `POST /orders` into a typed command.
 * Only the shape is checked here; the core enforces the business invariants.
 */
export function parsePlaceOrderRequest(body: unknown): NewOrder {
  if (!isJsonObject(body)) {
    throw new ValidationError([{ path: "body", message: "must be a JSON object" }]);
  }
  const reader = new InputReader(body);
  const customerId = reader.string("customerId");
  const customerEmail = reader.string("customerEmail");
  const channel = reader.string("channel");
  const currency = reader.string("currency");

  const lines: OrderLine[] = [];
  reader.array("lines").forEach((raw, index) => {
    const line = reader.object(`lines[${index}]`, raw);
    if (line === undefined) {
      return;
    }
    lines.push({
      sku: line.string("sku"),
      name: line.string("name"),
      qty: line.number("qty"),
      unitPriceCents: line.number("unitPriceCents"),
    });
    reader.issues.push(...line.issues);
  });

  if (reader.issues.length > 0) {
    throw new ValidationError(reader.issues);
  }
  // The core validates that `channel` is one of the supported values.
  return { customerId, customerEmail, channel: channel as Channel, currency, lines };
}

export interface CancelOrderRequest {
  readonly reason?: string;
}

/** The body of `POST /orders/{id}/cancel` is optional: `{ "reason"?: string }`. */
export function parseCancelRequest(body: unknown): CancelOrderRequest {
  if (body === undefined || body === null) {
    return {};
  }
  if (!isJsonObject(body)) {
    throw new ValidationError([{ path: "body", message: "must be a JSON object" }]);
  }
  const reader = new InputReader(body);
  const reason = reader.optionalString("reason");
  if (reason !== undefined && reason.length > 200) {
    reader.fail("reason", "must be at most 200 characters");
  }
  if (reader.issues.length > 0) {
    throw new ValidationError(reader.issues);
  }
  return reason === undefined ? {} : { reason };
}

const DEFAULT_LIST_LIMIT = 20;
const STATUSES: readonly string[] = ["placed", "cancelled"];

/** Query of `GET /orders?customerId=...[&status=placed|cancelled][&limit=1..100][&cursor=...]`. */
export function parseListOrdersQuery(params: URLSearchParams): CustomerOrdersQuery {
  const issues: ValidationIssue[] = [];
  const customerId = params.get("customerId") ?? "";
  if (customerId.trim() === "") {
    issues.push({ path: "customerId", message: "is required" });
  }
  const status = params.get("status");
  if (status !== null && !STATUSES.includes(status)) {
    issues.push({ path: "status", message: `must be one of ${STATUSES.join(", ")}` });
  }
  const rawLimit = params.get("limit");
  if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
    issues.push({ path: "limit", message: "must be a positive integer" });
  }
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  const limit = rawLimit === null ? DEFAULT_LIST_LIMIT : Number(rawLimit);
  const cursor = params.get("cursor");
  return {
    customerId,
    limit,
    ...(status === null ? {} : { status: status as OrderStatus }),
    ...(cursor === null ? {} : { after: decodeCursor(cursor) }),
  };
}
