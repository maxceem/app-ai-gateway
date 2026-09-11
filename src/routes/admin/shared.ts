import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { GatewayError } from "../../core/errors";
import { appUsageEvent } from "../../db/schema";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH = /^\d{4}-\d{2}$/u;

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Rejects a caller-supplied month before it reaches a query. */
export function assertMonth(month: string): void {
  if (!MONTH.test(month)) {
    throw new GatewayError(400, "invalid_request", "month must use YYYY-MM format");
  }
}

export function monthBounds(month: string): { from: string; to: string } {
  assertMonth(month);
  const [year, index] = month.split("-").map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year!, index! - 1, 1));
  const end = new Date(Date.UTC(year!, index!, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export interface DateRange {
  from: string;
  to: string;
}

/** Inclusive day range, defaulting to the trailing `days` window ending today. */
export function parseRange(from: string | undefined, to: string | undefined, days = 30): DateRange {
  for (const [label, value] of [["from", from], ["to", to]] as const) {
    if (value !== undefined && !DAY.test(value)) {
      throw new GatewayError(400, "invalid_request", `${label} must use YYYY-MM-DD format`);
    }
  }
  const end = to ?? new Date().toISOString().slice(0, 10);
  const start =
    from ?? new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  if (start > end) {
    throw new GatewayError(400, "invalid_request", "from must not be after to");
  }
  return { from: start, to: end };
}

/** `created_at` is `YYYY-MM-DD HH:MM:SS`, so the day prefix compares lexically. */
export const eventDay = sql<string>`substr(${appUsageEvent.createdAt}, 1, 10)`;

export function inRange(appId: string, range: DateRange): SQL | undefined {
  return and(eq(appUsageEvent.appId, appId), gte(eventDay, range.from), lte(eventDay, range.to));
}

export const usageTotals = {
  requests: sql<number>`COUNT(*)`,
  input_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.inputTokens}), 0)`,
  cached_input_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.cachedInputTokens}), 0)`,
  cache_write_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.cacheWriteTokens}), 0)`,
  output_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.outputTokens}), 0)`,
  cost_usd: sql<number>`COALESCE(SUM(${appUsageEvent.costUsd}), 0)`,
  errors: sql<number>`SUM(CASE WHEN ${appUsageEvent.status} = 'provider_error' THEN 1 ELSE 0 END)`,
  blocked: sql<number>`SUM(CASE WHEN ${appUsageEvent.status} LIKE 'blocked_%' THEN 1 ELSE 0 END)`,
};

export function parseLimit(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new GatewayError(400, "invalid_request", `limit must be an integer between 1 and ${max}`);
  }
  return limit;
}

export function parseOffset(value: string | undefined): number {
  if (value === undefined) return 0;
  const offset = Number.parseInt(value, 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new GatewayError(400, "invalid_request", "offset must be a non-negative integer");
  }
  return offset;
}

/*
 * Usage history lives in two tables, and every aggregate has to read both.
 *
 * Events inside the retention window are rows in `app_usage_event`; everything
 * older has been summed into `app_usage_rollup` and deleted. Compaction sums and
 * deletes in one transaction, so an event is in exactly one of the two places
 * and never in both — which is what lets these queries `UNION ALL` the halves
 * and add them up without double counting.
 *
 * A range that straddles the boundary draws its oldest days from the rollup and
 * the rest from raw events, including the boundary day itself, which is normally
 * split across both. Grouping the union by the same key re-joins that day.
 *
 * These are hand-written SQL rather than Drizzle because a `UNION ALL` of two
 * differently-shaped aggregates is exactly the query the builder expresses worst.
 * Every table is aliased and every column qualified: two of these join `app`,
 * which has a `status` column of its own, and an unqualified `status` there would
 * silently count the wrong thing.
 */

