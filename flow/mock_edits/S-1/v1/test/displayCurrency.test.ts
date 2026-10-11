import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMoney } from "../src/index.js";
import { pickDisplayCurrency } from "../src/viewModels/displayCurrency.js";

describe("display currency", () => {
  it("keeps a supported choice and normalizes it", () => {
    assert.equal(pickDisplayCurrency(" eur "), "EUR");
    assert.equal(pickDisplayCurrency("JPY"), "JPY");
  });

  it("falls back to USD for unsupported or missing choices", () => {
    assert.equal(pickDisplayCurrency("XYZ"), "USD");
    assert.equal(pickDisplayCurrency(undefined), "USD");
    assert.equal(pickDisplayCurrency(42), "USD");
  });

  it("formats with the chosen currency's minor-unit digits", () => {
    assert.equal(formatMoney(1990, pickDisplayCurrency("eur")), "€19.90");
    assert.equal(formatMoney(1500, pickDisplayCurrency("jpy")), "¥1,500");
  });
});
