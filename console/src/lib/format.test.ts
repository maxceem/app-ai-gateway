import { describe, expect, it } from "vitest";
import {
  cachedInputRate,
  formatCost,
  formatCostToCent,
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
  it("keeps four decimals below a cent, where a request's whole cost lives", () => {
    expect(formatCost(0.0081)).toBe("$0.0081");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1.239)).toBe("$1.24");
  });

  it("reads a total to the cent, so a column of them is one width", () => {
    expect(formatCostToCent(0.0081)).toBe("$0.01");
    expect(formatCostToCent(0.00004)).toBe("$0.00");
    expect(formatCostToCent(1.239)).toBe("$1.24");
    expect(formatCostToCent(null)).toBe("—");
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
