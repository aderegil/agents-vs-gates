// build: CANARY-bab633003b4a7775
import { ContractViolationError } from "../core/errors.js";
import type { Order, OrderLine } from "../core/order.js";

const CONTRACT = "GET /orders/{id}";

type JsonObject = Record<string, unknown>;

/**
 * Validates the body of `GET /orders/{id}` and returns the order.
 * Used fields: `id`, `status`, `currency`, `totalCents`, `lines[].sku|name|qty|unitPriceCents`.
 * Anything missing or of the wrong type/unit is rejected with every problem listed.
 */
export function decodeOrder(raw: unknown): Order {
  const body = asObject(raw);
  if (body === undefined) {
    throw new ContractViolationError(CONTRACT, [`body: expected an object, got ${describe(raw)}`]);
  }
  const issues: string[] = [];

  const id = text(body, "id", issues);
  const status = text(body, "status", issues);
  const currency = body.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    issues.push(`currency: expected an ISO-4217 code, got ${describe(currency)}`);
  }
  const totalCents = minorUnits(body.totalCents, "totalCents", issues);

  const lines: OrderLine[] = [];
  if (!Array.isArray(body.lines)) {
    issues.push(`lines: expected an array, got ${describe(body.lines)}`);
  } else {
    body.lines.forEach((rawLine: unknown, index: number) => {
      const line = asObject(rawLine);
      const at = `lines[${index}]`;
      if (line === undefined) {
        issues.push(`${at}: expected an object, got ${describe(rawLine)}`);
        return;
      }
      const qty = line.qty;
      if (typeof qty !== "number" || !Number.isSafeInteger(qty) || qty < 1) {
        issues.push(`${at}.qty: expected a positive integer, got ${describe(qty)}`);
      }
      lines.push({
        sku: text(line, "sku", issues, at),
        name: text(line, "name", issues, at),
        qty: typeof qty === "number" ? qty : 0,
        unitPriceCents: minorUnits(line.unitPriceCents, `${at}.unitPriceCents`, issues),
      });
    });
  }

  if (issues.length > 0) {
    throw new ContractViolationError(CONTRACT, issues);
  }
  return { id, status, currency: currency as string, totalCents, lines };
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function text(source: JsonObject, key: string, issues: string[], prefix = ""): string {
  const value = source[key];
  if (typeof value !== "string" || value === "") {
    issues.push(`${prefix === "" ? key : `${prefix}.${key}`}: expected a non-empty string, got ${describe(value)}`);
    return "";
  }
  return value;
}

function minorUnits(value: unknown, path: string, issues: string[]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    issues.push(`${path}: expected an integer number of minor units, got ${describe(value)}`);
    return 0;
  }
  return value;
}

function describe(value: unknown): string {
  if (value === undefined) {
    return "missing";
  }
  if (value === null) {
    return "null";
  }
  return `${typeof value} ${JSON.stringify(value)}`;
}
