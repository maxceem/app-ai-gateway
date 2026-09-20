import type { RegistrationRule, DeploymentPolicy } from "./deployment";
import type { AccountAccessMode } from "./accounts";
import { ACCOUNT_TRIAL_MS, requiresActiveTrial } from "./accounts";
import { sql, type SQL } from "drizzle-orm";
import type { CfAuthTables } from "@maxceem/cf-auth/schema";

export interface SqlCondition {
  sql: string;
  params: unknown[];
}

export function humanOwnerCondition(organizationExpression: string): string {
  return `EXISTS (
    SELECT 1 FROM mgmt_organization_user m JOIN mgmt_user u ON u.id=m.user_id
    WHERE m.organization_id=${organizationExpression} AND m.role='owner' AND u.kind='human'
  )`;
}

export function emptyDeploymentCondition(): string {
  return `NOT EXISTS (SELECT 1 FROM mgmt_organization)
    AND NOT EXISTS (SELECT 1 FROM mgmt_user WHERE kind='human')`;
}

export function registrationCreateCondition(
  rule: RegistrationRule,
  tables: CfAuthTables,
): SQL {
  return sql`
    (
      exists (select 1 from ${tables.user} where ${tables.user.kind} = 'human')
      and ${rule.allowWhenHumanExists ? 1 : 0}
    )
    or (
      not exists (select 1 from ${tables.user} where ${tables.user.kind} = 'human')
      and (
        ${rule.allowWhenNoHumanWithAccount ? 1 : 0}
        or not exists (select 1 from ${tables.organization})
      )
    )
  `;
}

const effectiveNow = "MAX(julianday(?),julianday('now'))";

/**
 * Transactional equivalent of accountAccessDenial. The account id and caller
 * clock are always bound, while SQLite's clock prevents stale callers from
 * extending access.
 */
export function accountAccessCondition(
  policy: DeploymentPolicy,
  organizationId: string,
  accessMode: AccountAccessMode,
  nowMs: number,
): SqlCondition {
  const deadlineChecks = [
    `julianday(o.expires_at)>${effectiveNow}`,
  ];
  const params: unknown[] = [organizationId, new Date(nowMs).toISOString()];
  if (requiresActiveTrial(policy.mode, accessMode)) {
    deadlineChecks.push(
      `(julianday(o.created_at)+(?/86400000.0))>${effectiveNow}`,
    );
    params.push(ACCOUNT_TRIAL_MS, new Date(nowMs).toISOString());
  }
  return {
    sql: `EXISTS (SELECT 1 FROM mgmt_organization o WHERE o.id=? AND (
      ${humanOwnerCondition("o.id")}
      OR o.expires_at IS NULL
      OR (${deadlineChecks.join(" AND ")})
    ))`,
    params,
  };
}

/** Fixed-cutoff cleanup predicate; every statement in a batch binds the same instant. */
export function expiredUnclaimedAccountsCondition(cutoffMs: number): SqlCondition {
  return {
    sql: `o.expires_at IS NOT NULL
      AND julianday(o.expires_at)<=julianday(?)
      AND NOT ${humanOwnerCondition("o.id")}`,
    params: [new Date(cutoffMs).toISOString()],
  };
}
