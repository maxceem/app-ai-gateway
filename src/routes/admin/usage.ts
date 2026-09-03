import { Hono } from "hono";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { GatewayError } from "../../core/errors";
import type { ProviderType } from "../../core/types";
import { computeCost, hasTokenModelPrice } from "../../core/usage";
import { UsageRepriceRequestSchema } from "../../contracts/schemas";
import { database } from "../../db";
import { appUsageEvent, provider as providerTable } from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import { currentMonth, eventDay, inRange, parseLimit, parseRange, usageTotals } from "./shared";

export const usageRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

const BREAKDOWN_COLUMNS = {
  model: appUsageEvent.model,
  provider: appUsageEvent.providerType,
  provider_slug: appUsageEvent.providerSlug,
  provider_gateway: appUsageEvent.providerGatewayType,
  credential_source: appUsageEvent.credentialSource,
  model_author: appUsageEvent.modelAuthor,
  user: appUsageEvent.userId,
  status: appUsageEvent.status,
  cost_source: appUsageEvent.costSource,
  route: appUsageEvent.route,
  endpoint: appUsageEvent.endpointSlug,
  app_version: appUsageEvent.appVersion,
} as const;

type BreakdownKey = keyof typeof BREAKDOWN_COLUMNS;

const USAGE_STATUSES = ["ok", "provider_error", "blocked_rate", "blocked_budget", "blocked_user"] as const;
type UsageStatusFilter = (typeof USAGE_STATUSES)[number];

/**
 * Whether an event carries usage a price could act on.
 *
 * All-zero counts are the shape of a metering failure, not of a free request:
 * an unreadable response body, or a stream a client abandoned before the chunk
 * carrying its usage. Repricing such a row computes zero from zero, which is
 * arithmetic rather than an answer — so this is what separates a row whose cost
 * is now known from one whose cost is still unknown.
 *
 * Time-priced events never reach the caller: their models have no token price,
 * so {@link hasTokenModelPrice} excludes them before this is asked.
 */
