/**
 * Usage reads through the management API (v1's usage endpoints, read from the
 * v2 ledger).
 *
 * Totals come from the rollups. A day's totals are in `usage_day` for 400
 * days; after that the nightly run folds them into `usage_month`
 * (`../ledger/retention.ts`), a chunk at a time, so a month can sit partly in
 * each table. {@link monthUsageSql} is the one reader that adds both, and every
 * month total goes through it. Day ranges (a timeseries, a breakdown) read
 * `usage_day` alone: a month row has no day to place.
 *
 * The charges are the ledger's own rows, kept 90 days. A breakdown by a
 * dimension the rollups do not carry (the user, the operation, the price
 * source) is read from them, so it reaches back only 90 days.
 *
 * Every query is bound to the caller's account as well as the app: an app id
 * may come back in another account after its app was deleted, and the ledger
 * keeps the first account's rows.
 */
import type { Context } from "hono";
import type { OperationResponse } from "../contracts/catalog.ts";
import {
  ChargeListQuerySchema,
  USAGE_RANGE_MAX_DAYS,
  UsageBreakdownQuerySchema,
  UsageMonthQuerySchema,
  UsageRangeQuerySchema,
  type UsageDimension,
  type UsageTotals,
} from "../contracts/usage.ts";
import { GatewayError } from "../core/errors.ts";
import type { AdminVariables } from "./actor.ts";
import { currentMonth } from "./users.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

const DAY_MS = 86_400_000;

function parseQuery<T>(c: AdminContext, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { message: string }[] } } }): T {
  const parsed = schema.safeParse(c.req.query());
  if (parsed.success) return parsed.data;
  throw new GatewayError(400, "invalid_request", parsed.error.issues[0]?.message ?? "The query is invalid");
}

async function appExists(db: D1Database, accountId: string, appId: string): Promise<void> {
  const row = await db.prepare("SELECT 1 AS found FROM app WHERE id = ? AND account_id = ?").bind(appId, accountId).first();
  if (row === null) throw new GatewayError(404, "app_not_found", "App is not registered");
}

/** The sums of rollup rows (`usage_day` or `usage_month`), as the columns of {@link UsageTotals} in nano-dollars. */
const ROLLUP_SUMS = `
  COALESCE(SUM(charges), 0) AS charges,
  COALESCE(SUM(CASE WHEN outcome = 'failed' THEN charges ELSE 0 END), 0) AS failed,
  COALESCE(SUM(unpriced_charges), 0) AS unpriced,
  COALESCE(SUM(cost_nano), 0) AS cost_nano,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(session_ms), 0) AS session_ms`;

/** The same sums over charge rows: a correction changes the cost of a charge already counted, so it is never counted itself. */
const CHARGE_SUMS = `
  COALESCE(SUM(kind <> 'correction'), 0) AS charges,
  COALESCE(SUM(kind <> 'correction' AND status <> 'ok'), 0) AS failed,
  COALESCE(SUM(kind <> 'correction' AND price_source IN ('unresolved', 'not_priced')), 0) AS unpriced,
  COALESCE(SUM(cost_nano), 0) AS cost_nano,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(session_ms), 0) AS session_ms`;

/** The rollup columns {@link ROLLUP_SUMS} reads, for a union of both rollup tables. */
const ROLLUP_COLUMNS =
  "app_id, outcome, charges, unpriced_charges, cost_nano, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, session_ms";

/**
 * One UTC month's rollup rows of an account, or of one of its apps: its
 * `usage_month` rows and whatever of it is still in `usage_day`. A month can
 * be in both at once (the fold moves it a chunk at a time, and a late row can
 * land in a day already folded), and never counts a row twice: the fold adds a
 * day to its month and deletes it in one transaction.
 *
 * Parameters: `?1` account, `?2` month (`YYYY-MM`), `?3` first day, `?4` the
 * first day of the next month, and with `oneApp`, `?5` the app.
 */
export function monthUsageSql(oneApp: boolean): string {
  const app = oneApp ? " AND app_id = ?5" : "";
  return `
    SELECT ${ROLLUP_COLUMNS} FROM usage_day WHERE account_id = ?1${app} AND day >= ?3 AND day < ?4
    UNION ALL
    SELECT ${ROLLUP_COLUMNS} FROM usage_month WHERE account_id = ?1${app} AND month = ?2`;
}

