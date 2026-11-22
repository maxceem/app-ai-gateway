/**
 * Diagnostics reads through the management API (v1's auth-event and
 * rejection-event endpoints): an app's sign-in attempts, the requests it
 * refused before they reached a provider, and a summary of both.
 *
 * Both tables record the account that owned the app when each event
 * happened, and every read here filters by the caller's account as well as
 * the app, so an app id that comes back in another account never shows the
 * old account's events. Deleting an app leaves its events to age out with
 * the 90-day retention (`../client-auth/auth-events.ts`,
 * `../diagnostics/rejection-events.ts`): nothing can read them any more.
 *
 * The lists page the way the charge list does: newest first, by time and id.
 * Each is served by its app index, or its app-and-user index with a user;
 * both end in that order, so a page needs no sort. Any other filter has no
 * index of its own, so without a user it is read inside at most 31 days, by
 * default the last 30. Otherwise `from` and `to` each bound the read on their
 * own, as in v1: `to` alone reads everything kept up to that day.
 */
import type { Context } from "hono";
import type { OperationResponse } from "../contracts/catalog.ts";
import {
  AuthEventListQuerySchema,
  AuthEventSummaryQuerySchema,
  DIAGNOSTICS_RETENTION_DAYS,
  RejectionEventListQuerySchema,
} from "../contracts/diagnostics.ts";
import { USAGE_CHARGE_RANGE_MAX_DAYS } from "../contracts/usage.ts";
import { GatewayError } from "../core/errors.ts";
import type { AdminVariables } from "./actor.ts";
import { appExists, dayRange, parseQuery } from "./usage.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

const DAY_MS = 86_400_000;

/** A UTC day from a `created_at` in milliseconds, in SQL. */
const DAY_OF = (column: string) => `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`;

/** A page position: the last event's time and id, so equal times still page in order. */
function parseBefore(before: string): { at: number; id: string } {
  const dot = before.indexOf(".");
  const at = Number(before.slice(0, dot));
  if (dot <= 0 || !Number.isSafeInteger(at)) throw new GatewayError(400, "invalid_request", "before is not a page position this API gave");
  return { at, id: before.slice(dot + 1) };
}

interface ListInput {
  readonly table: "app_auth_event" | "app_rejection_event";
  readonly columns: string;
  readonly accountId: string;
  readonly appId: string;
  readonly query: { readonly from?: string; readonly to?: string; readonly limit: number; readonly before?: string; readonly user?: string };
  /** Equality filters with no index of their own: each a fixed column name and the caller's value. */
  readonly filters: readonly (readonly [column: string, value: string | undefined])[];
}

