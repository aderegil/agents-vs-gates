/**
 * Money is an integer amount in minor units (cents for USD/EUR) plus an ISO-4217 currency.
 * Floating point amounts never enter the domain.
 */

export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

/** Number of decimal digits of the minor unit for every currency the service accepts. */
const MINOR_UNIT_DIGITS: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  MXN: 2,
  CHF: 2,
  SEK: 2,
  JPY: 0,
  KRW: 0,
};

export const SUPPORTED_CURRENCIES: readonly string[] = Object.keys(MINOR_UNIT_DIGITS);

export function isSupportedCurrency(code: unknown): code is string {
  return typeof code === "string" && Object.hasOwn(MINOR_UNIT_DIGITS, code);
}

/** True for a non-negative integer that is exactly representable (a valid minor-unit amount). */
export function isMinorUnits(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function minorUnitDigits(currency: string): number {
  const digits = MINOR_UNIT_DIGITS[currency];
  if (digits === undefined) {
    throw new RangeError(`Unsupported currency: ${currency}`);
  }
  return digits;
}

export function money(amountMinor: number, currency: string): Money {
  if (!isMinorUnits(amountMinor)) {
    throw new RangeError(`Amount must be a non-negative integer in minor units, got ${amountMinor}`);
  }
  if (!isSupportedCurrency(currency)) {
    throw new RangeError(`Unsupported currency: ${currency}`);
  }
  return { amountMinor, currency };
}

export function zero(currency: string): Money {
  return money(0, currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function multiply(m: Money, quantity: number): Money {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError(`Quantity must be a non-negative integer, got ${quantity}`);
  }
  return money(m.amountMinor * quantity, m.currency);
}

export function sum(items: readonly Money[], currency: string): Money {
  return items.reduce((total, item) => add(total, item), zero(currency));
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new RangeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}
