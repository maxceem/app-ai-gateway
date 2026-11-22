import { describe, expect, it } from "vitest";
import {
  cachedInputRate,
  formatCost,
  formatPercent,
  inputTokens,
  totalTokens,
} from "./format";

const usage = {
  input_tokens: 3_707,
  cached_input_tokens: 3_964,
  cache_write_tokens: 0,
  output_tokens: 14,
};

describe("cost formatting", () => {
  // One formatter for every amount (Sol 7b-6): cents kept however large, and a nonzero amount never zero.
  it.each([
    [null, "—"],
    [undefined, "—"],
    [0, "$0.00"],
    [0.004, "$0.004"],
    [0.0081, "$0.0081"],
    [0.00421337, "$0.0042"],
    [0.000000001, "$0.000000001"],
    [0.00000005, "$0.00000005"],
    [0.0099999, "$0.01"],
    [0.01, "$0.01"],
    [1.239, "$1.24"],
    [100.49, "$100.49"],
    [1234.5, "$1,234.50"],
    [-0.0042, "-$0.0042"],
    [-0.75, "-$0.75"],
    [-100.49, "-$100.49"],
  ])("shows %s as %s", (value, text) => {
    expect(formatCost(value)).toBe(text);
  });
});

describe("token formatting", () => {
  it("presents provider input as the sum of its exclusive billing buckets", () => {
    expect(inputTokens(usage)).toBe(7_671);
    expect(totalTokens(usage)).toBe(7_685);
  });

  it("reports cached reads as a share of full provider input", () => {
    expect(cachedInputRate(usage)).toBeCloseTo(3_964 / 7_671);
    expect(formatPercent(cachedInputRate(usage))).toBe("51.7%");
  });

  it("does not invent a cache rate when there is no input", () => {
    const empty = {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 2,
    };

    expect(cachedInputRate(empty)).toBeNull();
    expect(formatPercent(cachedInputRate(empty))).toBe("—");
  });
});
