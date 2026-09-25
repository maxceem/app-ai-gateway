import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { ParsedOperationQuery } from "../contracts/catalog";
import type {
  UserBlockResponse,
  UserListResponse,
  UserResponse,
  UsageTotals,
} from "../contracts/responses";
import { GatewayError } from "../core/errors";
import { database } from "../db";
import { prepared } from "../db/sql";
import { appUsageEvent, appUser, type app } from "../db/schema";
import { invalidateBlockedCache } from "../client-auth/user-status";
import type { Actor } from "./actor";
import type { ManagementScope } from "./scope";
import { currentMonth, EMPTY_USAGE_TOTALS, eventDay, monthBounds, usageTotals } from "./usage-queries";

type AppRow = typeof app.$inferSelect;

/** One row of {@link endUserIdentities}. */
export interface EndUserIdentityRow {
  app_id: string;
  id: string;
  status: "active" | "blocked";
  attest_key_id: string | null;
  attest_public_key: string | null;
  attest_counter: number;
  created_at: string;
  last_seen_at: string | null;
  is_virtual: number;
}

/**
 * The end users of an organization's applications, as an `identities` common
 * table expression for a query to begin with.
 *
 * An end user is an `app_user` row, which the token exchange writes; or, for
 * an application whose clients name their users without ever exchanging a
 * token, a user id its usage events carry and no row does. The second kind is
 * *virtual*: always active, first and last seen when its events were, and
 * never both — a user id with a row is that row. Userless traffic belongs to
 * no user, so it synthesizes none: an application that identifies nobody has
 * an empty user list, which is the true answer rather than one row standing
 * for all of it.
 *
 * Always scoped to the organization; narrowed to one application, and to one
 * user of it, when those are given.
 */
export function endUserIdentities(where: {
  organizationId: string;
  appId?: string;
  userId?: string;
}): SQL {
  const users = [sql`owner.organization_id = ${where.organizationId}`];
  const events = [sql`owner.organization_id = ${where.organizationId}`];
  if (where.appId !== undefined) {
    users.push(sql`users.app_id = ${where.appId}`);
    events.push(sql`events.app_id = ${where.appId}`);
  }
  if (where.userId !== undefined) {
    users.push(sql`users.id = ${where.userId}`);
    events.push(sql`events.user_id = ${where.userId}`);
  }
  return sql`
  WITH identities AS (
    SELECT users.app_id, users.id, users.status, users.attest_key_id, users.attest_public_key,
           users.attest_counter, users.created_at, users.last_seen_at, 0 AS is_virtual
      FROM app_user AS users
      JOIN app AS owner ON owner.id = users.app_id
     WHERE ${sql.join(users, sql` AND `)}
    UNION ALL
    SELECT events.app_id, events.user_id AS id, 'active' AS status, NULL AS attest_key_id,
           NULL AS attest_public_key, 0 AS attest_counter,
           MIN(strftime('%Y-%m-%dT%H:%M:%fZ', events.created_at)) AS created_at,
           MAX(strftime('%Y-%m-%dT%H:%M:%fZ', events.created_at)) AS last_seen_at,
           1 AS is_virtual
      FROM (
        SELECT app_id, user_id, created_at FROM app_usage_event
        UNION ALL
        SELECT app_id, user_id, created_at FROM app_rejection_event
      ) AS events
      JOIN app AS owner ON owner.id = events.app_id
     WHERE ${sql.join(events, sql` AND `)}
       AND events.user_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM app_user
          WHERE app_user.app_id = events.app_id AND app_user.id = events.user_id
       )
     GROUP BY events.app_id, events.user_id
  )`;
}

function serializeUser(row: EndUserIdentityRow) {
  return {
    id: row.id,
    status: row.status,
    attest_key_id: row.attest_key_id,
    attest_registered: row.attest_public_key !== null,
    attest_counter: row.attest_counter,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    is_virtual: row.is_virtual === 1,
  };
}

