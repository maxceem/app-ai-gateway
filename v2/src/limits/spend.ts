/**
 * Dollar budget totals, read from the rollups (`budget_day`) in the
 * account's ledger object, which the ledger trigger keeps. Nothing else writes them, so a charge is counted once.
 *
 * A budget month is the UTC calendar month, as v1.
 */
import type { BudgetScope } from "../contracts/app-config.ts";

/** Whose month a budget is measured over, and in which account's ledger. The app's own scope is keyed by the app id. */
export type SpendKey =
  | { accountId: string; appId: string; scope: "app"; key: string }
  | { accountId: string; appId: string; scope: BudgetScope; key: string };

/** The first day of `now`'s UTC month and of the next one, as `YYYY-MM-DD`. */
export function utcMonthDays(now: number): { from: string; to: string } {
  const date = new Date(now);
  const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** When `now`'s UTC month ends. */
export function nextUtcMonthStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** The scope's spend in `now`'s UTC month, in nano-dollars. */
export async function monthlySpendNano(db: D1Database, key: SpendKey, now: number): Promise<number> {
  const { from, to } = utcMonthDays(now);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(cost_nano), 0) AS spent FROM budget_day
       WHERE app_id = ? AND scope = ? AND scope_id = ? AND day >= ? AND day < ?`,
    )
    .bind(key.appId, key.scope, key.key, from, to)
    .first<{ spent: number }>();
  return row?.spent ?? 0;
}
