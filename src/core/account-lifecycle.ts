import { GatewayError } from "./errors";
import { ttlCache } from "./ttl-cache";
import { QueryBudget } from "./query-budget";
import {
  accountAccessDenial,
  type AccountAccessMode,
  type AccountLifecycle,
} from "../policy/accounts";
import type { Deployment } from "../policy/deployment";
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
 * Keys are organization ids that came out of D1, so the cache is not
 * attacker-growable; the bound is only so that a long-lived isolate in a large
 * deployment cannot keep one entry per account it ever served, and it sits far
 * above what any isolate reads inside a ten-second window.
 *
 * Exported for the tests that clear it on its own; nothing in the Worker reads
 * it but this file.
 */
const LIFECYCLE_CACHE_TTL_MS = 10_000;
export const accountLifecycleCache = ttlCache<string, AccountLifecycle>({
  name: "account-lifecycle",
  ttlMs: LIFECYCLE_CACHE_TTL_MS,
  maxEntries: 5_000,
});

export function invalidateAccountLifecycle(id: string): void {
  accountLifecycleCache.delete(id);
}

export async function accountLifecycle(
  env: Env,
  id: string,
): Promise<AccountLifecycle> {
  const cached = accountLifecycleCache.get(id);
  if (cached) return cached;
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
  accountLifecycleCache.set(id, value);
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
  deployment: Deployment,
  env: Env,
  id: string,
  mode: AccountAccessMode,
): Promise<AccountLifecycle> {
  const account = await accountLifecycle(env, id);
  const denial = accountAccessDenial(
    deployment.mode,
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

/** Tables whose rows belong to an application of an expired account. */
const APP_SCOPED_TABLES = [
  "app_api_key",
  "app_user",
  "app_usage_event",
  "app_usage_rollup",
  "app_usage_spend",
  "app_auth_event",
  "app_auth_challenge",
] as const;

/** Of those, the ones that also carry the account directly. */
const ORGANIZATION_STAMPED_TABLES = new Set([
  "app_usage_event",
  "app_usage_rollup",
  "app_usage_spend",
]);

/** Tables whose rows belong to the expired account itself. */
const ORGANIZATION_SCOPED_TABLES = [
  "app",
  "provider",
  "provider_gateway",
  "mgmt_api_key",
  "mgmt_organization_user",
] as const;

interface CleanupStatement {
  sql: string;
  params: unknown[];
}

/**
 * The statements one cleanup pass issues, as SQL and parameters.
 *
 * Built apart from the database so the pass's size is knowable before any of it
 * is issued — {@link ACCOUNT_CLEANUP_STATEMENTS} is this list's length, not a
 * number written down beside it — and so adding a table here moves the loop's
 * own bound with it.
 *
 * Every statement repeats the unclaimed deadline predicate with one captured
 * cutoff and the same ordering, so the whole D1 transaction addresses one set
 * of accounts. A claim committed before this write transaction begins excludes
 * its account from every statement; no claim can commit midway through it.
 */
function accountCleanupStatements(cutoffMs: number): {
  statements: CleanupStatement[];
  /** Index of the statement whose `changes` counts the accounts collected. */
  accounts: number;
} {
  const expiredCondition = expiredUnclaimedAccountsCondition(cutoffMs);
  const expired = `SELECT id FROM mgmt_organization o WHERE ${expiredCondition.sql}
    ORDER BY o.id LIMIT ${ACCOUNT_CLEANUP_BATCH}`;
  const cutoff = expiredCondition.params;
  const apps = `SELECT id FROM app WHERE organization_id IN (${expired})`;
  const statements: CleanupStatement[] = [];
  for (const table of APP_SCOPED_TABLES) {
    const stamped = ORGANIZATION_STAMPED_TABLES.has(table);
    statements.push({
      sql: `DELETE FROM ${table} WHERE app_id IN (${apps})${stamped ? ` OR organization_id IN (${expired})` : ""}`,
      params: stamped ? [...cutoff, ...cutoff] : [...cutoff],
    });
  }
  for (const table of ORGANIZATION_SCOPED_TABLES) {
    statements.push({
      sql: `DELETE FROM ${table} WHERE organization_id IN (${expired})`,
      params: [...cutoff],
    });
  }
  // Keep only the proof-bound bootstrap tombstone: deleting it would let an old
  // bootstrap recreate the same expired account. No account identity or secret survives.
  statements.push({
    sql: `UPDATE mgmt_bootstrap SET state='expired', organization_id=NULL,
      service_user_id=NULL, credential_id=NULL, protected_credential=NULL,
      protected_credential_expires_at=NULL, updated_at=?
      WHERE organization_id IN (${expired})`,
    params: [cutoffMs, ...cutoff],
  });
  // Receipts of kind 'bootstrap' are the pre-0006 copies of bootstrap rows,
  // kept until no Worker older than that migration can be serving. They are
  // left alone here: deleting its account nulls their `organization_id`, which
  // such a Worker reads as expired, so each still refuses its own replay.
  statements.push({
    sql: `DELETE FROM mgmt_resource_receipt WHERE kind!='bootstrap' AND organization_id IN (${expired})`,
    params: [...cutoff],
  });
  statements.push({
    sql: `DELETE FROM mgmt_handoff WHERE organization_id IN (${expired})`,
    params: [...cutoff],
  });
  const accounts = statements.length;
  statements.push({
    sql: `DELETE FROM mgmt_organization WHERE id IN (${expired})`,
    params: [...cutoff],
  });
  statements.push({
    sql: `DELETE FROM mgmt_user WHERE id IN (SELECT id FROM mgmt_user WHERE kind='service' AND NOT EXISTS (SELECT 1 FROM mgmt_organization WHERE created_by_user_id=mgmt_user.id) AND NOT EXISTS (SELECT 1 FROM mgmt_organization_user WHERE user_id=mgmt_user.id) LIMIT 100)`,
    params: [],
  });
  return { statements, accounts };
}

/**
 * Statements one cleanup pass issues, counted from the pass rather than declared.
 *
 * Local on purpose: the run's allowance is charged for what the batch actually
 * issues, so this number is only what the loop below needs in order to decide
 * whether another whole pass still fits.
 */
const ACCOUNT_CLEANUP_STATEMENTS = accountCleanupStatements(0).statements.length;

/** Deletes one batch of expired accounts, and answers how many it found. */
async function deleteExpiredAccountBatch(db: D1Database): Promise<number> {
  const { statements, accounts } = accountCleanupStatements(Date.now());
  const results = await db.batch(
    statements.map(({ sql, params }) =>
      params.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...params),
    ),
  );
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
  db: D1Database,
  budget: QueryBudget = new QueryBudget(ACCOUNT_CLEANUP_STATEMENTS),
): Promise<number> {
  let deleted = 0;
  // A pass is one transaction, so it is asked for in full or not started: the
  // charge lands as the batch is issued, not before it.
  while (budget.affords(ACCOUNT_CLEANUP_STATEMENTS)) {
    const batch = await deleteExpiredAccountBatch(db);
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
export async function pruneExpiredAuthorizations(db: D1Database): Promise<void> {
  await db.prepare(
    "UPDATE mgmt_resource_receipt SET protected_credential = NULL WHERE protected_credential_expires_at <= ?",
  )
    .bind(Date.now())
    .run();
  await db.prepare(
    "UPDATE mgmt_bootstrap SET protected_credential = NULL WHERE protected_credential_expires_at <= ?",
  )
    .bind(Date.now())
    .run();
  await db.prepare(
    "DELETE FROM mgmt_handoff WHERE expires_at < ?",
  )
    .bind(Date.now())
    .run();
}
