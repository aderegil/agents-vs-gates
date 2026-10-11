import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toReportingMinor } from "../src/core/reportingCurrency.js";

const RATES = { EUR: 1_080_000, JPY: 6_700 };

describe("reporting currency", () => {
  it("keeps USD amounts as they are", () => {
    assert.equal(toReportingMinor(2497, "USD", RATES), 2497);
  });

  it("converts EUR cents and JPY yen into USD cents", () => {
    assert.equal(toReportingMinor(1000, "EUR", RATES), 1080);
    assert.equal(toReportingMinor(1000, "JPY", RATES), 670);
  });

  it("fails for a currency without a rate", () => {
    assert.throws(() => toReportingMinor(1000, "GBP", RATES), RangeError);
  });
});
