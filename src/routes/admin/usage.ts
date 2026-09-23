import { Hono } from "hono";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { projectPendingAppMonthSpend } from "../../core/app-usage-accounting";
import { GatewayError } from "../../core/errors";
import { log } from "../../core/log";
import type { ProviderType } from "../../core/types";
import { computeCost, hasTokenModelPrice } from "../../core/pricing";
import { UsageRepriceRequestSchema } from "../../contracts/schemas";
import { adminRouter } from "../catalog-router";
import { jsonBody } from "./body";
import { database } from "../../db";
import { appUsageEvent, provider as providerTable } from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import {
  assertMonth,
  currentMonth,
  inRange,
  isRollupDimension,
  parseRange,
  usageBreakdown,
  usageMonthTotals,
  usageTimeseries,
  usageTotals,
} from "../../management/usage-queries";
import { parseLimit } from "./shared";

export const usageRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(usageRoutes);

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

const USAGE_STATUSES = ["ok", "provider_error", "blocked_app_rate", "blocked_app_budget", "blocked_billing", "blocked_user"] as const;
type UsageStatusFilter = (typeof USAGE_STATUSES)[number];

const REPRICE_UPDATE_CHUNK = 500;
const FREE_SUBREQUEST_LIMIT = 50;
// Authentication, the event/provider read, projection select, response work,
// and slack share the same invocation limit as update and delivery calls.
const REPRICE_FIXED_QUERY_ALLOWANCE = 11;
const QUERIES_PER_PROJECTION = 3;

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

/** Six zeros, for the month an aggregate could somehow answer nothing for. */
const EMPTY_MONTH_TOTALS = {
  requests: 0,
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
};

routes.handle("getAppUsage", async (c) => {
  const appId = c.req.param("app");
  const month = c.req.query("month") ?? currentMonth();
  assertMonth(month);
  // `.first()` is typed nullable, though an aggregate with no GROUP BY always
  // answers with one row. Filled in rather than spread away, so the documented
  // shape holds even if that ever stops being true: six zeros is the honest
  // answer for a month with nothing in it.
  const row = (await usageMonthTotals(c.env.DB, appId, month)) ?? EMPTY_MONTH_TOTALS;
  return { app_id: appId, month, ...row };
});

routes.handle("repriceAppUsage", async (c) => {
  const appId = c.req.param("app");
  const parsed = UsageRepriceRequestSchema.safeParse(await jsonBody(c));
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
      eq(providerTable.organizationId, c.get("actor").organizationId),
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
    const updates: D1PreparedStatement[] = [];
    for (let offset = 0; offset < repriced.length; offset += REPRICE_UPDATE_CHUNK) {
      const chunk = repriced.slice(offset, offset + REPRICE_UPDATE_CHUNK);
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
      const changes = JSON.stringify(chunk.map((row) => ({
        id: row.id,
        cost: row.costUsd,
        metered: row.metered ? 1 : 0,
      })));
      // Each chunk is one D1 subrequest. The row triggers still apply every
      // delta separately, so a concurrent live event composes with repricing.
      updates.push(c.env.DB.prepare(
        `WITH changes AS (
           SELECT
             CAST(json_extract(value, '$.id') AS INTEGER) AS id,
             CAST(json_extract(value, '$.cost') AS REAL) AS cost,
             CAST(json_extract(value, '$.metered') AS INTEGER) AS metered
           FROM json_each(?)
         )
         UPDATE app_usage_event SET
           cost_usd = (SELECT cost FROM changes WHERE changes.id = app_usage_event.id),
           cost_source = CASE
             WHEN (SELECT metered FROM changes WHERE changes.id = app_usage_event.id) = 1
             THEN 'computed' ELSE cost_source END
         WHERE app_id = ? AND id IN (SELECT id FROM changes)`,
      ).bind(changes, appId));
    }
    // One transaction preserves the endpoint's all-or-nothing apply contract;
    // each statement still counts against the invocation's query allowance.
    await c.env.DB.batch(updates);
    const updateQueries = updates.length;
    const projectionLimit = Math.max(0, Math.min(
      12,
      Math.floor(
        (FREE_SUBREQUEST_LIMIT - REPRICE_FIXED_QUERY_ALLOWANCE - updateQueries)
        / QUERIES_PER_PROJECTION,
      ),
    ));
    try {
      const projected = await projectPendingAppMonthSpend(c.env, appId, month, projectionLimit);
      reconciledUsers = projected.projectedUsers;
    } catch (error) {
      // D1 already marked every changed row pending, so recovery owns the rest.
      log("error", "usage_reprice_projection_failed", {
        appId,
        month,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
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
  };
});

/** Daily buckets split by provider; the console pivots them into a stacked chart. */
routes.handle("getAppUsageTimeseries", async (c) => {
  const appId = c.req.param("app");
  const range = parseRange(c.req.query("from"), c.req.query("to"));
  const { results } = await usageTimeseries(c.env.DB, appId, range);
  return { app_id: appId, ...range, buckets: results };
});

routes.handle("getAppUsageBreakdown", async (c) => {
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
  const limit = parseLimit(c.req.query("limit"), 50, 200);
  // The three dimensions the rollup carries are answered from both tables, back
  // to the oldest day bucket; the rest exist only on raw events and so reach back
  // only through the retention window.
  if (isRollupDimension(by)) {
    const { results } = await usageBreakdown(c.env.DB, appId, range, by, limit);
    return { app_id: appId, by, ...range, rows: results };
  }
  const column = BREAKDOWN_COLUMNS[by as BreakdownKey];
  const rows = await database(c.env.DB)
    .select({ key: column, ...usageTotals })
    .from(appUsageEvent)
    .where(inRange(appId, range))
    .groupBy(column)
    .orderBy(desc(usageTotals.requests))
    .limit(limit);
  return { app_id: appId, by, ...range, rows };
});

routes.handle("listAppEvents", async (c) => {
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

  return {
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
      client_aborted: row.clientAborted,
      latency_ms: row.latencyMs,
      created_at: row.createdAt,
    })),
  };
});
