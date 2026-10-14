/**
 * The month's spend per app, per end user and per install, as the request
 * gate reads it.
 *
 * D1 owns it. `app_usage_spend` is maintained by the triggers installed with
 * it, in the same write as the usage event that moves it — an insert adds the
 * event's cost, a reprice applies its delta — so reading a scope's month is one
 * row by its unique key, never a sum over events. The limiter caches that
 * figure for a few seconds (see `src/do/UserLimiter.ts`); nothing is pushed to
 * it, so there is nothing to deliver, acknowledge or recover.
 */

/**
 * Which ledger: an app's own (`scope: "app"`, `key` null), one of its end
 * users', or one install's — an App Attest key id. The scope names the ledger
 * outright rather than being inferred from a null key, because a user and an
 * install are both keyed by a string.
 */
export type SpendKey =
  | { appId: string; scope: "app"; key: null }
  | { appId: string; scope: "user" | "install"; key: string };

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
    .bind(key.scope, key.appId, key.key ?? "", month)
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
             AND (spend.scope = 'app'
               OR (spend.scope = 'user' AND events.user_id = spend.user_key)
               OR (spend.scope = 'install' AND events.install_id = spend.user_key))
         )
       ORDER BY spend.id LIMIT ?
     )`,
  ).bind(beforeMonth, USAGE_SPEND_PRUNE_BATCH).run();
  return result.meta.changes ?? 0;
}
