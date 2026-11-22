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

/**
 * Which number of a bucket the chart is drawing. `charges` is v1's requests.
 * Cost is drawn in whole nano-dollars, so the axis can ask for whole ticks: a
 * tick between two nano-dollars would read as `$0.` or repeat its neighbour's
 * label. The page shows it in dollars.
 */
export type Metric = "cost_nano" | "charges" | "tokens";

/**
 * A band of the chart. Its key is generated (`s0`, `s1`…), never the provider's
 * name: a name is data, and as a key it could collide with `date` or end up in
 * the chart's style sheet. The name is shown as text only.
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
  metric === "tokens" ? totalTokens(bucket) : metric === "charges" ? bucket.charges : bucket.cost_nano;

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

/**
 * The chart's value axis: ticks at whole steps of 1, 2 or 5 times a power of
 * ten, from just below `min` to just past `max`, about four intervals. Steps
 * are whole units (nano-dollars, charges, tokens), so a tick never falls
 * between two of them. The page labels each tick with its step's precision
 * ({@link formatAxisCost}), so neighbouring ticks never share a label. `min` is
 * below zero only when a day's corrections took back more than that day
 * charged (a session's correction booked the day after its estimate): the
 * axis then runs below zero too, and stops at zero when nothing is above it.
 * A chart of only zeros runs up to `emptyTop` (the page gives cost a cent), so
 * its one label above zero stays short.
 */
export function axisTicks(max: number, min = 0, emptyTop = 1): { ticks: number[]; step: number } {
  const bottom = Math.min(0, Math.floor(min));
  let top = Math.max(0, Math.ceil(max));
  if (top === 0 && bottom === 0) top = Math.max(1, Math.ceil(emptyTop));
  const rough = Math.max(1, top - bottom) / 4;
  const power = 10 ** Math.floor(Math.log10(Math.max(1, rough)));
  const step = Math.max(1, [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? 10 * power);
  const ticks: number[] = [Math.floor(bottom / step) * step];
  while (ticks.at(-1)! < top) ticks.push(ticks.at(-1)! + step);
  return { ticks, step };
}

/**
 * How far the stacked columns reach: `max`, the tallest stack of positive
 * values, and `min`, the deepest stack of negative ones (0 when none). The
 * chart stacks each sign apart around zero, so a negative correction never
 * sits on top of another provider's spend.
 */
export function stackedBounds(rows: ChartColumn[]): { min: number; max: number } {
  let max = 0;
  let min = 0;
  for (const row of rows) {
    let up = 0;
    let down = 0;
    for (const [key, value] of Object.entries(row)) {
      if (key === "date" || typeof value !== "number") continue;
      if (value >= 0) up += value;
      else down += value;
    }
    max = Math.max(max, up);
    min = Math.min(min, down);
  }
  return { min, max };
}

/**
 * An axis tick in nano-dollars, as dollars with as many decimals as the step
 * between ticks needs (at least cents), so ticks a step apart always read
 * differently: with a step of $0.005, `$0.015` and `$0.020`. A tick below zero
 * reads `-$0.010`.
 */
export function formatAxisCost(nano: number, stepNano: number): string {
  if (nano === 0) return "$0";
  const decimals = Math.min(9, Math.max(2, -Math.floor(Math.log10(stepNano / 1e9) + 1e-9)));
  return `${nano < 0 ? "-" : ""}$${(Math.abs(nano) / 1e9).toFixed(decimals)}`;
}
