/**
 * An app's end users, through the management API (v1's `users.ts`, ported to
 * the ledger).
 *
 * An end user is either:
 *
 * - an `app_end_user` row, which sign-in writes (App Attest installs and
 *   issuer users), with the App Attest keys it holds; or
 * - a *virtual* user: an id that only the app's charges or refusals name, such
 *   as a server app's end-user header. It has no row, is always active, and
 *   cannot be blocked, as v1.
 *
 * Distinct ids are found with a loose index scan: each step asks the index for
 * the smallest id after the last one, so the cost follows how many users an
 * app has, not how many requests they made. NULL (no end user) never compares
 * greater than anything, so it is skipped.
 *
 * Usage is summed from the ledger for one UTC month, corrections included.
 */
import type { Context } from "hono";
import { EndUserListQuerySchema, EndUserQuerySchema } from "../contracts/admin.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { invalidateBlockedCache } from "../client-auth/user-status.ts";
import { GatewayError } from "../core/errors.ts";
import { requireManage, type AdminVariables } from "./actor.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

interface IdentityRow {
  id: string;
  status: "active" | "blocked";
  installs: number;
  is_install: number;
  created_at: number | null;
  last_seen_at: number | null;
  is_virtual: number;
}

interface UsageRow {
  end_user_id: string;
  charges: number;
  failed: number;
  cost_nano: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

const EMPTY_USAGE = { charges: 0, failed: 0, cost_nano: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function currentMonth(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** A month's bounds in epoch milliseconds, end excluded. */
export function monthBounds(month: string): { from: number; to: number } {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  return { from: Date.UTC(year, monthNumber - 1, 1), to: Date.UTC(year, monthNumber, 1) };
}

function parseQuery<T>(c: AdminContext, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { message: string }[] } } }): T {
  const parsed = schema.safeParse(c.req.query());
  if (parsed.success) return parsed.data;
  throw new GatewayError(400, "invalid_request", parsed.error.issues[0]?.message ?? "The query is invalid");
}

async function appExists(db: D1Database, accountId: string, appId: string): Promise<void> {
  const row = await db.prepare("SELECT 1 AS found FROM app WHERE id = ? AND account_id = ?").bind(appId, accountId).first();
  if (row === null) throw new GatewayError(404, "app_not_found", "App is not registered");
}

/**
 * The `identities` table of one app, as common table expressions. `?1` is the
 * app id; with `oneUser`, `?2` is the user id and nothing is scanned.
 * `account` is the placeholder of the caller's account: charges and refusals
 * are read only as recorded under it, and a refusal with no account (recorded
 * before events carried one) is never read. `+account_id` keeps the planner on
 * the app-and-user indexes: the account is checked on the rows they find.
 */
function identities(oneUser: boolean, account: string): string {
  const refusals = `app_rejection_event WHERE app_id = ?1 AND account_id = ${account}`;
  const charges = `charge WHERE app_id = ?1 AND +account_id = ${account}`;
  const named = oneUser
    ? `named(user_id) AS (
         SELECT ?2 WHERE EXISTS (SELECT 1 FROM ${charges} AND end_user_id = ?2)
                      OR EXISTS (SELECT 1 FROM ${refusals} AND user_id = ?2)
       )`
    : `used(user_id) AS (
         SELECT (SELECT MIN(end_user_id) FROM ${charges})
         UNION ALL
         SELECT (SELECT MIN(end_user_id) FROM ${charges} AND end_user_id > used.user_id)
           FROM used WHERE used.user_id IS NOT NULL
       ),
       refused(user_id) AS (
         SELECT (SELECT MIN(user_id) FROM ${refusals})
         UNION ALL
         SELECT (SELECT MIN(user_id) FROM ${refusals} AND user_id > refused.user_id)
           FROM refused WHERE refused.user_id IS NOT NULL
       ),
       named(user_id) AS (
         SELECT user_id FROM used WHERE user_id IS NOT NULL
         UNION
         SELECT user_id FROM refused WHERE user_id IS NOT NULL
       )`;
  const rows = oneUser ? "WHERE users.app_id = ?1 AND users.id = ?2" : "WHERE users.app_id = ?1";
  return `WITH RECURSIVE ${named},
    seen AS (
      SELECT named.user_id,
             (SELECT MIN(used_at) FROM ${charges} AND end_user_id = named.user_id) AS used_first,
             (SELECT MAX(used_at) FROM ${charges} AND end_user_id = named.user_id) AS used_last,
             (SELECT MIN(created_at) FROM ${refusals} AND user_id = named.user_id) AS refused_first,
             (SELECT MAX(created_at) FROM ${refusals} AND user_id = named.user_id) AS refused_last
        FROM named
       WHERE NOT EXISTS (SELECT 1 FROM app_end_user WHERE app_id = ?1 AND id = named.user_id)
    ),
    identities AS (
      SELECT users.id, users.status,
             (SELECT COUNT(*) FROM app_attest_key AS keys WHERE keys.app_id = users.app_id AND keys.user_id = users.id) AS installs,
             EXISTS (SELECT 1 FROM app_attest_key AS keys WHERE keys.app_id = users.app_id AND keys.key_id = users.id) AS is_install,
             users.created_at, users.last_seen_at, 0 AS is_virtual
        FROM app_end_user AS users
       ${rows}
      UNION ALL
      -- Two-argument min() and max() are NULL if either side is, so each side
      -- falls back to the other.
      SELECT user_id AS id, 'active' AS status, 0 AS installs, 0 AS is_install,
             min(COALESCE(used_first, refused_first), COALESCE(refused_first, used_first)) AS created_at,
             max(COALESCE(used_last, refused_last), COALESCE(refused_last, used_last)) AS last_seen_at,
             1 AS is_virtual
        FROM seen
    )`;
}