/** One page of an event table, newest first. */
async function listEvents<Row extends { id: string; created_at: number }>(
  db: D1Database,
  input: ListInput,
): Promise<{ rows: Row[]; nextBefore: string | null }> {
  const { query } = input;
  const filters = input.filters.filter((filter): filter is readonly [string, string] => filter[1] !== undefined);
  // With a user, `<table>_app_user_created` serves it. Without, the app's
  // index by time; an unindexed filter then walks it, so it is bounded.
  const unindexed = query.user === undefined && filters.length > 0;
  const where = ["app_id = ?", "account_id = ?"];
  const params: unknown[] = [input.appId, input.accountId];
  if (query.user !== undefined) {
    where.push("user_id = ?");
    params.push(query.user);
  }
  if (unindexed) {
    const range = dayRange(query.from, query.to, USAGE_CHARGE_RANGE_MAX_DAYS);
    where.push("created_at >= ?", "created_at < ?");
    params.push(Date.parse(`${range.from}T00:00:00Z`), Date.parse(`${range.to}T00:00:00Z`) + DAY_MS);
  } else {
    // An index serves the read, so each bound stands on its own.
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      throw new GatewayError(400, "invalid_request", "from must not be after to");
    }
    if (query.from !== undefined) {
      where.push("created_at >= ?");
      params.push(Date.parse(`${query.from}T00:00:00Z`));
    }
    if (query.to !== undefined) {
      where.push("created_at < ?");
      params.push(Date.parse(`${query.to}T00:00:00Z`) + DAY_MS);
    }
  }
  for (const [column, value] of filters) {
    where.push(`${column} = ?`);
    params.push(value);
  }
  if (query.before !== undefined) {
    const before = parseBefore(query.before);
    where.push("(created_at, id) < (?, ?)");
    params.push(before.at, before.id);
  }
  const { results } = await db
    .prepare(`SELECT ${input.columns} FROM ${input.table} WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...params, query.limit)
    .all<Row>();
  const last = results.at(-1);
  return { rows: results, nextBefore: results.length === query.limit && last !== undefined ? `${last.created_at}.${last.id}` : null };
}

type AuthEventRow = Omit<OperationResponse<"listAppAuthEvents">["events"][number], "created_at"> & { created_at: number };

export async function listAppAuthEvents(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const query = parseQuery(c, AuthEventListQuerySchema);
  await appExists(c.env.DB, actor.accountId, appId);
  const { rows, nextBefore } = await listEvents<AuthEventRow>(c.env.DB, {
    table: "app_auth_event",
    accountId: actor.accountId,
    columns:
      "id, user_id, event, auth_method, outcome, reason, app_version, client_sdk, network_asn, network_name, latency_ms, claim_delay_ms, created_at",
    appId,
    query,
    filters: [
      ["event", query.event],
      ["outcome", query.outcome],
    ],
  });
  return c.json({
    app_id: appId,
    limit: query.limit,
    next_before: nextBefore,
    events: rows.map((row) => ({ ...row, created_at: new Date(row.created_at).toISOString() })),
  } satisfies OperationResponse<"listAppAuthEvents">);
}

type RejectionEventRow = Omit<OperationResponse<"listAppRejectionEvents">["events"][number], "created_at"> & { created_at: number };

export async function listAppRejectionEvents(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const query = parseQuery(c, RejectionEventListQuerySchema);
  await appExists(c.env.DB, actor.accountId, appId);
  const { rows, nextBefore } = await listEvents<RejectionEventRow>(c.env.DB, {
    table: "app_rejection_event",
    accountId: actor.accountId,
    columns:
      "id, user_id, install_id, app_key_id, reason, scope, provider_slug, model, operation, app_version, auth_method, latency_ms, created_at",
    appId,
    query,
    filters: [
      ["reason", query.reason],
      ["scope", query.scope],
    ],
  });
  return c.json({
    app_id: appId,
    limit: query.limit,
    next_before: nextBefore,
    // `model` and `provider_slug` are shown as stored: the writer kept only
    // names the gateway knows (`../diagnostics/rejection-events.ts`).
    events: rows.map((row) => ({ ...row, created_at: new Date(row.created_at).toISOString() })),
  } satisfies OperationResponse<"listAppRejectionEvents">);
}

type Summary = OperationResponse<"getAppAuthEventSummary">;

/**
 * The claim wait at `percent` of the window, by nearest rank as v1: one row
 * read through `app_auth_event_claim_delay`, never the whole list. The index
 * holds the waits in order with their times, so neither the count nor the
 * lookup sorts or reads the table. Exported for its query-plan test. The
 * percentile is written into the SQL as a whole number, so the offset is
 * worked out in integers.
 */
export function claimWaitAt(percent: 50 | 95): string {
  return `SELECT claim_delay_ms AS ms FROM app_auth_event WHERE ${CLAIM_WAITS}
   ORDER BY claim_delay_ms
   LIMIT 1 OFFSET (SELECT MAX(0, (COUNT(*) * ${percent} + 99) / 100 - 1) FROM app_auth_event WHERE ${CLAIM_WAITS})`;
}

/**
 * The claim waits in a window, as SQL. `+created_at` keeps SQLite off the
 * date index (which does not hold `claim_delay_ms`): every read of the waits
 * goes through the covering `app_auth_event_claim_delay` and never fetches a
 * table row (Gemini Neon 7b-4).
 */
const CLAIM_WAITS = "app_id = ?1 AND account_id = ?2 AND claim_delay_ms IS NOT NULL AND +created_at >= ?3 AND +created_at < ?4";
export const CLAIM_WAIT_TOTALS = `SELECT COUNT(*) AS count, AVG(claim_delay_ms) AS avg FROM app_auth_event WHERE ${CLAIM_WAITS}`;

/**
 * The networks failures came from, at most ten, in SQL: one row per network,
 * so a window with failures from many networks never comes back whole
 * (Gemini Neon 7b-4). A recovered failure is not a failing network (the app
 * got past it on its own), and neither is an unknown one, which says nothing
 * about where to look.
 */
export const FAILING_NETWORKS = `SELECT network_asn, MAX(network_name) AS network_name, COUNT(*) AS count, MAX(created_at) AS last_seen
   FROM app_auth_event
  WHERE app_id = ?1 AND account_id = ?2 AND created_at >= ?3 AND created_at < ?4
    AND outcome NOT IN ('ok', 'client_recovered') AND network_asn IS NOT NULL
  GROUP BY network_asn ORDER BY count DESC, network_asn ASC LIMIT 10`;

/** Active users waiting on a claim since `?2`, through `app_end_user_claim_pending`. Exported for its query-plan test. */
export const PENDING_USERS =
  "SELECT COUNT(*) AS count FROM app_end_user WHERE app_id = ?1 AND status = 'active' AND claim_pending_since IS NOT NULL AND claim_pending_since >= ?2";

/**
 * An app's sign-in health over a trailing window, in one batch. Attempts per
 * day and the token-exchange success rate come from one pass over the auth
 * events, grouped by day, event, outcome and reason; the networks failures
 * came from are their own statement, at most ten rows. Then
 * failed charges per day (`usage_day`), sampled refusals per day, the claim
 * waits that ended in the window (count, average and two percentiles, each
 * through `app_auth_event_claim_delay`), and the users waiting now
 * (`app_end_user_claim_pending`).
 */
export async function getAppAuthEventSummary(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const { days } = parseQuery(c, AuthEventSummaryQuerySchema);
  await appExists(c.env.DB, actor.accountId, appId);
  const today = new Date().toISOString().slice(0, 10);
  const end = Date.parse(`${today}T00:00:00Z`) + DAY_MS;
  const start = end - days * DAY_MS;
  const from = new Date(start).toISOString().slice(0, 10);
  const db = c.env.DB;
  const window = "app_id = ?1 AND account_id = ?2 AND created_at >= ?3 AND created_at < ?4";
  const [auth, networks, failed, rejections, waitTotals, p50, p95, pending] = await db.batch([
    db
      .prepare(
        `SELECT ${DAY_OF("created_at")} AS date, event, outcome, reason, COUNT(*) AS count
           FROM app_auth_event WHERE ${window}
          GROUP BY date, event, outcome, reason ORDER BY date, event, outcome, reason`,
      )
      .bind(appId, actor.accountId, start, end),
    db.prepare(FAILING_NETWORKS).bind(appId, actor.accountId, start, end),
    db
      .prepare(
        `SELECT day AS date, SUM(charges) AS count FROM usage_day
          WHERE account_id = ?1 AND app_id = ?2 AND day >= ?3 AND day <= ?4 AND outcome = 'failed'
          GROUP BY day ORDER BY day`,
      )
      .bind(actor.accountId, appId, from, today),
    db
      .prepare(
        `SELECT ${DAY_OF("created_at")} AS date, reason, scope, COUNT(*) AS count
           FROM app_rejection_event WHERE ${window}
          GROUP BY date, reason, scope ORDER BY date, reason, scope`,
      )
      .bind(appId, actor.accountId, start, end),
    db.prepare(CLAIM_WAIT_TOTALS).bind(appId, actor.accountId, start, end),
    db.prepare(claimWaitAt(50)).bind(appId, actor.accountId, start, end),
    db.prepare(claimWaitAt(95)).bind(appId, actor.accountId, start, end),
    // Active users only: a blocked user's wait can never end. And only waits that
    // began inside the events' retention: an older one belongs to a user who has
    // not been back since, and its events are gone (Fable 7b-4).
    db.prepare(PENDING_USERS).bind(appId, Date.now() - DIAGNOSTICS_RETENTION_DAYS * DAY_MS),
  ]);
  const all = <T>(result: D1Result | undefined) => (result?.results ?? []) as T[];
  const dailyRows = all<Summary["daily"][number]>(auth);
  let exchangeTotal = 0;
  let exchangeOk = 0;
  for (const group of dailyRows) {
    if (group.event === "token_exchange") {
      exchangeTotal += group.count;
      if (group.outcome === "ok") exchangeOk += group.count;
    }
  }
  const failing = all<{ network_asn: number; network_name: string | null; count: number; last_seen: number }>(networks).map((row) => ({
    ...row,
    last_seen: new Date(row.last_seen).toISOString(),
  }));
  const wait = all<{ count: number; avg: number | null }>(waitTotals)[0] ?? { count: 0, avg: null };
  const at = (result: D1Result | undefined) => all<{ ms: number }>(result)[0]?.ms ?? null;
  return c.json({
    app_id: appId,
    days,
    from,
    to: today,
    daily: dailyRows,
    failing_networks: failing as Summary["failing_networks"],
    failed_charges: all<Summary["failed_charges"][number]>(failed),
    rejection_samples: all<Summary["rejection_samples"][number]>(rejections),
    token_exchange: {
      total: exchangeTotal,
      ok: exchangeOk,
      // Null rather than 1: a window nobody signed in has no rate.
      success_rate: exchangeTotal === 0 ? null : exchangeOk / exchangeTotal,
    },
    claim_delay: {
      count: wait.count,
      avg_ms: wait.avg === null ? null : Math.round(wait.avg),
      p50_ms: at(p50),
      p95_ms: at(p95),
    },
    pending_users: all<{ count: number }>(pending)[0]?.count ?? 0,
  } satisfies Summary);
}
