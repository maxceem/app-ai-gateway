import { Hono } from "hono";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { GatewayError } from "../../core/errors";
import type { ProviderType } from "../../core/types";
import { computeCost, hasTokenModelPrice } from "../../core/usage";
import { UsageRepriceRequestSchema } from "../../contracts/schemas";
import { database } from "../../db";
import { appUsageEvent } from "../../db/schema";
import type { UserLimiter } from "../../do/UserLimiter";
import type { AdminVariables } from "../../middleware/admin";
import { currentMonth, eventDay, inRange, parseLimit, parseRange, usageTotals } from "./shared";

export const usageRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

const BREAKDOWN_COLUMNS = {
  model: appUsageEvent.model,
  provider: appUsageEvent.providerType,
  user: appUsageEvent.userId,
  status: appUsageEvent.status,
  route: appUsageEvent.route,
  endpoint: appUsageEvent.endpointSlug,
  app_version: appUsageEvent.appVersion,
} as const;

type BreakdownKey = keyof typeof BREAKDOWN_COLUMNS;

const USAGE_STATUSES = ["ok", "provider_error", "blocked_rate", "blocked_budget", "blocked_user"] as const;
type UsageStatusFilter = (typeof USAGE_STATUSES)[number];

usageRoutes.get("/apps/:app/usage", async (c) => {
  const appId = c.req.param("app");
  const month = c.req.query("month") ?? currentMonth();
  if (!/^\d{4}-\d{2}$/u.test(month)) {
    throw new GatewayError(400, "invalid_request", "month must use YYYY-MM format");
  }
  const row = await database(c.env.DB)
    .select({
      requests: sql<number>`COUNT(*)`,
      input_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.inputTokens}), 0)`,
      cached_input_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.cachedInputTokens}), 0)`,
      cache_write_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.cacheWriteTokens}), 0)`,
      output_tokens: sql<number>`COALESCE(SUM(${appUsageEvent.outputTokens}), 0)`,
      cost_usd: sql<number>`COALESCE(SUM(${appUsageEvent.costUsd}), 0)`,
    })
    .from(appUsageEvent)
    .where(and(
      eq(appUsageEvent.appId, appId),
      eq(sql`substr(${appUsageEvent.createdAt}, 1, 7)`, month),
    ))
    .get();
  return c.json({ app_id: appId, month, ...row });
});

usageRoutes.post("/apps/:app/usage/reprice", async (c) => {
  const appId = c.req.param("app");
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
  const parsed = UsageRepriceRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new GatewayError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid request");
  }
  const { provider, model, month, apply } = parsed.data;
  if (!hasTokenModelPrice(provider, model)) {
    throw new GatewayError(400, "invalid_request", `No token price is configured for ${provider}/${model}`);
  }

  const rows = await database(c.env.DB)
    .select({
      id: appUsageEvent.id,
      inputTokens: appUsageEvent.inputTokens,
      cachedInputTokens: appUsageEvent.cachedInputTokens,
      cacheWriteTokens: appUsageEvent.cacheWriteTokens,
      outputTokens: appUsageEvent.outputTokens,
      costUsd: appUsageEvent.costUsd,
    })
    .from(appUsageEvent)
    .where(and(
      eq(appUsageEvent.appId, appId),
      eq(appUsageEvent.providerType, provider),
      eq(appUsageEvent.model, model),
      eq(sql`substr(${appUsageEvent.createdAt}, 1, 7)`, month),
    ))
    .limit(10_001);
  if (rows.length > 10_000) {
    throw new GatewayError(400, "invalid_request", "Repricing is limited to 10,000 events per operation");
  }

  const repriced = rows.map((row) => {
    const costUsd = computeCost(provider as ProviderType, model, row);
    if (costUsd === null) {
      throw new GatewayError(400, "invalid_request", `Unable to compute a token price for ${provider}/${model}`);
    }
    return { id: row.id, previousCostUsd: row.costUsd, costUsd };
  });
  const previousCostUsd = repriced.reduce((total, row) => total + row.previousCostUsd, 0);
  const recalculatedCostUsd = repriced.reduce((total, row) => total + row.costUsd, 0);

  let reconciledUsers = 0;
  if (apply && repriced.length > 0) {
    for (let offset = 0; offset < repriced.length; offset += 100) {
      const chunk = repriced.slice(offset, offset + 100);
      await c.env.DB.batch(chunk.map((row) => c.env.DB
        .prepare("UPDATE app_usage_event SET cost_usd = ? WHERE id = ? AND app_id = ?")
        .bind(row.costUsd, row.id, appId)));
    }

    const monthFilter = and(
      eq(appUsageEvent.appId, appId),
      eq(sql`substr(${appUsageEvent.createdAt}, 1, 7)`, month),
    );
    const userTotals = await database(c.env.DB)
      .select({
        userId: appUsageEvent.userId,
        microusd: sql<number>`CAST(COALESCE(SUM(ROUND(${appUsageEvent.costUsd} * 1000000)), 0) AS INTEGER)`,
      })
      .from(appUsageEvent)
      .where(monthFilter)
      .groupBy(appUsageEvent.userId);
    for (const total of userTotals) {
      const limiter = c.env.USER_LIMITER.getByName(`${appId}:${total.userId}`) as DurableObjectStub<UserLimiter>;
      await limiter.reconcileMonth(month, total.microusd);
    }
    reconciledUsers = userTotals.length;

    const appTotal = await database(c.env.DB)
      .select({
        microusd: sql<number>`CAST(COALESCE(SUM(ROUND(${appUsageEvent.costUsd} * 1000000)), 0) AS INTEGER)`,
      })
      .from(appUsageEvent)
      .where(monthFilter)
      .get();
    const appLimiter = c.env.USER_LIMITER.getByName(appId) as DurableObjectStub<UserLimiter>;
    await appLimiter.reconcileMonth(month, appTotal?.microusd ?? 0);
  }

  return c.json({
    app_id: appId,
    provider,
    model,
    month,
    applied: apply,
    matched_events: repriced.length,
    previous_cost_usd: previousCostUsd,
    recalculated_cost_usd: recalculatedCostUsd,
    delta_usd: recalculatedCostUsd - previousCostUsd,
    reconciled_users: reconciledUsers,
  });
});

/** Daily buckets split by provider; the console pivots them into a stacked chart. */
usageRoutes.get("/apps/:app/usage/timeseries", async (c) => {
  const appId = c.req.param("app");
  const range = parseRange(c.req.query("from"), c.req.query("to"));
  const rows = await database(c.env.DB)
    .select({ date: eventDay, provider: appUsageEvent.providerType, ...usageTotals })
    .from(appUsageEvent)
    .where(inRange(appId, range))
    .groupBy(eventDay, appUsageEvent.providerType)
    .orderBy(eventDay);
  return c.json({ app_id: appId, ...range, buckets: rows });
});

usageRoutes.get("/apps/:app/usage/breakdown", async (c) => {
  const appId = c.req.param("app");
  const range = parseRange(c.req.query("from"), c.req.query("to"));
  const by = c.req.query("by") ?? "model";
  if (!Object.hasOwn(BREAKDOWN_COLUMNS, by)) {
    throw new GatewayError(
      400,
      "invalid_request",
      `by must be one of ${Object.keys(BREAKDOWN_COLUMNS).join(", ")}`,
    );
  }
  const column = BREAKDOWN_COLUMNS[by as BreakdownKey];
  const limit = parseLimit(c.req.query("limit"), 50, 200);
  const rows = await database(c.env.DB)
    .select({ key: column, ...usageTotals })
    .from(appUsageEvent)
    .where(inRange(appId, range))
    .groupBy(column)
    .orderBy(desc(usageTotals.requests))
    .limit(limit);
  return c.json({ app_id: appId, by, ...range, rows });
});

usageRoutes.get("/apps/:app/events", async (c) => {
  const appId = c.req.param("app");
  const limit = parseLimit(c.req.query("limit"), 50, 200);
  const filters = [eq(appUsageEvent.appId, appId)];

  const status = c.req.query("status");
  if (status) {
    if (!USAGE_STATUSES.includes(status as UsageStatusFilter)) {
      throw new GatewayError(400, "invalid_request", `status must be one of ${USAGE_STATUSES.join(", ")}`);
    }
    filters.push(eq(appUsageEvent.status, status as UsageStatusFilter));
  }
  const provider = c.req.query("provider");
  if (provider) filters.push(eq(appUsageEvent.providerType, provider));
  const user = c.req.query("user");
  if (user) filters.push(eq(appUsageEvent.userId, user));
  const model = c.req.query("model");
  if (model) filters.push(eq(appUsageEvent.model, model));

  const before = c.req.query("before_id");
  if (before !== undefined) {
    const cursor = Number.parseInt(before, 10);
    if (!Number.isInteger(cursor) || cursor < 1) {
      throw new GatewayError(400, "invalid_request", "before_id must be a positive integer");
    }
    filters.push(lt(appUsageEvent.id, cursor));
  }

  const rows = await database(c.env.DB)
    .select()
    .from(appUsageEvent)
    .where(and(...filters))
    .orderBy(desc(appUsageEvent.id))
    .limit(limit);

  return c.json({
    app_id: appId,
    limit,
    next_before_id: rows.length === limit ? rows[rows.length - 1]!.id : null,
    events: rows.map((row) => ({
      id: row.id,
      user_id: row.userId,
      api_key_id: row.apiKeyId,
      provider: row.providerType,
      model: row.model,
      route: row.route,
      endpoint_slug: row.endpointSlug,
      input_tokens: row.inputTokens,
      cached_input_tokens: row.cachedInputTokens,
      cache_write_tokens: row.cacheWriteTokens,
      output_tokens: row.outputTokens,
      cost_usd: row.costUsd,
      app_version: row.appVersion,
      auth_method: row.authMethod,
      status: row.status,
      latency_ms: row.latencyMs,
      created_at: row.createdAt,
    })),
  });
});
