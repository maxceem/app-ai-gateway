import { log } from "./log";

export type UsageSpendScope = "app" | "user";

export interface UsageSpendRow {
  id: number;
  app_id: string;
  scope: UsageSpendScope;
  user_key: string;
  month: string;
  microusd: number;
  revision: number;
}

export interface ProjectionResult {
  attempted: number;
  acknowledged: number;
  projectedUsers: number;
}

/** One select plus at most 12 attempt/RPC/ack triplets stays below Free's 50. */
export const USAGE_SPEND_RECOVERY_BATCH = 12;
export const USAGE_SPEND_PRUNE_BATCH = 5_000;

function validLimit(limit: number, ceiling: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) return 0;
  return Math.min(limit, ceiling);
}

/**
 * Delivers one immutable aggregate version and conditionally acknowledges that
 * exact identity. The full key is repeated because SQLite may reuse a deleted
 * integer rowid; id + revision alone could otherwise clear an unrelated row.
 */
export async function deliverUsageSpend(
  env: Env,
  row: UsageSpendRow,
): Promise<boolean> {
  const identity = [
    row.id,
    row.scope,
    row.app_id,
    row.user_key,
    row.month,
    row.revision,
  ] as const;
  const attempted = await env.DB.prepare(
    `UPDATE app_usage_spend SET last_attempt_at = ?
     WHERE id = ? AND scope = ? AND app_id = ? AND user_key = ?
       AND month = ? AND revision = ? AND pending = 1`,
  ).bind(Date.now(), ...identity).run();
  if ((attempted.meta.changes ?? 0) !== 1) return false;

  const limiterName = row.scope === "app" ? row.app_id : `${row.app_id}:${row.user_key}`;
  await env.USER_LIMITER
    .getByName(limiterName)
    .setMonthlyCost(row.month, row.revision, row.microusd);

  const acknowledged = await env.DB.prepare(
    `UPDATE app_usage_spend SET pending = 0
     WHERE id = ? AND scope = ? AND app_id = ? AND user_key = ?
       AND month = ? AND revision = ? AND pending = 1`,
  ).bind(...identity).run();
  return (acknowledged.meta.changes ?? 0) === 1;
}

async function projectRows(env: Env, rows: UsageSpendRow[]): Promise<ProjectionResult> {
  const result: ProjectionResult = { attempted: 0, acknowledged: 0, projectedUsers: 0 };
  for (const row of rows) {
    result.attempted += 1;
    try {
      if (!await deliverUsageSpend(env, row)) continue;
      result.acknowledged += 1;
      if (row.scope === "user") result.projectedUsers += 1;
    } catch (error) {
      // The row remains pending. Each row is isolated so one unavailable object
      // rotates to the back without starving the rest of this bounded pass.
      log("error", "usage_spend_projection_failed", {
        appId: row.app_id,
        scope: row.scope,
        userId: row.scope === "user" ? row.user_key : undefined,
        month: row.month,
        revision: row.revision,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/** Projects the app row and optional real user row affected by one event. */
export async function projectUsageEventSpend(
  env: Env,
  input: { appId: string; userId: string | null; month: string },
): Promise<ProjectionResult> {
  const userPredicate = input.userId === null
    ? "scope = 'app' AND user_key = ''"
    : "(scope = 'app' AND user_key = '') OR (scope = 'user' AND user_key = ?)";
  const statement = env.DB.prepare(
    `SELECT id, app_id, scope, user_key, month, microusd, revision
     FROM app_usage_spend
     WHERE app_id = ? AND month = ? AND pending = 1 AND (${userPredicate})
     ORDER BY scope, id`,
  );
  const { results } = input.userId === null
    ? await statement.bind(input.appId, input.month).all<UsageSpendRow>()
    : await statement.bind(input.appId, input.month, input.userId).all<UsageSpendRow>();
  return projectRows(env, results);
}

/** Projects a bounded set after a bulk reprice; the remainder stays pending. */
export async function projectPendingAppMonthSpend(
  env: Env,
  appId: string,
  month: string,
  limit: number,
): Promise<ProjectionResult> {
  const bounded = validLimit(limit, USAGE_SPEND_RECOVERY_BATCH);
  if (bounded === 0) return { attempted: 0, acknowledged: 0, projectedUsers: 0 };
  const { results } = await env.DB.prepare(
    `SELECT id, app_id, scope, user_key, month, microusd, revision
     FROM app_usage_spend
     WHERE app_id = ? AND month = ? AND pending = 1
     ORDER BY last_attempt_at, id LIMIT ?`,
  ).bind(appId, month, bounded).all<UsageSpendRow>();
  return projectRows(env, results);
}

/** One minute-cron recovery pass, bounded for D1 and Durable Object fanout. */
export async function recoverPendingUsageSpend(
  env: Env,
  limit: number = USAGE_SPEND_RECOVERY_BATCH,
): Promise<ProjectionResult> {
  const bounded = validLimit(limit, USAGE_SPEND_RECOVERY_BATCH);
  if (bounded === 0) return { attempted: 0, acknowledged: 0, projectedUsers: 0 };
  const { results } = await env.DB.prepare(
    `SELECT id, app_id, scope, user_key, month, microusd, revision
     FROM app_usage_spend WHERE pending = 1
     ORDER BY last_attempt_at, id LIMIT ?`,
  ).bind(bounded).all<UsageSpendRow>();
  return projectRows(env, results);
}

/**
 * Drops only settled projections for whole months beyond raw retention, and
 * only after every raw event that could still be repriced has gone.
 */
export async function pruneSettledUsageSpend(
  env: Env,
  beforeMonth: string,
): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM app_usage_spend WHERE id IN (
       SELECT spend.id FROM app_usage_spend AS spend
       WHERE spend.pending = 0 AND spend.month < ?
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
