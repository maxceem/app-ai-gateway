/**
 * Diagnostics reads through the management API (v1's auth-event and
 * rejection-event endpoints): an app's sign-in attempts, the requests it
 * refused before they reached a provider, and a summary of both.
 *
 * Both tables are keyed by app alone. They are read only through an app the
 * caller's account owns, and deleting an app deletes them with it
 * (`./apps.ts`), so an app id that comes back in another account starts with
 * none. Both are kept 90 days (`../client-auth/auth-events.ts`,
 * `../diagnostics/rejection-events.ts`).
 *
 * The lists page the way the charge list does: newest first, by time and id.
 * Each is served by its app index, or its app-and-user index with a user.
 * Any other filter has no index of its own, so without a user it is read
 * inside at most 31 days, by default the last 30.
 */
import type { Context } from "hono";
import type { OperationResponse } from "../contracts/catalog.ts";
import {
  AuthEventListQuerySchema,
  AuthEventSummaryQuerySchema,
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
  const where = ["app_id = ?"];
  const params: unknown[] = [input.appId];
  if (query.user !== undefined) {
    where.push("user_id = ?");
    params.push(query.user);
  }
  if (unindexed || query.from !== undefined || query.to !== undefined) {
    const range = dayRange(query.from, query.to, unindexed ? USAGE_CHARGE_RANGE_MAX_DAYS : undefined);
    where.push("created_at >= ?", "created_at < ?");
    params.push(Date.parse(`${range.from}T00:00:00Z`), Date.parse(`${range.to}T00:00:00Z`) + DAY_MS);
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
    events: rows.map((row) => ({ ...row, created_at: new Date(row.created_at).toISOString() })),
  } satisfies OperationResponse<"listAppRejectionEvents">);
}

/**
 * The value at a fraction of an ascending list, by nearest rank, as v1. Done
 * here rather than in SQL: the waits that end in a window are few.
 */
function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

type Summary = OperationResponse<"getAppAuthEventSummary">;

/**
 * An app's sign-in health over a trailing window, in one batch: attempts per
 * day, the networks failures came from, failed charges and sampled refusals
 * per day, the token-exchange success rate, the waits for an entitlement
 * claim, and the users waiting now. Every query is served by the app's index
 * by time on its table (`usage_day` by account, app and day), and the
 * waiting users by `app_end_user_claim_pending`.
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
  const window = "app_id = ?1 AND created_at >= ?2 AND created_at < ?3";
  const [daily, networks, failed, rejections, exchanges, delays, pending] = await db.batch([
    db
      .prepare(
        `SELECT ${DAY_OF("created_at")} AS date, event, outcome, reason, COUNT(*) AS count
           FROM app_auth_event WHERE ${window}
          GROUP BY date, event, outcome, reason ORDER BY date, event, outcome, reason`,
      )
      .bind(appId, start, end),
    // A recovered failure is left out (the app got past it on its own), and
    // so is an unknown network, which says nothing about where to look.
    db
      .prepare(
        `SELECT network_asn, MAX(network_name) AS network_name, COUNT(*) AS count, MAX(created_at) AS last_seen
           FROM app_auth_event
          WHERE ${window} AND outcome NOT IN ('ok', 'client_recovered') AND network_asn IS NOT NULL
          GROUP BY network_asn ORDER BY count DESC, network_asn LIMIT 10`,
      )
      .bind(appId, start, end),
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
      .bind(appId, start, end),
    db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(outcome = 'ok'), 0) AS ok
           FROM app_auth_event WHERE ${window} AND event = 'token_exchange'`,
      )
      .bind(appId, start, end),
    db
      .prepare(`SELECT claim_delay_ms AS ms FROM app_auth_event WHERE ${window} AND claim_delay_ms IS NOT NULL ORDER BY ms`)
      .bind(appId, start, end),
    // Active users only: a blocked user's wait can never end.
    db
      .prepare("SELECT COUNT(*) AS count FROM app_end_user WHERE app_id = ? AND claim_pending_since IS NOT NULL AND status = 'active'")
      .bind(appId),
  ]);
  const all = <T>(result: D1Result | undefined) => (result?.results ?? []) as T[];
  const waits = all<{ ms: number }>(delays).map((row) => row.ms);
  const exchange = all<{ total: number; ok: number }>(exchanges)[0] ?? { total: 0, ok: 0 };
  return c.json({
    app_id: appId,
    days,
    from,
    to: today,
    daily: all<Summary["daily"][number]>(daily),
    failing_networks: all<Omit<Summary["failing_networks"][number], "last_seen"> & { last_seen: number }>(networks).map((row) => ({
      ...row,
      last_seen: new Date(row.last_seen).toISOString(),
    })),
    failed_charges: all<Summary["failed_charges"][number]>(failed),
    rejection_samples: all<Summary["rejection_samples"][number]>(rejections),
    token_exchange: {
      total: exchange.total,
      ok: exchange.ok,
      // Null rather than 1: a window nobody signed in has no rate.
      success_rate: exchange.total === 0 ? null : exchange.ok / exchange.total,
    },
    claim_delay: {
      count: waits.length,
      avg_ms: waits.length === 0 ? null : Math.round(waits.reduce((sum, ms) => sum + ms, 0) / waits.length),
      p50_ms: percentile(waits, 0.5),
      p95_ms: percentile(waits, 0.95),
    },
    pending_users: all<{ count: number }>(pending)[0]?.count ?? 0,
  } satisfies Summary);
}