/** A month's first day and the next month's first day, `YYYY-MM-DD`. */
function monthDays(month: string): { first: string; next: string } {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return { first: `${month}-01`, next: new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 10) };
}

type SumRow = Omit<UsageTotals, "cost_usd">;

/** Nano-dollars become dollars only here, at the edge. */
function totals(row: Partial<SumRow> | null | undefined): UsageTotals {
  const value = (key: keyof SumRow) => Number(row?.[key] ?? 0);
  const costNano = value("cost_nano");
  return {
    charges: value("charges"),
    failed: value("failed"),
    unpriced: value("unpriced"),
    cost_nano: costNano,
    cost_usd: costNano / 1e9,
    input_tokens: value("input_tokens"),
    cached_input_tokens: value("cached_input_tokens"),
    cache_write_tokens: value("cache_write_tokens"),
    output_tokens: value("output_tokens"),
    session_ms: value("session_ms"),
  };
}

/** An inclusive range of UTC days, by default the 30 days ending today; at most {@link USAGE_RANGE_MAX_DAYS} days. */
function dayRange(from: string | undefined, to: string | undefined, now = Date.now()): { from: string; to: string } {
  const end = to ?? new Date(now).toISOString().slice(0, 10);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(endMs)) throw new GatewayError(400, "invalid_request", "to is not a real day");
  const start = from ?? new Date(endMs - 29 * DAY_MS).toISOString().slice(0, 10);
  const startMs = Date.parse(`${start}T00:00:00Z`);
  if (Number.isNaN(startMs)) throw new GatewayError(400, "invalid_request", "from is not a real day");
  if (start > end) throw new GatewayError(400, "invalid_request", "from must not be after to");
  if ((endMs - startMs) / DAY_MS + 1 > USAGE_RANGE_MAX_DAYS) {
    throw new GatewayError(400, "invalid_request", `A range covers at most ${USAGE_RANGE_MAX_DAYS} days`);
  }
  return { from: start, to: end };
}

export async function getAccountUsage(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const month = parseQuery(c, UsageMonthQuerySchema).month ?? currentMonth();
  const { first, next } = monthDays(month);
  const db = c.env.DB;
  const [perApp, oldest] = await db.batch([
    db
      .prepare(`SELECT app_id, ${ROLLUP_SUMS} FROM (${monthUsageSql(false)}) GROUP BY app_id`)
      .bind(actor.accountId, month, first, next),
    // The oldest usage kept: a month total sorts before the days of its own month.
    db
      .prepare(
        `SELECT min(COALESCE(d, m), COALESCE(m, d)) AS first FROM (
           SELECT (SELECT MIN(day) FROM usage_day WHERE account_id = ?1) AS d,
                  (SELECT MIN(month) FROM usage_month WHERE account_id = ?1) AS m)`,
      )
      .bind(actor.accountId),
  ]);
  const rows = (perApp?.results ?? []) as (SumRow & { app_id: string })[];
  const names = rows.length === 0
    ? new Map<string, string>()
    : new Map(
        (
          await db
            .prepare("SELECT id, name FROM app WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))")
            .bind(actor.accountId, JSON.stringify(rows.map((row) => row.app_id)))
            .all<{ id: string; name: string }>()
        ).results.map((row) => [row.id, row.name]),
      );
  const apps = rows
    .map((row) => ({ app_id: row.app_id, name: names.get(row.app_id) ?? null, deleted: !names.has(row.app_id), ...totals(row) }))
    .sort((a, b) => b.cost_nano - a.cost_nano || b.charges - a.charges || a.app_id.localeCompare(b.app_id));
  const sum = (key: keyof SumRow) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  return c.json({
    month,
    totals: totals({
      charges: sum("charges"),
      failed: sum("failed"),
      unpriced: sum("unpriced"),
      cost_nano: sum("cost_nano"),
      input_tokens: sum("input_tokens"),
      cached_input_tokens: sum("cached_input_tokens"),
      cache_write_tokens: sum("cache_write_tokens"),
      output_tokens: sum("output_tokens"),
      session_ms: sum("session_ms"),
    }),
    apps,
    first_usage_day: ((oldest?.results[0] as { first?: string | null } | undefined)?.first ?? null),
  } satisfies OperationResponse<"getAccountUsage">);
}

