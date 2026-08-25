import { Hono } from "hono";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { GatewayError } from "../../core/errors";
import { database } from "../../db";
import { appUsageEvent, appUser } from "../../db/schema";
import type { UserLimiter } from "../../do/UserLimiter";
import type { AdminVariables } from "../../middleware/admin";
import { currentMonth, eventDay, monthBounds, parseLimit, parseOffset, usageTotals } from "./shared";

export const userRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

interface UserIdentityRow {
  id: string;
  status: "active" | "blocked";
  attest_key_id: string | null;
  attest_public_key: string | null;
  attest_counter: number;
  attest_env: "production" | "development" | null;
  created_at: string;
  last_seen_at: string | null;
  is_virtual: number;
}

function serializeUser(row: UserIdentityRow) {
  return {
    id: row.id,
    status: row.status,
    attest_key_id: row.attest_key_id,
    attest_registered: row.attest_public_key !== null,
    attest_counter: row.attest_counter,
    attest_env: row.attest_env,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    is_virtual: row.is_virtual === 1,
  };
}

const IDENTITIES_SQL = `
  WITH identities AS (
    SELECT id, status, attest_key_id, attest_public_key, attest_counter,
           attest_env, created_at, last_seen_at, 0 AS is_virtual
      FROM app_user
     WHERE app_id = ?
    UNION ALL
    SELECT events.user_id AS id, 'active' AS status, NULL AS attest_key_id,
           NULL AS attest_public_key, 0 AS attest_counter, NULL AS attest_env,
           MIN(events.created_at) AS created_at, MAX(events.created_at) AS last_seen_at,
           1 AS is_virtual
      FROM app_usage_event AS events
     WHERE events.app_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM app_user
          WHERE app_user.app_id = events.app_id AND app_user.id = events.user_id
       )
     GROUP BY events.user_id
  )`;

const EMPTY_USAGE = {
  requests: 0,
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  errors: 0,
  blocked: 0,
};

userRoutes.get("/apps/:app/users", async (c) => {
  const appId = c.req.param("app");
  const month = c.req.query("month") ?? currentMonth();
  const bounds = monthBounds(month);
  const limit = parseLimit(c.req.query("limit"), 50, 200);
  const offset = parseOffset(c.req.query("offset"));
  const status = c.req.query("status");
  if (status !== undefined && status !== "active" && status !== "blocked") {
    throw new GatewayError(400, "invalid_request", "status must be active or blocked");
  }
  const query = c.req.query("query");

  const db = database(c.env.DB);
  const statusFilter = status ?? null;
  const queryFilter = query ? `%${query}%` : null;
  const total = await c.env.DB.prepare(
    `${IDENTITIES_SQL}
     SELECT COUNT(*) AS value FROM identities
      WHERE (? IS NULL OR status = ?) AND (? IS NULL OR id LIKE ?)`,
  )
    .bind(appId, appId, statusFilter, statusFilter, queryFilter, queryFilter)
    .first<{ value: number }>();
  const rows = await c.env.DB.prepare(
    `${IDENTITIES_SQL}
     SELECT * FROM identities
      WHERE (? IS NULL OR status = ?) AND (? IS NULL OR id LIKE ?)
      ORDER BY COALESCE(last_seen_at, created_at) DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(appId, appId, statusFilter, statusFilter, queryFilter, queryFilter, limit, offset)
    .all<UserIdentityRow>();

  const usageByUser = new Map<string, typeof EMPTY_USAGE>();
  if (rows.results.length > 0) {
    const totals = await db
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
      usageByUser.set(userId, rest);
    }
  }

  return c.json({
    app_id: appId,
    month,
    total: total?.value ?? 0,
    limit,
    offset,
    users: rows.results.map((row) => ({
      ...serializeUser(row),
      usage: usageByUser.get(row.id) ?? EMPTY_USAGE,
    })),
  });
});

userRoutes.get("/apps/:app/users/:user", async (c) => {
  const appId = c.req.param("app");
  const userId = c.req.param("user");
  const month = c.req.query("month") ?? currentMonth();
  const bounds = monthBounds(month);

  const db = database(c.env.DB);
  const stored = await db
    .select()
    .from(appUser)
    .where(and(eq(appUser.appId, appId), eq(appUser.id, userId)))
    .get();
  let row: UserIdentityRow | null = stored
    ? {
        id: stored.id,
        status: stored.status,
        attest_key_id: stored.attestKeyId,
        attest_public_key: stored.attestPublicKey,
        attest_counter: stored.attestCounter,
        attest_env: stored.attestEnvironment,
        created_at: stored.createdAt,
        last_seen_at: stored.lastSeenAt,
        is_virtual: 0,
      }
    : null;
  if (!row) {
    row = await c.env.DB.prepare(
      `SELECT user_id AS id, 'active' AS status, NULL AS attest_key_id,
              NULL AS attest_public_key, 0 AS attest_counter, NULL AS attest_env,
              MIN(created_at) AS created_at, MAX(created_at) AS last_seen_at,
              1 AS is_virtual
         FROM app_usage_event
        WHERE app_id = ? AND user_id = ?
        GROUP BY user_id`,
    )
      .bind(appId, userId)
      .first<UserIdentityRow>();
  }
  if (!row) throw new GatewayError(404, "invalid_request", "User was not found");

  const usage = await db
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

  return c.json({ app_id: appId, month, user: { ...serializeUser(row), usage: usage ?? EMPTY_USAGE } });
});

userRoutes.post("/apps/:app/users/:user/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "block" && action !== "unblock") {
    throw new GatewayError(404, "invalid_request", "Unknown user action");
  }
  const appId = c.req.param("app");
  const userId = c.req.param("user");
  const blocked = action === "block";
  const updated = await database(c.env.DB)
    .update(appUser)
    .set({ status: blocked ? "blocked" : "active" })
    .where(and(eq(appUser.appId, appId), eq(appUser.id, userId)))
    .returning({ id: appUser.id });
  if (updated.length !== 1) throw new GatewayError(404, "invalid_request", "User was not found");
  const limiter = c.env.USER_LIMITER.getByName(`${appId}:${userId}`) as DurableObjectStub<UserLimiter>;
  await limiter.setBlocked(blocked);
  return c.json({ app_id: appId, user_id: userId, blocked });
});