/** The counters, over per-event rows, where one row is one request. */
function rawTotals(t: string): string {
  return `
      COUNT(*) AS requests,
      COALESCE(SUM(${t}.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(${t}.cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(${t}.cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(${t}.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(${t}.cost_usd), 0) AS cost_usd,
      SUM(CASE WHEN ${t}.status = 'provider_error' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN ${t}.status LIKE 'blocked_%' THEN 1 ELSE 0 END) AS blocked`;
}

/**
 * The same counters over pre-summed rows, where each row already stands for
 * `requests` events and the two status counters therefore weigh by it rather
 * than counting rows.
 */
function rollupTotals(t: string): string {
  return `
      COALESCE(SUM(${t}.requests), 0) AS requests,
      COALESCE(SUM(${t}.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(${t}.cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(${t}.cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(${t}.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(${t}.cost_usd), 0) AS cost_usd,
      SUM(CASE WHEN ${t}.status = 'provider_error' THEN ${t}.requests ELSE 0 END) AS errors,
      SUM(CASE WHEN ${t}.status LIKE 'blocked_%' THEN ${t}.requests ELSE 0 END) AS blocked`;
}

/** Re-sums the union's two already-grouped halves into one row per key. */
const UNION_TOTALS = `
    SUM(requests) AS requests,
    SUM(input_tokens) AS input_tokens,
    SUM(cached_input_tokens) AS cached_input_tokens,
    SUM(cache_write_tokens) AS cache_write_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cost_usd) AS cost_usd,
    SUM(errors) AS errors,
    SUM(blocked) AS blocked`;

export interface UsageBucket {
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number;
  errors: number;
  blocked: number;
}

/** The six figures the month summary endpoint has always reported. */
export type MonthTotals = Omit<UsageBucket, "errors" | "blocked">;

/**
 * Which `by` values survive compaction.
 *
 * The rollup keeps no per-event or per-user dimension, so a breakdown by user,
 * route, endpoint, app version, credential source, cost source, provider slug or
 * provider gateway can only answer from raw events, and therefore only reaches
 * back as far as the retention window. Those keep the unmodified per-event query;
 * these three read the union as well, and so reach back as far as day buckets
 * exist — see {@link usageBreakdown} for where that stops.
 */
export const ROLLUP_DIMENSIONS = {
  model: "model",
  provider: "provider_type",
  status: "status",
} as const;

export type RollupDimension = keyof typeof ROLLUP_DIMENSIONS;

export function isRollupDimension(by: string): by is RollupDimension {
  return Object.hasOwn(ROLLUP_DIMENSIONS, by);
}

/**
 * Daily buckets split by provider, across both tables.
 *
 * Only `grain = 'day'` rollup rows can appear: a month bucket has no day to plot,
 * and spreading one back over thirty identical days would invent detail that was
 * deliberately discarded. A range reaching past the day-grain window is answered
 * as far back as day resolution exists, and no further.
 */
export function usageTimeseries(
  db: D1Database,
  appId: string,
  range: DateRange,
): Promise<{ results: (UsageBucket & { date: string; provider: string })[] }> {
  return db
    .prepare(`
SELECT date, provider,${UNION_TOTALS}
FROM (
  SELECT
      substr(events.created_at, 1, 10) AS date,
      events.provider_type AS provider,${rawTotals("events")}
  FROM app_usage_event AS events
  WHERE events.app_id = ?1
    AND substr(events.created_at, 1, 10) >= ?2
    AND substr(events.created_at, 1, 10) <= ?3
  GROUP BY date, provider
  UNION ALL
  SELECT
      rollup.bucket AS date,
      rollup.provider_type AS provider,${rollupTotals("rollup")}
  FROM app_usage_rollup AS rollup
  WHERE rollup.app_id = ?1
    AND rollup.grain = 'day'
    AND rollup.bucket >= ?2
    AND rollup.bucket <= ?3
  GROUP BY date, provider
)
GROUP BY date, provider
ORDER BY date`)
    .bind(appId, range.from, range.to)
    .all();
}

