// build: CANARY-d61e78f017ccf353
import { ContractViolationError } from "./errors.js";
import { isCurrencyCode, isMinorUnits } from "./money.js";

/** The part of `OrderPlaced` that billing-service relies on. Other fields are ignored. */
export interface OrderPlacedEvent {
  readonly orderId: string;
  readonly customerId: string;
  readonly customerEmail: string;
  /** Integer, minor units (cents). */
  readonly totalCents: number;
  /** ISO-4217 code. */
  readonly currency: string;
}

const CONTRACT = "OrderPlaced";

/**
 * Validates an untrusted event and returns the fields billing needs.
 * Every problem is reported at once; any problem throws `ContractViolationError`.
 */
export function decodeOrderPlaced(raw: unknown): OrderPlacedEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ContractViolationError(CONTRACT, ["event must be a JSON object"]);
  }
  const event = raw as Record<string, unknown>;
  const issues: string[] = [];

  if (event.type !== "OrderPlaced") {
    issues.push(`type: expected "OrderPlaced", got ${describe(event.type)}`);
  }
  const orderId = requireString(event, "orderId", issues);
  const customerId = requireString(event, "customerId", issues);
  const customerEmail = requireString(event, "customerEmail", issues);
  if (customerEmail !== "" && !customerEmail.includes("@")) {
    issues.push("customerEmail: expected an email address");
  }

  const totalCents = event.totalCents;
  if (!isMinorUnits(totalCents)) {
    issues.push(`totalCents: expected an integer number of cents, got ${describe(totalCents)}`);
  }
  const currency = event.currency;
  if (!isCurrencyCode(currency)) {
    issues.push(`currency: expected an ISO-4217 code, got ${describe(currency)}`);
  }

  if (issues.length > 0 || !isMinorUnits(totalCents) || !isCurrencyCode(currency)) {
    throw new ContractViolationError(CONTRACT, issues);
  }
  return { orderId, customerId, customerEmail, totalCents, currency };
}

function requireString(event: Record<string, unknown>, key: string, issues: string[]): string {
  const value = event[key];
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${key}: expected a non-empty string, got ${describe(value)}`);
    return "";
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
