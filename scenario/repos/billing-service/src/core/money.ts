// build: CANARY-d61e78f017ccf353
/** Amounts are integer minor units (cents) plus an ISO-4217 code. */

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

/** True for a non-negative, exactly representable integer. */
export function isMinorUnits(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

/** Human readable amount for documents, e.g. `12.50 USD` for (1250, "USD"). Unknown currencies default to 2 digits. */
export function formatAmount(amountCents: number, currency: string): string {
  if (!isMinorUnits(amountCents)) {
    throw new RangeError(`Amount must be a non-negative integer in minor units, got ${amountCents}`);
  }
  const digits = MINOR_UNIT_DIGITS[currency] ?? 2;
  if (digits === 0) {
    return `${amountCents} ${currency}`;
  }
  const factor = 10 ** digits;
  const major = Math.floor(amountCents / factor);
  const minor = String(amountCents % factor).padStart(digits, "0");
  return `${major}.${minor} ${currency}`;
}
