import { InvalidStateError, ValidationError, type ValidationIssue } from "./errors.js";
import { isMinorUnits, isSupportedCurrency, money, multiply, sum } from "./money.js";

export const CHANNELS = ["web", "store", "marketplace"] as const;
export type Channel = (typeof CHANNELS)[number];

export type OrderStatus = "placed" | "cancelled";

export interface OrderLine {
  readonly sku: string;
  readonly name: string;
  readonly qty: number;
  readonly unitPriceCents: number;
}

export interface Order {
  readonly id: string;
  readonly customerId: string;
  /** Legacy: kept on the order for receipts until the customer profile lookup exists. */
  readonly customerEmail: string;
  readonly lines: readonly OrderLine[];
  readonly status: OrderStatus;
  readonly channel: Channel;
  readonly currency: string;
  /** ISO-8601 instant. */
  readonly placedAt: string;
  /** ISO-8601 instant, set when the order is cancelled. */
  readonly cancelledAt?: string;
}

/** What a caller supplies to place an order; identity and timestamps come from the service. */
export interface NewOrder {
  readonly customerId: string;
  readonly customerEmail: string;
  readonly channel: Channel;
  readonly currency: string;
  readonly lines: readonly OrderLine[];
}

export const LIMITS = {
  maxLines: 100,
  maxQtyPerLine: 1000,
  maxSkuLength: 64,
  maxNameLength: 200,
  maxIdLength: 100,
  maxEmailLength: 254,
  /** Upper bound of an order total in minor units; protects against absurd inputs. */
  maxTotalMinor: 100_000_000,
} as const;

const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Builds a placed order after checking every invariant:
 * at least one line, positive integer quantities, prices as integer minor units,
 * a supported currency and a bounded total. All problems are reported together.
 */
export function createOrder(input: NewOrder, meta: { id: string; placedAt: string }): Order {
  const issues = collectIssues(input);
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return {
    id: meta.id,
    customerId: input.customerId,
    customerEmail: input.customerEmail,
    lines: input.lines.map((line) => ({
      sku: line.sku,
      name: line.name,
      qty: line.qty,
      unitPriceCents: line.unitPriceCents,
    })),
    status: "placed",
    channel: input.channel,
    currency: input.currency,
    placedAt: meta.placedAt,
  };
}

/** Orders can be cancelled this long after they were placed. */
export const CANCELLATION_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function canCancel(order: Order, at: string): boolean {
  if (order.status !== "placed") {
    return false;
  }
  const elapsed = Date.parse(at) - Date.parse(order.placedAt);
  return elapsed <= CANCELLATION_WINDOW_DAYS * DAY_MS;
}

export function cancel(order: Order, cancelledAt: string): Order {
  if (!canCancel(order, cancelledAt)) {
    const reason = order.status === "placed" ? "cancelled after the cancellation window" : "cancelled";
    throw new InvalidStateError(order.id, order.status, reason);
  }
  return { ...order, status: "cancelled", cancelledAt };
}

/** Order total in minor units: the sum of qty x unit price over all lines. */
export function totalCents(order: Pick<Order, "lines" | "currency">): number {
  const lineTotals = order.lines.map((line) => multiply(money(line.unitPriceCents, order.currency), line.qty));
  return sum(lineTotals, order.currency).amountMinor;
}

function collectIssues(input: NewOrder): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (path: string, message: string): void => {
    issues.push({ path, message });
  };

  if (!isNonBlank(input.customerId) || input.customerId.length > LIMITS.maxIdLength) {
    fail("customerId", `must be 1-${LIMITS.maxIdLength} characters`);
  }
  if (
    typeof input.customerEmail !== "string" ||
    input.customerEmail.length > LIMITS.maxEmailLength ||
    !EMAIL_PATTERN.test(input.customerEmail)
  ) {
    fail("customerEmail", "must be a valid email address");
  }
  if (!(CHANNELS as readonly unknown[]).includes(input.channel)) {
    fail("channel", `must be one of ${CHANNELS.join(", ")}`);
  }
  if (!isSupportedCurrency(input.currency)) {
    fail("currency", "must be a supported ISO-4217 currency code");
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    fail("lines", "must contain at least one line");
    return issues;
  }
  if (input.lines.length > LIMITS.maxLines) {
    fail("lines", `must contain at most ${LIMITS.maxLines} lines`);
  }

  let runningTotal = 0;
  input.lines.forEach((line, index) => {
    const at = `lines[${index}]`;
    if (typeof line.sku !== "string" || line.sku.length > LIMITS.maxSkuLength || !SKU_PATTERN.test(line.sku)) {
      fail(`${at}.sku`, "must be an alphanumeric SKU of at most 64 characters");
    }
    if (!isNonBlank(line.name) || line.name.length > LIMITS.maxNameLength) {
      fail(`${at}.name`, `must be 1-${LIMITS.maxNameLength} characters`);
    }
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > LIMITS.maxQtyPerLine) {
      fail(`${at}.qty`, `must be an integer between 1 and ${LIMITS.maxQtyPerLine}`);
    }
    if (!isMinorUnits(line.unitPriceCents)) {
      fail(`${at}.unitPriceCents`, "must be a non-negative integer (minor units)");
      return;
    }
    if (Number.isInteger(line.qty) && line.qty > 0) {
      runningTotal += line.qty * line.unitPriceCents;
    }
  });
  if (runningTotal > LIMITS.maxTotalMinor) {
    fail("lines", `order total exceeds the maximum of ${LIMITS.maxTotalMinor} minor units`);
  }
  return issues;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
