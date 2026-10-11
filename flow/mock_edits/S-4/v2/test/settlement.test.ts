import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SETTLEMENT_CURRENCIES,
  UnsupportedSettlementCurrencyError,
  settlementDigits,
} from "../src/core/settlement.js";

describe("settlement currencies", () => {
  it("lists the currencies Finance can settle", () => {
    assert.ok(SETTLEMENT_CURRENCIES.includes("EUR"));
    assert.equal(settlementDigits("EUR"), 2);
  });

  it("knows zero-decimal currencies", () => {
    assert.equal(settlementDigits("JPY"), 0);
  });

  it("rejects a currency Finance cannot settle", () => {
    assert.throws(() => settlementDigits("SEK"), UnsupportedSettlementCurrencyError);
  });
});
