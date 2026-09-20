import { GatewayError } from "./errors";
import type { QueryBudget } from "./query-budget";
import {
  accountAccessDenial,
  type AccountAccessMode,
  type AccountLifecycle,
} from "../policy/accounts";
import { deploymentPolicy } from "../policy/deployment";
import {
  expiredUnclaimedAccountsCondition,
  humanOwnerCondition,
} from "../policy/sql";

/**
 * Lifecycle rows are read on the dispatch path of every hosted request, so they
 * are cached per isolate for a short interval instead of being re-read each
 * time.
 *
 * What makes that safe is the direction the gated fields can move, not how
 * rarely they move. Neither instant in a row is ever rewritten to a later one:
 * `created_at` is fixed, and `expires_at` only goes from a deadline to `NULL`.
 * So every transition that widens access is a claim — the CLI handoff, or the
 * recovery script promoting an owner, which clears the deadline for the same
 * reason — and every other write that touches this row, such as the scheduled
 * cleanup deleting an account already past its deadline, either narrows access
 * or leaves the gated fields alone. A stale entry can therefore refuse for a
 * moment longer than necessary, and can never admit for a moment longer than it
 * should.
 *
 * The isolate that serves the claim drops its own entry
 * ({@link invalidateAccountLifecycle}); every other isolate converges within
 * the TTL. Nothing here decides the claim itself: that is settled by the
 * guarded D1 writes in the handoff.
 *
 * Keys are organization ids that came out of D1, so the map is not
 * attacker-growable and needs no bound.
 */
const lifecycleCache = new Map<string, { value: AccountLifecycle; expiresAt: number }>();
const LIFECYCLE_CACHE_TTL_MS = 10_000;

export function invalidateAccountLifecycle(id: string): void {
  lifecycleCache.delete(id);
}

export function clearAccountLifecycleCache(): void {
  lifecycleCache.clear();
}

export async function accountLifecycle(
  env: Env,
  id: string,
): Promise<AccountLifecycle> {
  const cached = lifecycleCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  // Fill from the authoritative primary. The ten-second TTL is the entire
  // intentional lifecycle staleness window. The raw statement is used rather
  // than drizzle because the claim predicate is a correlated EXISTS.
  const row = await env.DB.prepare(
    `SELECT o.id, o.name, o.created_at AS createdAt,
    ${humanOwnerCondition("o.id")} AS claimed,
    o.expires_at AS expiresAt
    FROM mgmt_organization o WHERE o.id = ?`,
  )
    .bind(id)
    .first<AccountLifecycle>();
  if (!row) throw new GatewayError(404, "not_found", "Account was not found");
  const value = { ...row, claimed: Boolean(row.claimed) };
  lifecycleCache.set(id, { value, expiresAt: Date.now() + LIFECYCLE_CACHE_TTL_MS });
  return value;
}

/**
 * The one gate on an account's own deadlines.
 *
 * The row is read through {@link accountLifecycle}'s short-lived cache, but no
 * decision is: both deadlines are compared against the current instant on every
 * call, so a warm isolate stops an account on the same second a cold one would.
 * What a cached row can cost is the other direction — up to one TTL of refusals
 * after a claim has lifted them.
 */
export async function assertAccountAccess(
  env: Env,
  id: string,
  mode: AccountAccessMode,
): Promise<AccountLifecycle> {
  const account = await accountLifecycle(env, id);
  const denial = accountAccessDenial(
    deploymentPolicy(env).mode,
    account,
    mode,
    Date.now(),
  );
  if (denial === "account_expired") {
    throw new GatewayError(
      403,
      "account_expired",
      "The account recovery deadline has passed",
    );
  }
  if (denial === "billing_trial_expired") {
    throw new GatewayError(
      403,
      "billing_trial_expired",
      "The trial has ended; claim your account to continue",
    );
  }
  return account;
}

/**
 * Accounts one cleanup pass deletes.
 *
 * The batch is not what bounds a night's work — the loop below is — but a pass
 * costs the same seventeen statements whether it collects one account or two
 * hundred, so collecting one at a time would make the query allowance, not the
 * database, the thing that decides how fast an expired backlog drains. The
 * ceiling on the batch is transaction size: every statement in a pass is one
 * D1 transaction holding the single write lock, and a much larger batch could
 * reach the 30s statement limit on an account with a long usage history.
 */
export const ACCOUNT_CLEANUP_BATCH = 200;

/** Statements one cleanup pass issues: seventeen transactional deletes and updates. */
export const ACCOUNT_CLEANUP_PASS_QUERIES = 17;

/** Statements {@link pruneExpiredAuthorizations} issues, on every deployment. */
export const AUTHORIZATION_SWEEP_QUERIES = 2;

/**
 * Deletes one batch of expired accounts, and answers how many it found.
 *
 * Every statement repeats the unclaimed deadline predicate with one captured
 * cutoff and the same ordering, so the whole D1 transaction addresses one set
 * of accounts. A claim committed before this write transaction begins excludes
 * its account from every statement; no claim can commit midway through it.
 */