/** Each listed user's usage in a month, from the ledger. One bound list, so any page size fits D1's limit on bound values. Exported for the retention tests. */
export async function usageByUser(
  db: D1Database,
  accountId: string,
  appId: string,
  ids: readonly string[],
  month: string,
): Promise<Map<string, typeof EMPTY_USAGE>> {
  const usage = new Map<string, typeof EMPTY_USAGE>();
  if (ids.length === 0) return usage;
  const { from, to } = monthBounds(month);
  const { results } = await db
    .prepare(
      `SELECT end_user_id,
              SUM(kind <> 'correction') AS charges,
              SUM(kind <> 'correction' AND status <> 'ok') AS failed,
              COALESCE(SUM(cost_nano), 0) AS cost_nano,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM charge
        WHERE app_id = ? AND +account_id = ? AND end_user_id IN (SELECT value FROM json_each(?)) AND used_at >= ? AND used_at < ?
        GROUP BY end_user_id`,
    )
    .bind(appId, accountId, JSON.stringify(ids), from, to)
    .all<UsageRow>();
  for (const { end_user_id: id, ...totals } of results) usage.set(id, totals);
  return usage;
}

function userView(row: IdentityRow, usage: typeof EMPTY_USAGE | undefined) {
  return {
    id: row.id,
    status: row.status,
    installs: row.installs,
    is_install: row.is_install === 1,
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at),
    is_virtual: row.is_virtual === 1,
    usage: usage ?? EMPTY_USAGE,
  };
}

/** `%` and `_` in a search are matched as themselves. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
}

export async function listAppUsers(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const query = parseQuery(c, EndUserListQuerySchema);
  await appExists(c.env.DB, actor.accountId, appId);
  const month = query.month ?? currentMonth();
  const filter = `WHERE (?2 IS NULL OR status = ?2) AND (?3 IS NULL OR id LIKE ?3 ESCAPE '\\')`;
  const binds = [appId, query.status ?? null, query.query ? likePattern(query.query) : null];
  const base = identities(false, "?6");
  const [total, rows] = await c.env.DB.batch([
    c.env.DB.prepare(`${base} SELECT COUNT(*) AS value FROM identities ${filter}`).bind(...binds, null, null, actor.accountId),
    c.env.DB.prepare(
      `${base} SELECT * FROM identities ${filter}
        ORDER BY COALESCE(last_seen_at, created_at) DESC, id LIMIT ?4 OFFSET ?5`,
    ).bind(...binds, query.limit, query.offset, actor.accountId),
  ]);
  const listed = (rows?.results ?? []) as IdentityRow[];
  const usage = await usageByUser(c.env.DB, actor.accountId, appId, listed.map((row) => row.id), month);
  return c.json({
    app_id: appId,
    month,
    total: ((total?.results[0] as { value?: number } | undefined)?.value ?? 0),
    limit: query.limit,
    offset: query.offset,
    users: listed.map((row) => userView(row, usage.get(row.id))),
  } satisfies OperationResponse<"listAppUsers">);
}

export async function getAppUser(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const userId = c.req.param("user")!;
  const query = parseQuery(c, EndUserQuerySchema);
  await appExists(c.env.DB, actor.accountId, appId);
  const month = query.month ?? currentMonth();
  const row = await c.env.DB.prepare(`${identities(true, "?3")} SELECT * FROM identities`).bind(appId, userId, actor.accountId).first<IdentityRow>();
  if (row === null) throw new GatewayError(404, "not_found", "User was not found");
  const usage = await usageByUser(c.env.DB, actor.accountId, appId, [userId], month);
  return c.json({ app_id: appId, month, user: userView(row, usage.get(userId)) } satisfies OperationResponse<"getAppUser">);
}

/**
 * Blocks or unblocks one end user. D1 holds the status that sign-in, `/me`
 * and requests read. Requests cache it for up to ten seconds per isolate:
 * this isolate forgets its copy now, and the others within ten seconds.
 */
async function setBlocked(c: AdminContext, blocked: boolean): Promise<Response> {
  const actor = c.get("actor");
  requireManage(actor);
  const appId = c.req.param("app")!;
  const userId = c.req.param("user")!;
  await appExists(c.env.DB, actor.accountId, appId);
  const result = await c.env.DB.prepare("UPDATE app_end_user SET status = ? WHERE app_id = ? AND id = ?")
    .bind(blocked ? "blocked" : "active", appId, userId)
    .run();
  if (result.meta.changes !== 1) throw new GatewayError(404, "not_found", "User was not found");
  invalidateBlockedCache(appId, userId);
  return c.json({ app_id: appId, user_id: userId, blocked } satisfies OperationResponse<"blockAppUser">);
}

export const blockAppUser = (c: AdminContext) => setBlocked(c, true);
export const unblockAppUser = (c: AdminContext) => setBlocked(c, false);