/**
 * One dimension's totals across both tables, largest first.
 *
 * Reaches back as far as day buckets go, and no further. An arbitrary day range
 * cannot be answered from a month bucket — the range may start mid-month, and
 * splitting a month across it would be invention — so a range extending past the
 * day-grain window silently omits the folded part rather than guessing at it. The
 * console never asks for one: its widest range is 90 days. A direct API caller
 * can, and gets a short answer.
 */
export function usageBreakdown(
  db: D1Database,
  appId: string,
  range: DateRange,
  by: RollupDimension,
  limit: number,
): Promise<{ results: (UsageBucket & { key: string })[] }> {
  // Interpolated because a column name cannot be a bound parameter. The value is
  // a lookup on ROLLUP_DIMENSIONS, never caller text.
  const column = ROLLUP_DIMENSIONS[by];
  return db
    .prepare(`
SELECT key,${UNION_TOTALS}
FROM (
  SELECT events.${column} AS key,${rawTotals("events")}
  FROM app_usage_event AS events
  WHERE events.app_id = ?1
    AND substr(events.created_at, 1, 10) >= ?2
    AND substr(events.created_at, 1, 10) <= ?3
  GROUP BY key
  UNION ALL
  SELECT rollup.${column} AS key,${rollupTotals("rollup")}
  FROM app_usage_rollup AS rollup
  WHERE rollup.app_id = ?1
    AND rollup.grain = 'day'
    AND rollup.bucket >= ?2
    AND rollup.bucket <= ?3
  GROUP BY key
)
GROUP BY key
ORDER BY requests DESC
LIMIT ?4`)
    .bind(appId, range.from, range.to, limit)
    .all();
}

/**
 * One calendar month's totals for one app, across both tables and both grains.
 *
 * Matched on the month prefix of `bucket` with no grain filter, because a month
 * is held as day buckets until it is folded and as one month bucket afterwards,
 * never as both. `errors` and `blocked` are summed by the halves and then
 * dropped: this endpoint has never reported them, and widening a documented
 * response is not this change's business.
 */
export function usageMonthTotals(
  db: D1Database,
  appId: string,
  month: string,
): Promise<MonthTotals | null> {
  return db
    .prepare(`
SELECT
    COALESCE(SUM(requests), 0) AS requests,
    COALESCE(SUM(input_tokens), 0) AS input_tokens,
    COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
    COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens,
    COALESCE(SUM(cost_usd), 0) AS cost_usd
FROM (
  SELECT${rawTotals("events")}
  FROM app_usage_event AS events
  WHERE events.app_id = ?1 AND substr(events.created_at, 1, 7) = ?2
  UNION ALL
  SELECT${rollupTotals("rollup")}
  FROM app_usage_rollup AS rollup
  WHERE rollup.app_id = ?1 AND substr(rollup.bucket, 1, 7) = ?2
)`)
    .bind(appId, month)
    .first<MonthTotals>();
}

/**
 * One calendar month's totals for every app an organization owns.
 *
 * Matched on the month prefix rather than on {@link monthBounds}, so it reads day
 * and month grains alike: a `YYYY-MM` bucket does not fall inside a `YYYY-MM-DD`
 * range, and comparing the two would drop every folded month.
 */
export function organizationMonthUsage(
  db: D1Database,
  organizationId: string,
  month: string,
): Promise<{ results: (UsageBucket & { app_id: string })[] }> {
  return db
    .prepare(`
SELECT app_id,${UNION_TOTALS}
FROM (
  SELECT events.app_id AS app_id,${rawTotals("events")}
  FROM app_usage_event AS events
  JOIN app AS owner ON owner.id = events.app_id
  WHERE owner.organization_id = ?1 AND substr(events.created_at, 1, 7) = ?2
  GROUP BY app_id
  UNION ALL
  SELECT rollup.app_id AS app_id,${rollupTotals("rollup")}
  FROM app_usage_rollup AS rollup
  JOIN app AS owner ON owner.id = rollup.app_id
  WHERE owner.organization_id = ?1 AND substr(rollup.bucket, 1, 7) = ?2
  GROUP BY app_id
)
GROUP BY app_id`)
    .bind(organizationId, month)
    .all();
}