async function deleteExpiredAccountBatch(env: Env): Promise<number> {
  const cutoffMs = Date.now();
  const expiredCondition = expiredUnclaimedAccountsCondition(cutoffMs);
  const expired = `SELECT id FROM mgmt_organization o WHERE ${expiredCondition.sql}
    ORDER BY o.id LIMIT ${ACCOUNT_CLEANUP_BATCH}`;
  const cutoff = expiredCondition.params;
  const apps = `SELECT id FROM app WHERE organization_id IN (${expired})`;
  const statements: D1PreparedStatement[] = [];
  for (const table of [
    "app_api_key",
    "app_user",
    "app_usage_event",
    "app_usage_rollup",
    "app_usage_spend",
    "app_auth_event",
    "app_auth_challenge",
  ]) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM ${table} WHERE app_id IN (${apps})${table === "app_usage_event" || table === "app_usage_rollup" || table === "app_usage_spend" ? ` OR organization_id IN (${expired})` : ""}`,
      ).bind(
        ...(table === "app_usage_event" || table === "app_usage_rollup" || table === "app_usage_spend"
          ? [...cutoff, ...cutoff]
          : cutoff),
      ),
    );
  }
  for (const table of [
    "app",
    "provider",
    "provider_gateway",
    "mgmt_api_key",
    "mgmt_organization_user",
  ]) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM ${table} WHERE organization_id IN (${expired})`,
      ).bind(...cutoff),
    );
  }
  // Keep only the proof-bound bootstrap tombstone: deleting it would let an old
  // bootstrap recreate the same expired account. No account identity or secret survives.
  statements.push(
    env.DB.prepare(
      `UPDATE mgmt_resource_receipt SET outcome='{"expired":true}', organization_id=NULL,
      initiating_user_id=NULL, initiating_credential_id=NULL, protected_credential=NULL,
      protected_credential_expires_at=NULL, consumed_at=?, expires_at=?, updated_at=?
      WHERE kind='bootstrap' AND organization_id IN (${expired})`,
    ).bind(cutoffMs, cutoffMs, cutoffMs, ...cutoff),
  );
  statements.push(
    env.DB.prepare(
      `DELETE FROM mgmt_resource_receipt WHERE kind!='bootstrap' AND organization_id IN (${expired})`,
    ).bind(...cutoff),
  );
  statements.push(
    env.DB.prepare(
      `DELETE FROM mgmt_handoff WHERE organization_id IN (${expired})`,
    ).bind(...cutoff),
  );
  const accounts = statements.length;
  statements.push(
    env.DB.prepare(
      `DELETE FROM mgmt_organization WHERE id IN (${expired})`,
    ).bind(...cutoff),
  );
  statements.push(
    env.DB.prepare(
      `DELETE FROM mgmt_user WHERE id IN (SELECT id FROM mgmt_user WHERE kind='service' AND NOT EXISTS (SELECT 1 FROM mgmt_organization WHERE created_by_user_id=mgmt_user.id) AND NOT EXISTS (SELECT 1 FROM mgmt_organization_user WHERE user_id=mgmt_user.id) LIMIT 100)`,
    ),
  );
  const results = await env.DB.batch(statements);
  return results[accounts]?.meta.changes ?? 0;
}

/**
 * Deletes every expired unclaimed account the night's allowance can reach.
 *
 * One pass is bounded so it cannot hold the write lock indefinitely, which
 * means a backlog larger than one batch — the shape abuse takes, since a
 * bootstrap is rate limited per address and an account becomes eligible only
 * ninety days after it was created — needs more than one. So passes repeat
 * while the last one filled its batch and the run can still afford another.
 * A backlog that outlives the allowance is continued the following night.
 */
export async function pruneExpiredAccounts(
  env: Env,
  budget: QueryBudget = { remaining: ACCOUNT_CLEANUP_PASS_QUERIES },
): Promise<number> {
  let deleted = 0;
  while (budget.remaining >= ACCOUNT_CLEANUP_PASS_QUERIES) {
    budget.remaining -= ACCOUNT_CLEANUP_PASS_QUERIES;
    const batch = await deleteExpiredAccountBatch(env);
    deleted += batch;
    if (batch < ACCOUNT_CLEANUP_BATCH) break;
  }
  return deleted;
}

/**
 * Expires the two short-lived authorizations, wherever this gateway runs.
 *
 * Unlike the account cleanup above, this is not about a deadline only a hosted
 * account has: a receipt's one-time response copy and a browser handoff are
 * written by the CLI against any deployment, so both are swept on a self-host
 * too. Receipt tombstones themselves are kept — they are what stops an expired
 * retry creating a second app or key — and only the encrypted response inside
 * them is dropped once its recovery window has passed.
 */
export async function pruneExpiredAuthorizations(env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE mgmt_resource_receipt SET protected_credential = NULL WHERE protected_credential_expires_at <= ?",
  )
    .bind(Date.now())
    .run();
  await env.DB.prepare(
    "DELETE FROM mgmt_handoff WHERE expires_at < ?",
  )
    .bind(Date.now())
    .run();
}
