import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { ParsedOperationQuery } from "../contracts/catalog";
import type { RejectionEventList } from "../contracts/responses";
import { database } from "../db";
import { appRejectionEvent, type app } from "../db/schema";
import type { Actor } from "./actor";
import type { ManagementScope } from "./scope";
import { parseRange } from "./usage-queries";

type AppRow = typeof app.$inferSelect;
const rejectionDay = sql<string>`substr(${appRejectionEvent.createdAt}, 1, 10)`;

export async function listAppRejectionEvents(
  scope: ManagementScope,
  _actor: Actor,
  appRow: AppRow,
  query: ParsedOperationQuery<"listAppRejectionEvents">,
): Promise<RejectionEventList> {
  // Either bound may stand alone; ordering matters only when both are given.
  if (query.from && query.to) parseRange(query.from, query.to);
  const filters = [eq(appRejectionEvent.appId, appRow.id)];
  if (query.reason) filters.push(eq(appRejectionEvent.reason, query.reason));
  if (query.scope) filters.push(eq(appRejectionEvent.scope, query.scope));
  if (query.user) filters.push(eq(appRejectionEvent.userId, query.user));
  if (query.before_id !== undefined) filters.push(lt(appRejectionEvent.id, query.before_id));
  if (query.from) filters.push(gte(rejectionDay, query.from));
  if (query.to) filters.push(lte(rejectionDay, query.to));
  const rows = await database(scope.env.DB)
    .select().from(appRejectionEvent)
    .where(and(...filters))
    .orderBy(desc(appRejectionEvent.id))
    .limit(query.limit);
  return {
    app_id: appRow.id,
    limit: query.limit,
    next_before_id: rows.length === query.limit ? rows.at(-1)!.id : null,
    events: rows.map((row) => ({
      id: row.id,
      user_id: row.userId,
      api_key_id: row.apiKeyId,
      reason: row.reason,
      scope: row.scope,
      provider_slug: row.providerSlug,
      model: row.model,
      route: row.route,
      endpoint_slug: row.endpointSlug,
      app_version: row.appVersion,
      auth_method: row.authMethod,
      latency_ms: row.latencyMs,
      created_at: row.createdAt,
    })),
  };
}