export async function getAppUsage(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const month = parseQuery(c, UsageMonthQuerySchema).month ?? currentMonth();
  await appExists(c.env.DB, actor.accountId, appId);
  const { first, next } = monthDays(month);
  const row = await c.env.DB.prepare(`SELECT ${ROLLUP_SUMS} FROM (${monthUsageSql(true)})`)
    .bind(actor.accountId, month, first, next, appId)
    .first<SumRow>();
  return c.json({ app_id: appId, month, ...totals(row) } satisfies OperationResponse<"getAppUsage">);
}

export async function getAppUsageTimeseries(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const query = parseQuery(c, UsageRangeQuerySchema);
  const range = dayRange(query.from, query.to);
  await appExists(c.env.DB, actor.accountId, appId);
  const { results } = await c.env.DB.prepare(
    `SELECT day, provider_type, ${ROLLUP_SUMS} FROM usage_day
      WHERE app_id = ? AND account_id = ? AND day >= ? AND day <= ?
      GROUP BY day, provider_type
      ORDER BY day, provider_type`,
  )
    .bind(appId, actor.accountId, range.from, range.to)
    .all<SumRow & { day: string; provider_type: string }>();
  return c.json({
    app_id: appId,
    ...range,
    buckets: results.map((row) => ({ day: row.day, provider_type: row.provider_type, ...totals(row) })),
  } satisfies OperationResponse<"getAppUsageTimeseries">);
}

/** The column each breakdown dimension groups by: the day totals' own, or the charges'. */
const TOTALS_COLUMNS: Partial<Record<UsageDimension, string>> = {
  model: "model",
  provider: "provider_type",
  connection: "provider_connection_id",
  status: "outcome",
  unit: "unit",
};
const CHARGE_COLUMNS: Partial<Record<UsageDimension, string>> = {
  user: "end_user_id",
  install: "install_id",
  operation: "operation",
  preset: "preset",
  price_source: "price_source",
  measured: "measured",
  app_version: "app_version",
};

export async function getAppUsageBreakdown(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const query = parseQuery(c, UsageBreakdownQuerySchema);
  const range = dayRange(query.from, query.to);
  await appExists(c.env.DB, actor.accountId, appId);
  const db = c.env.DB;
  // A column name cannot be bound: each is a lookup in the tables above, never caller text.
  const totalsColumn = TOTALS_COLUMNS[query.by];
  const order = "ORDER BY cost_nano DESC, charges DESC, key LIMIT ?";
  const { results } = totalsColumn !== undefined
    ? await db
        .prepare(
          `SELECT NULLIF(${totalsColumn}, '') AS key, ${ROLLUP_SUMS} FROM usage_day
            WHERE app_id = ? AND account_id = ? AND day >= ? AND day <= ?
            GROUP BY key ${order}`,
        )
        .bind(appId, actor.accountId, range.from, range.to, query.limit)
        .all<SumRow & { key: string | null }>()
    : await db
        .prepare(
          `SELECT ${CHARGE_COLUMNS[query.by]!} AS key, ${CHARGE_SUMS} FROM charge
            WHERE app_id = ? AND account_id = ? AND used_at >= ? AND used_at < ?
            GROUP BY key ${order}`,
        )
        .bind(appId, actor.accountId, Date.parse(`${range.from}T00:00:00Z`), Date.parse(`${range.to}T00:00:00Z`) + DAY_MS, query.limit)
        .all<SumRow & { key: string | null }>();
  // A connection reads better by its slug; a deleted one keeps its id and no label.
  const slugs = query.by === "connection" && results.length > 0
    ? new Map(
        (
          await db
            .prepare("SELECT id, slug FROM provider_connection WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))")
            .bind(actor.accountId, JSON.stringify(results.map((row) => row.key).filter((key) => key !== null)))
            .all<{ id: string; slug: string }>()
        ).results.map((row) => [row.id, row.slug]),
      )
    : null;
  return c.json({
    app_id: appId,
    by: query.by,
    ...range,
    rows: results.map((row) => ({
      key: row.key,
      ...(slugs === null ? {} : { label: row.key === null ? null : (slugs.get(row.key) ?? null) }),
      ...totals(row),
    })),
  } satisfies OperationResponse<"getAppUsageBreakdown">);
}

