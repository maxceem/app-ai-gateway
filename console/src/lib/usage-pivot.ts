/**
 * The usage timeseries as a stacked chart reads it.
 *
 * The API answers with one row per `(date, provider)`; a stacked bar wants one
 * row per day with a column per series, and it wants the same providers in the
 * same bands on every column. That transposition is arithmetic with a ranking
 * and a fold in it, so it lives here rather than beside the chart.
 */

import { totalTokens } from "@/lib/format";
import type { TimeseriesBucket } from "@/lib/types";

/** Which number of a bucket the chart is drawing. */
export type Metric = "cost_usd" | "requests" | "tokens";

/** One column of the chart: the day, then one total per series key. */
export interface ChartColumn {
  date: string;
  [series: string]: string | number;
}

/**
 * The band every provider past the seventh is summed into. Eight bands is
 * already the most a reader can hold against a legend; past that, a colour
 * stops naming anything and two neighbouring segments of the same hue are two
 * different providers. Its key cannot collide with a provider type, which is
 * why it is not simply "other".
 */
export const OTHER = "__other";

/**
 * Named series before the tail, then {@link OTHER}. The palette in `usage.tsx`
 * has exactly this many hues, and a series past it gets no hue of its own.
 */
export const MAX_SERIES = 7;

const metricOf = (bucket: TimeseriesBucket, metric: Metric): number =>
  metric === "tokens" ? totalTokens(bucket) : metric === "requests" ? bucket.requests : bucket.cost_usd;

/**
 * Turns `(date, provider)` rows into one row per day with a column per series.
 *
 * The series are the busiest providers over the whole range, largest first, and
 * everything behind them is summed into one `Other` band — so the stack carries
 * at most eight, which is as many as its palette has hues. Ranking by the range
 * total rather than per day keeps a provider in the same band on every column.
 */
export function pivot(buckets: TimeseriesBucket[], from: string, to: string, metric: Metric) {
  const totals = new Map<string, number>();
  for (const bucket of buckets) {
    totals.set(bucket.provider, (totals.get(bucket.provider) ?? 0) + metricOf(bucket, metric));
  }
  const ranked = [...totals.entries()]
    // Ties broken by name, so an all-zero range is still ordered the same way
    // twice running rather than by whatever order the rows arrived in.
    .sort(([leftName, left], [rightName, right]) =>
      right - left || (leftName < rightName ? -1 : leftName > rightName ? 1 : 0),
    )
    .map(([provider]) => provider);
  const named = ranked.slice(0, MAX_SERIES);
  const folded = new Set(ranked.slice(MAX_SERIES));
  const providers = folded.size > 0 ? [...named, OTHER] : named;

  const byDate = new Map<string, Record<string, number>>();
  for (
    let day = new Date(`${from}T00:00:00Z`);
    day <= new Date(`${to}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    const date = day.toISOString().slice(0, 10);
    byDate.set(date, Object.fromEntries(providers.map((provider) => [provider, 0])));
  }
  for (const bucket of buckets) {
    const row = byDate.get(bucket.date);
    if (!row) continue;
    const key = folded.has(bucket.provider) ? OTHER : bucket.provider;
    row[key] = (row[key] ?? 0) + metricOf(bucket, metric);
  }
  return {
    providers,
    /** How many providers the `Other` band stands for, for the legend to say. */
    foldedCount: folded.size,
    rows: [...byDate.entries()].map(([date, values]): ChartColumn => ({ date, ...values })),
  };
}
