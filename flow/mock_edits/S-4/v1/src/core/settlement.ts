/** Currencies Finance can settle invoices in, with the digits of their minor unit (story S-4). */
const SETTLEMENT_DIGITS: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  JPY: 0,
};

export const SETTLEMENT_CURRENCIES: readonly string[] = Object.keys(SETTLEMENT_DIGITS);

export class UnsupportedSettlementCurrencyError extends Error {
  readonly currency: string;

  constructor(currency: string) {
    super(`Finance cannot settle invoices in ${currency}`);
    this.name = "UnsupportedSettlementCurrencyError";
    this.currency = currency;
  }
}

/** Minor-unit digits of a settlement currency; throws instead of defaulting to 2 for an unknown currency. */
export function settlementDigits(currency: string): number {
  if (!Object.hasOwn(SETTLEMENT_DIGITS, currency)) {
    throw new UnsupportedSettlementCurrencyError(currency);
  }
  return SETTLEMENT_DIGITS[currency] as number;
}