export async function listAppUsers(
  scope: ManagementScope,
  actor: Actor,
  appRow: AppRow,
  query: ParsedOperationQuery<"listAppUsers">,
): Promise<UserListResponse> {
  const { DB } = scope.env;
  const appId = appRow.id;
  const month = query.month ?? currentMonth();
  const bounds = monthBounds(month);
  const { limit, offset } = query;
  const identities = endUserIdentities({ organizationId: actor.organizationId, appId });
  const status = query.status ?? null;
  const match = query.query ? `%${query.query}%` : null;
  const filter = sql`WHERE (${status} IS NULL OR status = ${status})
    AND (${match} IS NULL OR id LIKE ${match})`;
  const total = await prepared(DB, sql`${identities} SELECT COUNT(*) AS value FROM identities ${filter}`)
    .first<{ value: number }>();
  const rows = await prepared(DB, sql`${identities}
     SELECT * FROM identities ${filter}
      ORDER BY COALESCE(last_seen_at, created_at) DESC
      LIMIT ${limit} OFFSET ${offset}`)
    .all<EndUserIdentityRow>();

  const usageByUser = new Map<string, UsageTotals>();
  if (rows.results.length > 0) {
    const totals = await database(DB)
      .select({ userId: appUsageEvent.userId, ...usageTotals })
      .from(appUsageEvent)
      .where(
        and(
          eq(appUsageEvent.appId, appId),
          inArray(appUsageEvent.userId, rows.results.map((row) => row.id)),
          gte(eventDay, bounds.from),
          lte(eventDay, bounds.to),
        ),
      )
      .groupBy(appUsageEvent.userId);
    for (const row of totals) {
      const { userId, ...rest } = row;
      // Userless traffic cannot match a listed user, and the `inArray` above
      // already excludes it. Skipped rather than keyed under a placeholder so
      // nothing can turn into a user that never existed.
      if (userId !== null) usageByUser.set(userId, rest);
    }
  }

  return {
    app_id: appId,
    month,
    total: total?.value ?? 0,
    limit,
    offset,
    users: rows.results.map((row) => ({
      ...serializeUser(row),
      usage: usageByUser.get(row.id) ?? EMPTY_USAGE_TOTALS,
    })),
  };
}

export async function getAppUser(
  scope: ManagementScope,
  actor: Actor,
  appRow: AppRow,
  userId: string,
  query: ParsedOperationQuery<"getAppUser">,
): Promise<UserResponse> {
  const { DB } = scope.env;
  const appId = appRow.id;
  const month = query.month ?? currentMonth();
  const bounds = monthBounds(month);
  const identities = endUserIdentities({ organizationId: actor.organizationId, appId, userId });
  const row = await prepared(DB, sql`${identities} SELECT * FROM identities`)
    .first<EndUserIdentityRow>();
  if (!row) throw new GatewayError(404, "not_found", "User was not found");

  const usage = await database(DB)
    .select(usageTotals)
    .from(appUsageEvent)
    .where(
      and(
        eq(appUsageEvent.appId, appId),
        eq(appUsageEvent.userId, userId),
        gte(eventDay, bounds.from),
        lte(eventDay, bounds.to),
      ),
    )
    .get();

  return { app_id: appId, month, user: { ...serializeUser(row), usage: usage ?? EMPTY_USAGE_TOTALS } };
}

/**
 * Blocks or unblocks one end user.
 *
 * D1 owns the status read by token exchange, /me, and admission. Admission
 * caches it for ten seconds per isolate; this isolate drops its entry after
 * the write, while other isolates converge when their entries expire.
 */
export async function setAppUserBlocked(
  scope: ManagementScope,
  _actor: Actor,
  appRow: AppRow,
  userId: string,
  blocked: boolean,
): Promise<UserBlockResponse> {
  const appId = appRow.id;
  const updated = await database(scope.env.DB)
    .update(appUser)
    .set({ status: blocked ? "blocked" : "active" })
    .where(and(eq(appUser.appId, appId), eq(appUser.id, userId)))
    .returning({ id: appUser.id });
  if (updated.length !== 1) throw new GatewayError(404, "not_found", "User was not found");
  invalidateBlockedCache(appId, userId);
  return { app_id: appId, user_id: userId, blocked };
}
