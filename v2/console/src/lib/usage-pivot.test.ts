import { describe, expect, it } from "vitest";
import { MAX_SERIES, OTHER, pivot } from "./usage-pivot";
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
    const chart = pivot([bucket("openai", 1, "2026-08-02")], "2026-08-01", "2026-08-03", "cost_usd");
    expect(chart.series).toEqual([{ key: "s0", provider: "openai" }]);
    expect(chart.rows).toEqual([
      { date: "2026-08-01", s0: 0 },
      { date: "2026-08-02", s0: 1 },
      { date: "2026-08-03", s0: 0 },
    ]);
  });

  it("folds every provider past the palette's hues into one Other band", () => {
    const providers = Array.from({ length: MAX_SERIES + 2 }, (_, index) => `p${index}`);
    const chart = pivot(providers.map((name, index) => bucket(name, 100 - index)), "2026-08-01", "2026-08-01", "cost_usd");
    expect(chart.series.map((entry) => entry.provider)).toEqual([...providers.slice(0, MAX_SERIES), OTHER]);
    expect(chart.foldedCount).toBe(2);
    expect(chart.rows[0]![`s${MAX_SERIES}`]).toBe(100 - MAX_SERIES + (100 - MAX_SERIES - 1));
  });

  it("draws charges or tokens when asked, not only cost", () => {
    const buckets = [bucket("openai", 1, "2026-08-01", 3)];
    expect(pivot(buckets, "2026-08-01", "2026-08-01", "charges").rows[0]!.s0).toBe(3);
    expect(pivot(buckets, "2026-08-01", "2026-08-01", "tokens").rows[0]!.s0).toBe(15);
  });

  it("keys every band by a generated name, so a provider called date cannot overwrite the day (Sol 7b-6)", () => {
    const chart = pivot([bucket("date", 2)], "2026-08-01", "2026-08-01", "cost_usd");
    expect(chart.series).toEqual([{ key: "s0", provider: "date" }]);
    expect(chart.rows).toEqual([{ date: "2026-08-01", s0: 2 }]);
  });
});