interface ChargeRowOut {
  id: string;
  kind: OperationResponse<"listAppCharges">["charges"][number]["kind"];
  owner_type: OperationResponse<"listAppCharges">["charges"][number]["owner_type"];
  owner_id: string;
  corrects_charge_id: string | null;
  correction_kind: string | null;
  status: string;
  http_status: number | null;
  error_code: string | null;
  provider_type: string;
  provider_connection_id: string | null;
  operation: string;
  preset: string | null;
  model: string | null;
  end_user_id: string | null;
  install_id: string | null;
  cost_nano: number | null;
  measured: OperationResponse<"listAppCharges">["charges"][number]["measured"];
  price_source: OperationResponse<"listAppCharges">["charges"][number]["price_source"];
  price_is_estimate: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  unit: string | null;
  units: number | null;
  session_ms: number | null;
  latency_ms: number | null;
  app_version: string | null;
  auth_method: string | null;
  client_trace_id: string | null;
  used_at: number;
  usage_day: string;
}

/** A page position: the last charge's time and id, so equal times still page in order. */
function parseBefore(before: string): { usedAt: number; id: string } {
  const at = before.indexOf(".");
  const usedAt = Number(before.slice(0, at));
  if (at <= 0 || !Number.isSafeInteger(usedAt)) throw new GatewayError(400, "invalid_request", "before is not a page position this API gave");
  return { usedAt, id: before.slice(at + 1) };
}

/** Each filter's column, compared for equality. Every one is a fixed name, never caller text. */
const CHARGE_FILTERS = {
  kind: "kind",
  provider: "provider_type",
  connection: "provider_connection_id",
  model: "model",
  user: "end_user_id",
  install: "install_id",
  operation: "operation",
  owner: "owner_id",
  price_source: "price_source",
  measured: "measured",
  trace: "client_trace_id",
} as const;

export async function listAppCharges(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const appId = c.req.param("app")!;
  const query = parseQuery(c, ChargeListQuerySchema);
  await appExists(c.env.DB, actor.accountId, appId);
  // Served by `charge_app_used`: the app's charges by time, newest first.
  const where = ["app_id = ?", "account_id = ?"];
  const params: unknown[] = [appId, actor.accountId];
  if (query.from !== undefined || query.to !== undefined) {
    const range = dayRange(query.from, query.to);
    where.push("used_at >= ?", "used_at < ?");
    params.push(Date.parse(`${range.from}T00:00:00Z`), Date.parse(`${range.to}T00:00:00Z`) + DAY_MS);
  }
  for (const [name, column] of Object.entries(CHARGE_FILTERS) as [keyof typeof CHARGE_FILTERS, string][]) {
    const value = query[name];
    if (value === undefined) continue;
    where.push(`${column} = ?`);
    params.push(value);
  }
  if (query.status === "failed") where.push("status <> 'ok'");
  else if (query.status !== undefined) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.before !== undefined) {
    const before = parseBefore(query.before);
    where.push("(used_at < ? OR (used_at = ? AND id < ?))");
    params.push(before.usedAt, before.usedAt, before.id);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, owner_type, owner_id, corrects_charge_id, correction_kind, status, http_status, error_code,
            provider_type, provider_connection_id, operation, preset, model, end_user_id, install_id, cost_nano,
            measured, price_source, price_is_estimate, input_tokens, cached_input_tokens, cache_write_tokens,
            output_tokens, unit, units, session_ms, latency_ms, app_version, auth_method, client_trace_id,
            used_at, usage_day
       FROM charge
      WHERE ${where.join(" AND ")}
      ORDER BY used_at DESC, id DESC
      LIMIT ?`,
  )
    .bind(...params, query.limit)
    .all<ChargeRowOut>();
  const last = results.at(-1);
  return c.json({
    app_id: appId,
    limit: query.limit,
    next_before: results.length === query.limit && last !== undefined ? `${last.used_at}.${last.id}` : null,
    charges: results.map((row) => ({
      ...row,
      cost_usd: row.cost_nano === null ? null : row.cost_nano / 1e9,
      price_is_estimate: row.price_is_estimate === 1,
      used_at: new Date(row.used_at).toISOString(),
    })),
  } satisfies OperationResponse<"listAppCharges">);
}
