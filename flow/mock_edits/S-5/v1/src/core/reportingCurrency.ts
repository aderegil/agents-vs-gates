/** Revenue reporting in one currency (story S-5). Amounts stay integer minor units end to end (ADR-0003). */
export const REPORTING_CURRENCY = "USD";

const REPORTING_DIGITS = 2;

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

/** FX rates to USD as integers in parts per million: 1 EUR = 1.08 USD is 1_080_000. */
export type RatesPpm = Readonly<Record<string, number>>;

/** Converts minor units of `currency` into USD cents, rounding half up. A currency without a rate is an error. */
export function toReportingMinor(amountMinor: number, currency: string, ratesPpm: RatesPpm): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError(`Amount must be a non-negative integer in minor units, got ${amountMinor}`);
  }
  if (currency === REPORTING_CURRENCY) {
    return amountMinor;
  }
  const digits = MINOR_UNIT_DIGITS[currency];
  const rate = ratesPpm[currency];
  if (digits === undefined || rate === undefined || !Number.isSafeInteger(rate) || rate <= 0) {
    throw new RangeError(`No FX rate to ${REPORTING_CURRENCY} for ${currency}`);
  }
  const scale = 10 ** (REPORTING_DIGITS - digits);
  return Math.round((amountMinor * rate * scale) / 1_000_000);
}
