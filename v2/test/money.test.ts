import { describe, expect, it } from "vitest";
import {
  addMoney,
  difference,
  formatDollars,
  fromDollars,
  nano,
  priceUnits,
  priceUnitsSum,
  rate,
  rateFromDollarsPerMillion,
  sumMoney,
  toMilli,
  type NanoDollars,
} from "../src/money.ts";
import { hasTokenPrice, listPrice, PRICE_LIST, resolvePrice } from "../src/pricing/prices.ts";
import { priceTokens } from "../src/pricing/tokens.ts";

describe("money (plan D20)", () => {
  it("sums many small charges to the integer total exactly", () => {
    // 1,000,000 charges of 1 token at $0.15 per million: each rounds up once, to 150 nano-dollars.
    const each = priceUnits(1, rateFromDollarsPerMillion(0.15));
    expect(each).toBe(150);
    const charges = Array.from({ length: 1_000_000 }, () => each);
    expect(sumMoney(charges)).toBe(150_000_000);
    // A float sum of the same charges in dollars drifts.
    let floats = 0;
    for (let i = 0; i < 1_000_000; i += 1) floats += 0.00000015;
    expect(floats).not.toBe(0.15);
  });

  it("gives the final figure when a correction is added to its original", () => {
    const original = priceUnits(1234, rate(2_000_000_000));
    const final = fromDollars(0.004321);
    const correction = difference(final, original);
    expect(addMoney(original, correction)).toBe(final);
  });

  it("never rounds the tiniest price to 0", () => {
    // One cached token on the cheapest model is far below a nano-dollar, and still costs 1.
    expect(priceUnits(1, rate(1))).toBe(1);
    expect(fromDollars(0.0000000001)).toBe(1);
    expect(priceUnits(0, rate(1))).toBe(0);
  });

  it("keeps a large units × rate product exact", () => {
    // 100,000 tokens at $600 per million: the product is 6×10^16, past 2^53, before the division.
    expect(priceUnits(100_000, rateFromDollarsPerMillion(600))).toBe(60_000_000_000);
    // A product a float would round: 9,007,199 units at 1,000,000,007 nano-dollars per million.
    expect(priceUnits(9_007_199, rate(1_000_000_007))).toBe(9_007_199_064);
    expect(() => priceUnits(Number.MAX_SAFE_INTEGER, rate(Number.MAX_SAFE_INTEGER))).toThrow();
  });

  it("rounds a charge once, not once per bucket", () => {
    const tiny = rate(1);
    // Four buckets of 1 unit at 1 nano-dollar per million: 4 / 1,000,000, rounded up once, is 1.
    expect(priceUnitsSum([[1, tiny], [1, tiny], [1, tiny], [1, tiny]])).toBe(1);
  });

  it("converts dollars without float noise, rounding up", () => {
    expect(fromDollars(0.1)).toBe(100_000_000);
    expect(fromDollars(0.000123)).toBe(123_000);
    expect(rateFromDollarsPerMillion(0.0075)).toBe(7_500_000);
    expect(() => fromDollars(Number.NaN)).toThrow();
  });

  it("formats for display only", () => {
    expect(formatDollars(nano(1_500_000_000))).toBe("$1.5");
    expect(formatDollars(nano(1))).toBe("$0.000000001");
    expect(formatDollars(nano(-300))).toBe("-$0.0000003");
  });

  it("refuses a float where money is expected", () => {
    expect(() => nano(1.5)).toThrow();
    // @ts-expect-error A plain number is not NanoDollars.
    const plain: NanoDollars = 5;
    expect(plain).toBe(5);
  });

  it("stores fractional measures at a fixed integer scale", () => {
    expect(toMilli(2.7083)).toBe(2709);
    expect(toMilli(1)).toBe(1000);
  });
});

describe("the price list", () => {
  it("loads v1's price file into integer rates", () => {
    expect(PRICE_LIST.size).toBeGreaterThan(5);
    for (const byModel of PRICE_LIST.values()) {
      for (const price of byModel.values()) {
        for (const value of Object.values(price.rates)) expect(Number.isSafeInteger(value)).toBe(true);
      }
    }
    const gpt = listPrice("openai", "gpt-4o-mini");
    expect(gpt?.rates.input).toBe(rateFromDollarsPerMillion(0.15));
  });

  it("prefers the customer's rate, and has a price for listed models", () => {
    expect(resolvePrice("openai", "gpt-4o-mini", null)?.source).toBe("list_rate");
    const customer = { "gpt-4o-mini": { input: 1, output: 2 } };
    expect(resolvePrice("openai", "gpt-4o-mini", customer)).toMatchObject({ source: "customer_rate", price: { rates: { input: 1 } } });
    expect(hasTokenPrice("openai", "no-such-model", null)).toBe(false);
    expect(hasTokenPrice("openai", "no-such-model", { "no-such-model": { input: 1, output: 1 } })).toBe(true);
  });

  it("prices tokens by bucket, cached and cache writes at the input rate when they have none", () => {
    const price = { rates: { input: rate(1_000_000_000), output: rate(2_000_000_000) }, raw: {} };
    const priced = priceTokens(price, { inputTokens: 1000, cachedInputTokens: 500, cacheWriteTokens: 0, outputTokens: 100 });
    // (1000 + 500) × $1/M + 100 × $2/M = $0.0017
    expect(priced?.cost).toBe(1_700_000);
    expect(priced?.rates.cached_input).toBe(1_000_000_000);
  });

  it("uses the long-context rates above the threshold", () => {
    const price = {
      rates: { input: rate(1000), output: rate(2000), long_input: rate(5000), long_output: rate(6000) },
      longContextThreshold: 100,
      raw: {},
    };
    expect(priceTokens(price, { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })?.longContext).toBe(false);
    const long = priceTokens(price, { inputTokens: 101, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 });
    expect(long).toMatchObject({ longContext: true, rates: { input: 5000, output: 6000 } });
  });
});
