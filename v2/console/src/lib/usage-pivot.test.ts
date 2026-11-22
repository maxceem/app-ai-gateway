import { describe, expect, it } from "vitest";
import { axisTicks, formatAxisCost, MAX_SERIES, OTHER, pivot, stackedBounds } from "./usage-pivot";
import type { TimeseriesBucket } from "./types";

const bucket = (provider: string, cost: number, day = "2026-08-01", charges = 1): TimeseriesBucket => ({
  day,
  provider_type: provider,
  charges,
  failed: 0,
  unpriced: 0,
  cost_nano: Math.round(cost * 1e9),
  cost_usd: cost,
  input_tokens: 10,
  cached_input_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 5,
  session_ms: 0,
});

describe("pivot", () => {
  it("gives every day of the range a column, with zeros on quiet days", () => {
    const chart = pivot([bucket("openai", 1, "2026-08-02")], "2026-08-01", "2026-08-03", "cost_nano");
    expect(chart.series).toEqual([{ key: "s0", provider: "openai" }]);
    expect(chart.rows).toEqual([
      { date: "2026-08-01", s0: 0 },
      { date: "2026-08-02", s0: 1_000_000_000 },
      { date: "2026-08-03", s0: 0 },
    ]);
  });

  it("folds every provider past the palette's hues into one Other band", () => {
    const providers = Array.from({ length: MAX_SERIES + 2 }, (_, index) => `p${index}`);
    const chart = pivot(providers.map((name, index) => bucket(name, 100 - index)), "2026-08-01", "2026-08-01", "cost_nano");
    expect(chart.series.map((entry) => entry.provider)).toEqual([...providers.slice(0, MAX_SERIES), OTHER]);
    expect(chart.foldedCount).toBe(2);
    expect(chart.rows[0]![`s${MAX_SERIES}`]).toBe((100 - MAX_SERIES + (100 - MAX_SERIES - 1)) * 1e9);
  });

  it("draws charges or tokens when asked, not only cost", () => {
    const buckets = [bucket("openai", 1, "2026-08-01", 3)];
    expect(pivot(buckets, "2026-08-01", "2026-08-01", "charges").rows[0]!.s0).toBe(3);
    expect(pivot(buckets, "2026-08-01", "2026-08-01", "tokens").rows[0]!.s0).toBe(15);
  });

  it("keys every band by a generated name, so a provider called date cannot overwrite the day (Sol 7b-6)", () => {
    const chart = pivot([bucket("date", 2)], "2026-08-01", "2026-08-01", "cost_nano");
    expect(chart.series).toEqual([{ key: "s0", provider: "date" }]);
    expect(chart.rows).toEqual([{ date: "2026-08-01", s0: 2_000_000_000 }]);
  });
});

describe("the cost axis (Sol 7b-6 round 3)", () => {
  const labels = (maxNano: number) => {
    const { ticks, step } = axisTicks(maxNano);
    return { ticks, labels: ticks.map((tick) => formatAxisCost(tick, step)) };
  };

  it("labels a chart peaking at $0.02 with no two ticks alike", () => {
    const { ticks, labels: shown } = labels(20_000_000);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(20_000_000);
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown).toContain("$0.020");
  });

  it("labels a one-nano-dollar chart in whole nano-dollars, never `$0.`", () => {
    const { ticks, labels: shown } = labels(1);
    expect(ticks).toEqual([0, 1]);
    expect(shown).toEqual(["$0", "$0.000000001"]);
  });

  it("never repeats a label or shows a bare `$0.`, from one nano-dollar to a thousand dollars", () => {
    for (let max = 1; max <= 1e12; max = Math.ceil(max * 1.7) + 3) {
      const { ticks, labels: shown } = labels(max);
      expect(ticks.every(Number.isInteger)).toBe(true);
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(max);
      expect(new Set(shown).size).toBe(shown.length);
      expect(shown.some((label) => label.endsWith("."))).toBe(false);
    }
  });

  it("measures the tallest stacked day", () => {
    const chart = pivot([bucket("openai", 0.01), bucket("anthropic", 0.015), bucket("openai", 0.02, "2026-08-02")], "2026-08-01", "2026-08-02", "cost_nano");
    expect(stackedBounds(chart.rows)).toEqual({ min: 0, max: 25_000_000 });
  });

  it("stacks a negative day apart from another provider's spend, and runs the axis below zero (Sol 7b-6 round 4)", () => {
    // A session's estimate on one day, its downward correction the next, beside another provider's spend.
    const chart = pivot(
      [bucket("openai", 0.03), bucket("elevenlabs", 0.05), bucket("openai", 0.02, "2026-08-02"), bucket("elevenlabs", -0.01, "2026-08-02")],
      "2026-08-01",
      "2026-08-02",
      "cost_nano",
    );
    const bounds = stackedBounds(chart.rows);
    // The correction is not taken off OpenAI's bar: positives stack up, negatives down.
    expect(bounds).toEqual({ min: -10_000_000, max: 80_000_000 });
    const { ticks, step } = axisTicks(bounds.max, bounds.min);
    expect(ticks[0]).toBeLessThanOrEqual(-10_000_000);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(80_000_000);
    expect(ticks).toContain(0);
    const shown = ticks.map((tick) => formatAxisCost(tick, step));
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown[0]!.startsWith("-$")).toBe(true);
  });

  it("never repeats a label across a range that runs below zero", () => {
    for (let low = 1; low <= 1e10; low = Math.ceil(low * 2.3) + 7) {
      const { ticks, step } = axisTicks(low * 3, -low);
      const shown = ticks.map((tick) => formatAxisCost(tick, step));
      expect(ticks[0]).toBeLessThanOrEqual(-low);
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(low * 3);
      expect(new Set(shown).size).toBe(shown.length);
      expect(shown.some((label) => label.endsWith("."))).toBe(false);
    }
  });
});
