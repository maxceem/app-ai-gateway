import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { GatewayError } from "../../core/errors";
import { usageEvents } from "../../db/schema";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH = /^\d{4}-\d{2}$/u;

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function monthBounds(month: string): { from: string; to: string } {
  if (!MONTH.test(month)) {
    throw new GatewayError(400, "invalid_request", "month must use YYYY-MM format");
  }
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
export const eventDay = sql<string>`substr(${usageEvents.createdAt}, 1, 10)`;

export function inRange(appId: string, range: DateRange): SQL | undefined {
  return and(eq(usageEvents.appId, appId), gte(eventDay, range.from), lte(eventDay, range.to));
}

export const usageTotals = {
  requests: sql<number>`COUNT(*)`,
  input_tokens: sql<number>`COALESCE(SUM(${usageEvents.inputTokens}), 0)`,
  cached_input_tokens: sql<number>`COALESCE(SUM(${usageEvents.cachedInputTokens}), 0)`,
  cache_write_tokens: sql<number>`COALESCE(SUM(${usageEvents.cacheWriteTokens}), 0)`,
  output_tokens: sql<number>`COALESCE(SUM(${usageEvents.outputTokens}), 0)`,
  cost_usd: sql<number>`COALESCE(SUM(${usageEvents.costUsd}), 0)`,
  errors: sql<number>`SUM(CASE WHEN ${usageEvents.status} = 'provider_error' THEN 1 ELSE 0 END)`,
  blocked: sql<number>`SUM(CASE WHEN ${usageEvents.status} LIKE 'blocked_%' THEN 1 ELSE 0 END)`,
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
