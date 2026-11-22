import { describe, expect, it } from "vitest";
import {
  cachedInputRate,
  formatCompact,
  formatCost,
  formatUnits,
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
    // Under half a nano-dollar rounds to no digit: said as a bound, never `$0.`.
    [4e-10, "<$0.000000001"],
    [-4e-10, ">-$0.000000001"],
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

describe("unit formatting", () => {
  it("reads a fractional unit at its real scale, and a plain count as it is (Neon 7b-6)", () => {
    expect(formatUnits("video_seconds", 5_000)).toBe("5.0 s");
    expect(formatUnits("audio_seconds", 2_700)).toBe("2.7 s");
    expect(formatUnits("session_seconds", 90_000)).toBe("2 min");
    expect(formatUnits("credits", 10_000)).toBe("10 credits");
    expect(formatUnits("megapixels", 1_000)).toBe("1 megapixels");
    expect(formatUnits("model_units", 2_500)).toBe("2.5 model units");
    expect(formatUnits("images", 3)).toBe("3 images");
    expect(formatUnits("characters", 12_000)).toBe("12K characters");
  });

  it("keeps a correction's sign", () => {
    expect(formatUnits("video_seconds", -2_000)).toBe("-2.0 s");
    expect(formatUnits("credits", -1_500)).toBe("-1.5 credits");
    expect(formatCompact(-25_000)).toBe("-25K");
  });
});

