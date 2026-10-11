import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { add, isMinorUnits, isSupportedCurrency, minorUnitDigits, money, multiply, sum } from "../src/core/money.js";

describe("money", () => {
  it("accepts integer minor units and rejects fractions, negatives and unsafe numbers", () => {
    assert.equal(isMinorUnits(1250), true);
    assert.equal(isMinorUnits(0), true);
    assert.equal(isMinorUnits(12.5), false);
    assert.equal(isMinorUnits(-1), false);
    assert.equal(isMinorUnits(Number.MAX_SAFE_INTEGER + 1), false);
    assert.equal(isMinorUnits("100"), false);
  });

  it("knows the supported currencies and their minor unit digits", () => {
    assert.equal(isSupportedCurrency("EUR"), true);
    assert.equal(isSupportedCurrency("XXX"), false);
    assert.equal(isSupportedCurrency("toString"), false);
    assert.equal(minorUnitDigits("USD"), 2);
    assert.equal(minorUnitDigits("JPY"), 0);
  });

  it("adds, multiplies and sums in minor units", () => {
    const price = money(499, "USD");
    assert.deepEqual(multiply(price, 3), { amountMinor: 1497, currency: "USD" });
    assert.equal(add(price, money(1000, "USD")).amountMinor, 1499);
    assert.equal(sum([multiply(price, 3), money(1000, "USD")], "USD").amountMinor, 2497);
    assert.equal(sum([], "EUR").amountMinor, 0);
  });

  it("refuses to mix currencies", () => {
    assert.throws(() => add(money(1, "USD"), money(1, "EUR")), /Currency mismatch/);
  });

  it("refuses invalid amounts and quantities", () => {
    assert.throws(() => money(0.5, "USD"), RangeError);
    assert.throws(() => money(100, "ZZZ"), /Unsupported currency/);
    assert.throws(() => multiply(money(100, "USD"), 1.5), RangeError);
  });
});
