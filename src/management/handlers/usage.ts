import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
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
  install: appUsageEvent.installId,
  status: sql<string>`CASE WHEN ${appUsageEvent.error} IS NULL THEN 'ok' ELSE 'provider_error' END`,
  cost_source: appUsageEvent.costSource,
  service_mode: appUsageEvent.serviceMode,
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
    // A failed event is one that records why; see `eventStatus`.
    if (query.status) filters.push(query.status === "ok" ? isNull(appUsageEvent.error) : isNotNull(appUsageEvent.error));
    if (query.provider) filters.push(eq(appUsageEvent.providerType, query.provider));
    if (query.user) filters.push(eq(appUsageEvent.userId, query.user));
    if (query.install) filters.push(eq(appUsageEvent.installId, query.install));
    if (query.model) filters.push(eq(appUsageEvent.model, query.model));
    if (query.trace) filters.push(eq(appUsageEvent.clientTraceId, query.trace));
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
        install_id: row.installId,
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
        realtime_session_id: row.realtimeSessionId,
        realtime_generation_id: row.realtimeGenerationId,
        realtime_protocol: row.realtimeProtocol as "openai_realtime" | "gemini_live" | null,
        provider_response_id: row.providerResponseId,
        completion_status: row.completionStatus,
        input_tokens: row.inputTokens,
        cached_input_tokens: row.cachedInputTokens,
        cache_write_tokens: row.cacheWriteTokens,
        output_tokens: row.outputTokens,
        cost_usd: row.costUsd,
        reported_cost_usd: row.reportedCostUsd,
        ...(row.serviceMode && { service_mode: row.serviceMode }),
        ...(row.error && { error: row.error }),
        cost_source: row.costSource,
        app_version: row.appVersion,
        auth_method: row.authMethod,
        status: row.error ? "provider_error" as const : "ok" as const,
        client_aborted: row.clientAborted,
        latency_ms: row.latencyMs,
        client_trace_id: row.clientTraceId,
        created_at: row.createdAt,
      })),
    };
  },
} satisfies OperationHandlerTable;
