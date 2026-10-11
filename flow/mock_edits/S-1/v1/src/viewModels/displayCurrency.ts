/** Currencies a shopper can choose for displaying prices at checkout (story S-1, epic "Multi-currency checkout"). */
export const DISPLAY_CURRENCIES: readonly string[] = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "MXN",
  "CHF",
  "SEK",
  "JPY",
  "KRW",
];

export const DEFAULT_DISPLAY_CURRENCY = "USD";

/** The shopper's choice when it is a supported currency (case and spaces ignored); otherwise USD. Never throws. */
export function pickDisplayCurrency(choice: unknown): string {
  if (typeof choice !== "string") {
    return DEFAULT_DISPLAY_CURRENCY;
  }
  const code = choice.trim().toUpperCase();
  return DISPLAY_CURRENCIES.includes(code) ? code : DEFAULT_DISPLAY_CURRENCY;
}
