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
import { EndUserListQuerySchema, EndUserQuerySchema, SeenUserListQuerySchema } from "../contracts/admin.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { invalidateBlockedCache } from "../client-auth/user-status.ts";
import { GatewayError } from "../core/errors.ts";
import { ledgerDb } from "../ledger/database.ts";
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
 * The users the ledger has seen in one app that may have no user row in D1:
 * those named on its charges or refusals, recorded under the caller's account
 * (`?2`). `?1` is the app id. `+account_id` keeps the planner on the
 * app-and-user indexes. A refusal with no account (recorded before events
 * carried one) is never read.
 *
 * - `one`: `?3` is the user id, and nothing is scanned.
 * - `page`: in id order, after `?4` (null for the first page), at most `?5`,
 *   with an optional `LIKE` pattern `?3` on the id. Each list walks its index
 *   from the cursor, so a page never reads the users before it.
 */
function seenSql(kind: "one" | "page"): string {
  const refusals = "app_rejection_event WHERE app_id = ?1 AND account_id = ?2";
  const charges = "charge WHERE app_id = ?1 AND +account_id = ?2";
  const after = "(?4 IS NULL OR end_user_id > ?4)";
  const afterRefusal = "(?4 IS NULL OR user_id > ?4)";
  const named = kind === "one"
    ? `named(user_id) AS (
         SELECT ?3 WHERE EXISTS (SELECT 1 FROM ${charges} AND end_user_id = ?3)
                      OR EXISTS (SELECT 1 FROM ${refusals} AND user_id = ?3)
       )`
    : `used(user_id, n) AS (
         SELECT (SELECT MIN(end_user_id) FROM ${charges} AND ${after}), 1
         UNION ALL
         SELECT (SELECT MIN(end_user_id) FROM ${charges} AND end_user_id > used.user_id), n + 1
           FROM used WHERE used.user_id IS NOT NULL AND n < ?5
       ),
       refused(user_id, n) AS (
         SELECT (SELECT MIN(user_id) FROM ${refusals} AND ${afterRefusal}), 1
         UNION ALL
         SELECT (SELECT MIN(user_id) FROM ${refusals} AND user_id > refused.user_id), n + 1
           FROM refused WHERE refused.user_id IS NOT NULL AND n < ?5
       ),
       named(user_id) AS (
         SELECT user_id FROM used WHERE user_id IS NOT NULL
         UNION
         SELECT user_id FROM refused WHERE user_id IS NOT NULL
       )`;
  return `WITH RECURSIVE ${named}
    SELECT named.user_id AS id,
           (SELECT MIN(used_at) FROM ${charges} AND end_user_id = named.user_id) AS used_first,
           (SELECT MAX(used_at) FROM ${charges} AND end_user_id = named.user_id) AS used_last,
           (SELECT MIN(created_at) FROM ${refusals} AND user_id = named.user_id) AS refused_first,
           (SELECT MAX(created_at) FROM ${refusals} AND user_id = named.user_id) AS refused_last
      FROM named
     ${kind === "one" ? "" : "ORDER BY named.user_id LIMIT ?5"}`;
}

interface SeenRow {
  id: string;
  used_first: number | null;
  used_last: number | null;
  refused_first: number | null;
  refused_last: number | null;
}

/** A user the ledger has seen, shown as an active user with no installs. */
function seenIdentity(row: SeenRow): IdentityRow {
  const first = [row.used_first, row.refused_first].filter((value): value is number => value !== null);
  const last = [row.used_last, row.refused_last].filter((value): value is number => value !== null);
  return {
    id: row.id,
    status: "active",
    installs: 0,
    is_install: 0,
    created_at: first.length === 0 ? null : Math.min(...first),
    last_seen_at: last.length === 0 ? null : Math.max(...last),
    is_virtual: 1,
  };
}

/** D1's users of one app, with their installs. `?1` is the app id. */
const USER_ROWS = `SELECT users.id, users.status,
         (SELECT COUNT(*) FROM app_attest_key AS keys WHERE keys.app_id = users.app_id AND keys.user_id = users.id) AS installs,
         EXISTS (SELECT 1 FROM app_attest_key AS keys WHERE keys.app_id = users.app_id AND keys.key_id = users.id) AS is_install,
         users.created_at, users.last_seen_at, 0 AS is_virtual
    FROM app_end_user AS users`;