function hasReadableCounts(row: {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}): boolean {
  return row.inputTokens + row.cachedInputTokens + row.cacheWriteTokens + row.outputTokens > 0;
}

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
  const rows = await database(c.env.DB)
    .select({
      id: appUsageEvent.id,
      providerType: appUsageEvent.providerType,
      inputTokens: appUsageEvent.inputTokens,
      cachedInputTokens: appUsageEvent.cachedInputTokens,
      cacheWriteTokens: appUsageEvent.cacheWriteTokens,
      outputTokens: appUsageEvent.outputTokens,
      costUsd: appUsageEvent.costUsd,
      pricing: providerTable.pricing,
    })
    .from(appUsageEvent)
    .leftJoin(providerTable, and(
      eq(appUsageEvent.providerId, providerTable.id),
      eq(providerTable.organizationId, c.get("admin").organizationId),
    ))
    .where(and(
      eq(appUsageEvent.appId, appId),
      eq(appUsageEvent.providerType, provider),
      eq(appUsageEvent.model, model),
      eq(sql`substr(${appUsageEvent.createdAt}, 1, 7)`, month),
      // An event billed on what the upstream charged is already the authoritative
      // figure; recomputing it from a local price would replace a fact with an
      // estimate. Written out rather than `!=` because SQL's inequality is false
      // for the NULLs on older rows, which would exclude every one of them.
      sql`(${appUsageEvent.costSource} IS NULL OR ${appUsageEvent.costSource} != 'reported')`,
    ))
    .limit(10_001);
  if (rows.length > 10_000) {
    throw new GatewayError(400, "invalid_request", "Repricing is limited to 10,000 events per operation");
  }

  // Pricing is per event, through the row that served it, so one event whose
  // provider instance was deleted can be unpriceable while its siblings are
  // fine. A dry run reports that instead of refusing to answer; only `apply`
  // insists on repricing every matched event.
  const repriced: {
    id: number;
    previousCostUsd: number;
    costUsd: number;
    metered: boolean;
  }[] = [];
  const skipped: { id: number; previousCostUsd: number }[] = [];
  for (const row of rows) {
    const providerType = row.providerType as ProviderType;
    const costUsd = hasTokenModelPrice(providerType, model, row.pricing)
      ? computeCost(providerType, model, row, row.pricing)
      : null;
    if (costUsd === null) {
      if (apply) {
        throw new GatewayError(
          400,
          "invalid_request",
          `No token price is configured for ${providerType}/${model}`,
        );
      }
      skipped.push({ id: row.id, previousCostUsd: row.costUsd });
      continue;
    }
    repriced.push({
      id: row.id,
      previousCostUsd: row.costUsd,
      costUsd,
      metered: hasReadableCounts(row),
    });
  }
  const previousCostUsd = repriced.reduce((total, row) => total + row.previousCostUsd, 0);
  const recalculatedCostUsd = repriced.reduce((total, row) => total + row.costUsd, 0);

  let reconciledUsers = 0;
  if (apply && repriced.length > 0) {
    for (let offset = 0; offset < repriced.length; offset += 100) {
      const chunk = repriced.slice(offset, offset + 100);
      // `cost_source` moves with the figure, but only where there was a figure
      // to move. A row with readable counts now has a cost the local catalog
      // stands behind, so leaving an `unresolved` marker on it would keep the
      // console hiding a cost it has and keep the alert firing for spend that
      // has since been accounted for.
      //
      // A row with *no* readable counts is the opposite case and must not be
      // touched the same way. Multiplying zero tokens by any price yields zero,
      // which looks like a computed answer and is not one: nothing was ever
      // metered, so the cost is still unknown. Claiming `computed` there would
      // convert "spend escaping the budget" into "this request was free",
      // silence the By cost source signal operators are told to watch, and hide
      // the row in the console — while the unbudgeted spend continued. Its
      // `cost_usd` is still rewritten, so a stale figure is corrected, but the
      // marker survives.
      //
      // `reported` rows never get here — they are excluded by the query above.
      await c.env.DB.batch(chunk.map((row) => c.env.DB
        .prepare(row.metered
          ? "UPDATE app_usage_event SET cost_usd = ?, cost_source = 'computed' WHERE id = ? AND app_id = ?"
          : "UPDATE app_usage_event SET cost_usd = ? WHERE id = ? AND app_id = ?")
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
      await c.env.USER_LIMITER
        .getByName(`${appId}:${total.userId}`)
        .reconcileMonth(month, total.microusd);
    }
    reconciledUsers = userTotals.length;
  }

  return c.json({
    app_id: appId,
    provider,
    model,
    month,
    applied: apply,
    matched_events: repriced.length,
    /**
     * Matched events that carried no readable usage, and so were repriced to
     * the zero their zero counts imply while keeping whatever `cost_source`
     * they had. Counted here rather than dropped from `matched_events` because
     * their `cost_usd` really is rewritten; surfaced separately because a
     * non-zero number means the month contains spend nothing could meter, which
     * repricing cannot fix and must not appear to have fixed.
     */
    unmetered_events: repriced.filter((row) => !row.metered).length,
    /** Dry-run only: matched events whose serving instance can no longer price them. */
    unpriced_events: skipped.length,
    unpriced_cost_usd: skipped.reduce((total, row) => total + row.previousCostUsd, 0),
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
      provider_slug: row.providerSlug,
      provider_gateway_id: row.providerGatewayId,
      provider_gateway_type: row.providerGatewayType,
      credential_source: row.credentialSource,
      model_author: row.modelAuthor,
      served_provider: row.servedProvider,
      served_model: row.servedModel,
      model: row.model,
      route: row.route,
      endpoint_slug: row.endpointSlug,
      input_tokens: row.inputTokens,
      cached_input_tokens: row.cachedInputTokens,
      cache_write_tokens: row.cacheWriteTokens,
      output_tokens: row.outputTokens,
      cost_usd: row.costUsd,
      reported_cost_usd: row.reportedCostUsd,
      cost_source: row.costSource,
      app_version: row.appVersion,
      auth_method: row.authMethod,
      status: row.status,
      latency_ms: row.latencyMs,
      created_at: row.createdAt,
    })),
  });
});
