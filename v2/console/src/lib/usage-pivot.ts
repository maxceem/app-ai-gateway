/**
 * The usage timeseries as a stacked chart reads it (v1's pivot, on v2's buckets).
 *
 * The API answers with one row per `(day, provider_type)`; a stacked bar wants
 * one row per day with a column per series, and the same providers in the same
 * bands on every column. That transposition is arithmetic with a ranking and a
 * fold in it, so it lives here rather than beside the chart.
 */

import { totalTokens } from "@/lib/format";
import type { TimeseriesBucket } from "@/lib/types";

/** Which number of a bucket the chart is drawing. `charges` is v1's requests. */
export type Metric = "cost_usd" | "charges" | "tokens";

/**
 * A band of the chart. Its key is generated (`s0`, `s1`…), never the provider's
 * name: a name is data, and as a key it could collide with `date` or end up in
 * the chart's style sheet (Sol 7b-6). The name is shown as text only.
 */
export interface Series {
  key: string;
  /** The provider type, or {@link OTHER} for the folded band. */
  provider: string;
}

/** One column of the chart: the day, then one total per series key. */
export interface ChartColumn {
  date: string;
  [series: string]: string | number;
}

/**
 * The band every provider past the seventh is summed into. Eight bands is
 * already the most a reader can hold against a legend. Its key cannot collide
 * with a provider type, which is why it is not simply "other".
 */
export const OTHER = "__other";

/**
 * Named series before the tail, then {@link OTHER}. The palette in the Usage
 * tab has exactly this many hues, and a series past it gets no hue of its own.
 */
export const MAX_SERIES = 7;

const metricOf = (bucket: TimeseriesBucket, metric: Metric): number =>
  metric === "tokens" ? totalTokens(bucket) : metric === "charges" ? bucket.charges : bucket.cost_usd;

/**
 * Turns `(day, provider_type)` rows into one row per day with a column per
 * series. The series are the busiest providers over the whole range, largest
 * first, and everything behind them is summed into one `Other` band. Ranking
 * by the range total rather than per day keeps a provider in the same band on
 * every column.
 */
export function pivot(buckets: TimeseriesBucket[], from: string, to: string, metric: Metric) {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    totals.set(bucket.provider_type, (totals.get(bucket.provider_type) ?? 0) + metricOf(bucket, metric));
  }
  const ranked = [...totals.entries()]
    // Ties broken by name, so an all-zero range is ordered the same way twice running.
    .sort(([leftName, left], [rightName, right]) => right - left || (leftName < rightName ? -1 : leftName > rightName ? 1 : 0))
    .map(([provider]) => provider);
  const named = ranked.slice(0, MAX_SERIES);
  const folded = new Set(ranked.slice(MAX_SERIES));
  const series: Series[] = (folded.size > 0 ? [...named, OTHER] : named).map((provider, index) => ({ key: `s${index}`, provider }));
  const keyOf = new Map(series.map((entry) => [entry.provider, entry.key]));
  const otherKey = keyOf.get(OTHER);

  const byDate = new Map<string, Record<string, number>>();
  for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    byDate.set(day.toISOString().slice(0, 10), Object.fromEntries(series.map((entry) => [entry.key, 0])));
  }
  for (const bucket of buckets) {
    const row = byDate.get(bucket.day);
    if (!row) continue;
    const key = folded.has(bucket.provider_type) ? otherKey! : keyOf.get(bucket.provider_type)!;
    row[key] = (row[key] ?? 0) + metricOf(bucket, metric);
  }
  return {
    series,
    /** How many providers the `Other` band stands for, for the legend to say. */
    foldedCount: folded.size,
    rows: [...byDate.entries()].map(([date, values]): ChartColumn => ({ date, ...values })),
  };
}
