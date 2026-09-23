import { Hono } from "hono";
import { and, desc, eq, gte, isNotNull, lt, lte, sql } from "drizzle-orm";
import { database } from "../../db";
import { appAuthEvent, appUsageEvent, appUser } from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";
import { parseRange } from "../../management/usage-queries";

export const authEventRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(authEventRoutes);

/** `created_at` is `YYYY-MM-DD HH:MM:SS`, so the day prefix compares lexically. */
const authEventDay = sql<string>`substr(${appAuthEvent.createdAt}, 1, 10)`;
const usageEventDay = sql<string>`substr(${appUsageEvent.createdAt}, 1, 10)`;

/**
 * The value at a percentile of an ascending list, by nearest rank.
 *
 * Computed in JS rather than in SQL because the input is one window's worth of
 * claim delays — a handful of rows even during an incident — and a nearest-rank
 * definition anyone can check beats a window function nobody can read.
 */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

/**
 * Everything the "Auth & Errors" view needs about one app's recent past, in one
 * round trip's worth of queries.
 *
 * Proxy failures are folded in from `app_usage_event` on purpose: an operator
 * asking "what is broken for my users?" should not have to know which of two
 * tables a given failure landed in.
 */
routes.handle("getAppAuthEventSummary", async (c, { query }) => {
  const appId = c.req.param("app");
  const range = parseRange(undefined, undefined, query.days);
  const db = database(c.env.DB);
  const inWindow = and(
    eq(appAuthEvent.appId, appId),
    gte(authEventDay, range.from),
    lte(authEventDay, range.to),
  );

  const daily = await db
    .select({
      date: authEventDay,
      event: appAuthEvent.event,
      outcome: appAuthEvent.outcome,
      reason: appAuthEvent.reason,
      count: sql<number>`COUNT(*)`,
    })
    .from(appAuthEvent)
    .where(inWindow)
    .groupBy(authEventDay, appAuthEvent.event, appAuthEvent.outcome, appAuthEvent.reason)
    .orderBy(authEventDay);

  const usageFailures = await db
    .select({
      date: usageEventDay,
      status: appUsageEvent.status,
      count: sql<number>`COUNT(*)`,
    })
    .from(appUsageEvent)
    .where(and(
      eq(appUsageEvent.appId, appId),
      gte(usageEventDay, range.from),
      lte(usageEventDay, range.to),
      sql`${appUsageEvent.status} != 'ok'`,
    ))
    .groupBy(usageEventDay, appUsageEvent.status)
    .orderBy(usageEventDay);

  const exchanges = await db
    .select({
      total: sql<number>`COUNT(*)`,
      ok: sql<number>`SUM(CASE WHEN ${appAuthEvent.outcome} = 'ok' THEN 1 ELSE 0 END)`,
    })
    .from(appAuthEvent)
    .where(and(inWindow, eq(appAuthEvent.event, "token_exchange")))
    .get();

  const delayRows = await db
    .select({ claimDelayMs: appAuthEvent.claimDelayMs })
    .from(appAuthEvent)
    .where(and(inWindow, isNotNull(appAuthEvent.claimDelayMs)))
    .orderBy(appAuthEvent.claimDelayMs);
  const delays = delayRows
    .map((row) => row.claimDelayMs)
    .filter((value): value is number => value !== null);

  // Active users only: a blocked user's window can never close, and the number
  // is meant to be the people an operator can still do something for.
  const pending = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(appUser)
    .where(and(
      eq(appUser.appId, appId),
      eq(appUser.status, "active"),
      isNotNull(appUser.claimPendingSince),
    ))
    .get();

  const total = exchanges?.total ?? 0;
  const ok = exchanges?.ok ?? 0;
  return {
    app_id: appId,
    days: query.days,
    ...range,
    daily,
    usage_failures: usageFailures,
    token_exchange: {
      total,
      ok,
      // Null rather than 1: a window with no exchanges has no rate, and showing
      // a perfect score for an app nobody used would read as health.
      success_rate: total === 0 ? null : ok / total,
    },
    claim_delay: {
      count: delays.length,
      avg_ms: delays.length === 0
        ? null
        : Math.round(delays.reduce((sum, value) => sum + value, 0) / delays.length),
      p50_ms: percentile(delays, 0.5),
      p95_ms: percentile(delays, 0.95),
    },
    pending_users: pending?.count ?? 0,
  };
});

/** Raw rows for drill-down, newest first, paged the way usage events are. */
routes.handle("listAppAuthEvents", async (c, { query }) => {
  const appId = c.req.param("app");
  const { limit } = query;
  const filters = [eq(appAuthEvent.appId, appId)];
  if (query.outcome) filters.push(eq(appAuthEvent.outcome, query.outcome));
  if (query.event) filters.push(eq(appAuthEvent.event, query.event));
  if (query.user) filters.push(eq(appAuthEvent.userId, query.user));
  if (query.before_id !== undefined) filters.push(lt(appAuthEvent.id, query.before_id));

  const rows = await database(c.env.DB)
    .select()
    .from(appAuthEvent)
    .where(and(...filters))
    .orderBy(desc(appAuthEvent.id))
    .limit(limit);

  return {
    app_id: appId,
    limit,
    next_before_id: rows.length === limit ? rows[rows.length - 1]!.id : null,
    events: rows.map((row) => ({
      id: row.id,
      user_id: row.userId,
      event: row.event,
      auth_method: row.authMethod,
      outcome: row.outcome,
      reason: row.reason,
      app_version: row.appVersion,
      latency_ms: row.latencyMs,
      claim_delay_ms: row.claimDelayMs,
      created_at: row.createdAt,
    })),
  };
});
