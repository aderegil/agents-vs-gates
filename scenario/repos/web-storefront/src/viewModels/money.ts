// build: CANARY-bab633003b4a7775
interface CurrencyFormat {
  /** Symbol printed before the amount. */
  readonly symbol: string;
  /** Decimal digits of the minor unit. */
  readonly digits: number;
}

const FORMATS: Readonly<Record<string, CurrencyFormat>> = {
  USD: { symbol: "$", digits: 2 },
  EUR: { symbol: "€", digits: 2 },
  GBP: { symbol: "£", digits: 2 },
  CAD: { symbol: "CA$", digits: 2 },
  AUD: { symbol: "A$", digits: 2 },
  MXN: { symbol: "MX$", digits: 2 },
  CHF: { symbol: "CHF ", digits: 2 },
  SEK: { symbol: "SEK ", digits: 2 },
  JPY: { symbol: "¥", digits: 0 },
  KRW: { symbol: "₩", digits: 0 },
};

/**
 * Formats an integer amount of minor units for display: `formatMoney(2497, "USD")` is `$24.97`,
 * `formatMoney(1990, "EUR")` is `€19.90`. Thousands are grouped with commas.
 * Currencies without a known symbol are printed as `1,234.50 XYZ`.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError(`Amount must be a non-negative integer in minor units, got ${amountMinor}`);
  }
  const format = FORMATS[currency];
  const digits = format?.digits ?? 2;
  const factor = 10 ** digits;
  const major = group(String(Math.floor(amountMinor / factor)));
  const minor = digits === 0 ? "" : `.${String(amountMinor % factor).padStart(digits, "0")}`;
  return format === undefined ? `${major}${minor} ${currency}` : `${format.symbol}${major}${minor}`;
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
