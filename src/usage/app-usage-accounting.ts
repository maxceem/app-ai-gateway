/**
 * The month's spend per app, per end user, per install and per Apple
 * Account, as the request gate reads it.
 *
 * D1 owns it. `app_usage_spend` is maintained by the triggers installed with
 * it, in the same write as the usage event that moves it — an insert adds the
 * event's cost, a reprice applies its delta — so reading a scope's month is one
 * row by its unique key, never a sum over events. The limiter caches that
 * figure for a few seconds (see `src/do/UserLimiter.ts`); nothing is pushed to
 * it, so there is nothing to deliver, acknowledge or recover.
 */

import type { AppConfig } from "../contracts/schemas";
import type { GatewayIdentity } from "../core/types";
import { budgetScope } from "../shared/app-config";

/**
 * Which ledger: an app's own (`scope: "app"`, `key` null), one of its end
 * users', one install's — an App Attest key id — or one Apple Account's, by
 * the hash the token exchange derived. The scope names the ledger outright
 * rather than being inferred from a null key, because all three are keyed by
 * a string.
 */
export type SpendKey =
  | { appId: string; scope: "app"; key: null }
  | { appId: string; scope: "user" | "install" | "apple_account"; key: string };

/** A per-caller ledger: anything but the app's own. */
export type PerUserSpendKey = SpendKey & { scope: "install" | "user" | "apple_account" };

/**
 * Whose month an App Attest caller's per-user budget is measured over, for
 * admission and for `/me` alike, so the two can never report different ledgers.
 *
 * The application's `spending.scope` decides, with one fallback: an install
 * whose token names no Apple Account — its client predates sending the App
 * Store transaction, or the transaction did not verify — is measured over its
 * own month under `apple_account`. That is exactly what it was before Apple
 * Accounts existed, so an older build is never worse off, and never refused
 * for something it cannot send.
 */
export function attestLedger(
  config: AppConfig,
  identity: Extract<GatewayIdentity, { authMethod: "attest" }>,
): PerUserSpendKey {
  const { appId, userId } = identity;
  const scope = budgetScope(config);
  // An App Attest identity always names somebody, so `user` has a key.
  if (scope === "user" && userId !== null) return { appId, scope: "user", key: userId };
  if (scope === "apple_account" && identity.appleAccountId !== null) {
    return { appId, scope: "apple_account", key: identity.appleAccountId };
  }
  return { appId, scope: "install", key: identity.installId };
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
               OR (spend.scope = 'install' AND events.install_id = spend.user_key)
               OR (spend.scope = 'apple_account' AND events.apple_account_id = spend.user_key))
         )
       ORDER BY spend.id LIMIT ?
     )`,
  ).bind(beforeMonth, USAGE_SPEND_PRUNE_BATCH).run();
  return result.meta.changes ?? 0;
}
