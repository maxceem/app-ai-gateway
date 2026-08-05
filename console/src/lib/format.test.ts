import { describe, expect, it } from "vitest";
import { cachedInputRate, formatPercent, inputTokens, totalTokens } from "./format";

const usage = {
  input_tokens: 3_707,
  cached_input_tokens: 3_964,
  cache_write_tokens: 0,
  output_tokens: 14,
};

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