/** Which of `ids` have a user row in D1. One bound list. */
async function knownUsers(db: D1Database, appId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { results } = await db
    .prepare("SELECT id FROM app_end_user WHERE app_id = ? AND id IN (SELECT value FROM json_each(?))")
    .bind(appId, JSON.stringify(ids))
    .all<{ id: string }>();
  return new Set(results.map((row) => row.id));
}

/**
 * One page of the users the ledger has seen in an app and D1 does not list,
 * in id order, paged inside the account's ledger object after `cursor`. The
 * ids D1 lists are dropped from the page, so it can come back shorter than
 * `limit`; the next cursor is the ledger page's last id while that page was
 * full (plan, step 8f: two lists, each paged on its own). A search pattern
 * is applied to the page in code, so it can come back shorter still.
 */
async function seenPage(
  env: Env,
  accountId: string,
  appId: string,
  page: { readonly cursor: string | null; readonly limit: number; readonly query: string | null },
): Promise<{ readonly rows: IdentityRow[]; readonly nextCursor: string | null }> {
  const { results } = await ledgerDb(env, accountId).prepare(seenSql("page")).bind(appId, accountId, null, page.cursor, page.limit).all<SeenRow>();
  const known = await knownUsers(env.DB, appId, results.map((row) => row.id));
  const needle = page.query?.toLowerCase() ?? null;
  const rows = results
    .filter((row) => !known.has(row.id) && (needle === null || row.id.toLowerCase().includes(needle)))
    .map(seenIdentity);
  return { rows, nextCursor: results.length === page.limit ? results.at(-1)!.id : null };
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
  // D1's users only, newest first. The users only the ledger has seen are a
  // list of their own (`listAppSeenUsers`; plan, step 8f: two lists, each
  // paged on its own).
  const filter = `WHERE users.app_id = ?1 AND (?2 IS NULL OR users.status = ?2) AND (?3 IS NULL OR users.id LIKE ?3 ESCAPE '\\')`;
  const pattern = query.query ? likePattern(query.query) : null;
  const binds = [appId, query.status ?? null, pattern];
  const [total, rows] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT COUNT(*) AS value FROM app_end_user AS users ${filter}`).bind(...binds),
    c.env.DB.prepare(
      `${USER_ROWS} ${filter}
        ORDER BY COALESCE(users.last_seen_at, users.created_at) DESC, users.id LIMIT ?4 OFFSET ?5`,
    ).bind(...binds, query.limit, query.offset),
  ]);
  const usersTotal = (total?.results[0] as { value?: number } | undefined)?.value ?? 0;
  const listed = (rows?.results ?? []) as IdentityRow[];
  const usage = await usageByUser(ledgerDb(c.env, actor.accountId), actor.accountId, appId, listed.map((row) => row.id), month);
  return c.json({
    app_id: appId,
    month,
    total: usersTotal,
    limit: query.limit,
    offset: query.offset,
    users: listed.map((row) => userView(row, usage.get(row.id))),
  } satisfies OperationResponse<"listAppUsers">);
}

export async function listAppSeenUsers(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const query = parseQuery(c, SeenUserListQuerySchema);
  await appExists(c.env.DB, actor.accountId, appId);
  const month = query.month ?? currentMonth();
  const page = await seenPage(c.env, actor.accountId, appId, { cursor: query.cursor ?? null, limit: query.limit, query: query.query?.trim() || null });
  const usage = await usageByUser(ledgerDb(c.env, actor.accountId), actor.accountId, appId, page.rows.map((row) => row.id), month);
  return c.json({
    app_id: appId,
    month,
    limit: query.limit,
    users: page.rows.map((row) => userView(row, usage.get(row.id))),
    next_cursor: page.nextCursor,
  } satisfies OperationResponse<"listAppSeenUsers">);
}

export async function getAppUser(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const userId = c.req.param("user")!;
  const query = parseQuery(c, EndUserQuerySchema);
  await appExists(c.env.DB, actor.accountId, appId);
  const month = query.month ?? currentMonth();
  let row = await c.env.DB.prepare(`${USER_ROWS} WHERE users.app_id = ?1 AND users.id = ?2`).bind(appId, userId).first<IdentityRow>();
  if (row === null) {
    const seen = await ledgerDb(c.env, actor.accountId).prepare(seenSql("one")).bind(appId, actor.accountId, userId).first<SeenRow>();
    row = seen === null ? null : seenIdentity(seen);
  }
  if (row === null) throw new GatewayError(404, "not_found", "User was not found");
  const usage = await usageByUser(ledgerDb(c.env, actor.accountId), actor.accountId, appId, [userId], month);
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
