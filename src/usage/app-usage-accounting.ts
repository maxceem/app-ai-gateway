/**
 * The month's spend per app and per end user, as the request gate reads it.
 *
 * D1 owns it. `app_usage_spend` is maintained by the triggers installed with
 * it, in the same write as the usage event that moves it — an insert adds the
 * event's cost, a reprice applies its delta — so reading a scope's month is one
 * row by its unique key, never a sum over events. The limiter caches that
 * figure for a few seconds (see `src/do/UserLimiter.ts`); nothing is pushed to
 * it, so there is nothing to deliver, acknowledge or recover.
 */

/** Which ledger: an app's own (`userKey` null) or one of its end users'. */
export interface SpendKey {
  appId: string;
  userKey: string | null;
}

/** The scope's spend in one UTC calendar month, in whole microdollars. */
export async function monthlySpendMicrousd(
  db: D1Database,
  key: SpendKey,
  month: string,
): Promise<number> {
  const row = await db.prepare(
    `SELECT microusd FROM app_usage_spend
     WHERE scope = ? AND app_id = ? AND user_key = ? AND month = ?`,
  )
    .bind(key.userKey === null ? "app" : "user", key.appId, key.userKey ?? "", month)
    .first<{ microusd: number }>();
  return row?.microusd ?? 0;
}

export const USAGE_SPEND_PRUNE_BATCH = 5_000;

/**
 * Drops totals for whole months beyond raw retention, and only once every raw
 * event that could still be repriced has gone: a reprice applies its delta to
 * the row, so a row deleted under a surviving event would come back holding
 * that event's cost alone.
 */
export async function pruneSettledUsageSpend(
  db: D1Database,
  beforeMonth: string,
): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM app_usage_spend WHERE id IN (
       SELECT spend.id FROM app_usage_spend AS spend
       WHERE spend.month < ?
         AND NOT EXISTS (
           SELECT 1 FROM app_usage_event AS events
           WHERE events.app_id = spend.app_id
             AND substr(events.created_at, 1, 7) = spend.month
             AND (spend.scope = 'app' OR events.user_id = spend.user_key)
         )
       ORDER BY spend.id LIMIT ?
     )`,
  ).bind(beforeMonth, USAGE_SPEND_PRUNE_BATCH).run();
  return result.meta.changes ?? 0;
}
