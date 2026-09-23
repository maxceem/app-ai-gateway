import type { DeploymentMode, RegistrationRule } from "./deployment";
import type { AccountAccessMode } from "./accounts";
import { UNCLAIMED_ACCESS_MS, requiresUnclaimedAccess } from "./accounts";
import { sql, type SQL } from "drizzle-orm";
import type { CfAuthTables } from "@maxceem/cf-auth/schema";

/**
 * A predicate carried into the statement that writes, as SQL plus its bound
 * parameters.
 *
 * One shape for all three of them — an account-lifecycle guard, a plan ceiling
 * and a resource receipt or browser handoff boundary — because every call site
 * interpolates one `sql` into a statement and binds the matching `params`, and
 * they compose with {@link andCondition}.
 */
export interface SqlCondition {
  sql: string;
  params: unknown[];
}

const UNCONDITIONAL: SqlCondition = { sql: "1", params: [] };

/**
 * Joins conditions into one, preserving order.
 *
 * Order is the whole contract: every call site interpolates `sql` at one point
 * in a statement and binds `params` at the matching point, so the parameters of
 * the earlier condition must stay ahead of the later one's.
 */
export function andCondition(
  ...parts: Array<SqlCondition | undefined>
): SqlCondition {
  const present = parts.filter((part): part is SqlCondition => part !== undefined);
  if (present.length === 0) return UNCONDITIONAL;
  if (present.length === 1) return present[0]!;
  return {
    sql: present.map((part) => `(${part.sql})`).join(" AND "),
    params: present.flatMap((part) => part.params),
  };
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
  deploymentMode: DeploymentMode,
  organizationId: string,
  accessMode: AccountAccessMode,
  nowMs: number,
): SqlCondition {
  const deadlineChecks = [
    `julianday(o.expires_at)>${effectiveNow}`,
  ];
  const params: unknown[] = [organizationId, new Date(nowMs).toISOString()];
  if (requiresUnclaimedAccess(deploymentMode, accessMode)) {
    deadlineChecks.push(
      `(julianday(o.created_at)+(?/86400000.0))>${effectiveNow}`,
    );
    params.push(UNCLAIMED_ACCESS_MS, new Date(nowMs).toISOString());
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
