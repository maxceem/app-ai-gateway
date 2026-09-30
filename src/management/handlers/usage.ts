import { and, desc, eq, lt } from "drizzle-orm";
import type { UsageBreakdownDimension } from "../../contracts/responses";
import { database } from "../../db";
import { appUsageEvent } from "../../db/schema";
import type { OperationHandlerTable } from "../executor";
import {
  currentMonth,
  inRange,
  isRollupDimension,
  parseRange,
  usageBreakdown,
  usageMonthTotals,
  usageTimeseries,
  usageTotals,
} from "../usage-queries";
import { repriceAppUsage } from "../usage-reprice";

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
} as const satisfies Record<UsageBreakdownDimension, unknown>;

export const usageHandlers = {
  getAppUsage: async ({ scope, params, query }) => {
    const appId = params.app;
    const month = query.month ?? currentMonth();
    return { app_id: appId, month, ...(await usageMonthTotals(scope.env.DB, appId, month)) };
  },

  repriceAppUsage: ({ scope, actor, app, body }) => repriceAppUsage(scope, actor, app, body),

  /** Daily buckets split by provider; the console pivots them into a stacked chart. */
  getAppUsageTimeseries: async ({ scope, params, query }) => {
    const appId = params.app;
    const range = parseRange(query.from, query.to);
    const { results } = await usageTimeseries(scope.env.DB, appId, range);
    return { app_id: appId, ...range, buckets: results };
  },

  getAppUsageBreakdown: async ({ scope, params, query }) => {
    const appId = params.app;
    const range = parseRange(query.from, query.to);
    const { by, limit } = query;
    // The three dimensions the rollup carries are answered from both tables, back
    // to the oldest day bucket; the rest exist only on raw events and so reach back
    // only through the retention window.
    if (isRollupDimension(by)) {
      const { results } = await usageBreakdown(scope.env.DB, appId, range, by, limit);
      return { app_id: appId, by, ...range, rows: results };
    }
    const column = BREAKDOWN_COLUMNS[by];
    const rows = await database(scope.env.DB)
      .select({ key: column, ...usageTotals })
      .from(appUsageEvent)
      .where(inRange(appId, range))
      .groupBy(column)
      .orderBy(desc(usageTotals.requests))
      .limit(limit);
    return { app_id: appId, by, ...range, rows };
  },

  listAppEvents: async ({ scope, params, query }) => {
    const appId = params.app;
    const { limit } = query;
    const filters = [eq(appUsageEvent.appId, appId)];
    if (query.status) filters.push(eq(appUsageEvent.status, query.status));
    if (query.provider) filters.push(eq(appUsageEvent.providerType, query.provider));
    if (query.user) filters.push(eq(appUsageEvent.userId, query.user));
    if (query.model) filters.push(eq(appUsageEvent.model, query.model));
    if (query.before_id !== undefined) filters.push(lt(appUsageEvent.id, query.before_id));

    const rows = await database(scope.env.DB)
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
  },
} satisfies OperationHandlerTable;
