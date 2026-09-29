import type { DeploymentRules, RegistrationRule } from "./deployment";
import type { AccountAccessMode } from "./accounts";
import { UNCLAIMED_ACCESS_MS, requiresUnclaimedAccess } from "./accounts";
import { sql, type SQL } from "drizzle-orm";
import type { CfAuthTables } from "@maxceem/cf-auth/schema";

/**
 * The predicates a guarded write carries into its own statement, as drizzle
 * `sql` templates: every value is bound where it appears, and a condition
 * composes into a statement, or into another condition, by being embedded.
 *
 * Each one a write ANDs into its guard is a single term — an `EXISTS`, a
 * comparison, or a parenthesized conjunction — so it can be ANDed as it is:
 * drizzle's `and()` parenthesizes the conjunction it builds, not its members.
 */

/**
 * Whether the organization `organization` names has a human owner. Takes a
 * column reference, never a value.
 */
export function humanOwnerCondition(organization: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM mgmt_organization_user m JOIN mgmt_user u ON u.id=m.user_id
    WHERE m.organization_id=${organization} AND m.role='owner' AND u.kind='human'
  )`;
}

export function emptyDeploymentCondition(): SQL {
  return sql`(NOT EXISTS (SELECT 1 FROM mgmt_organization)
    AND NOT EXISTS (SELECT 1 FROM mgmt_user WHERE kind='human'))`;
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

/** The caller's clock, never earlier than SQLite's own. */
function effectiveNow(nowMs: number): SQL {
  return sql`MAX(julianday(${new Date(nowMs).toISOString()}),julianday('now'))`;
}

/**
 * Transactional equivalent of accountAccessDenial. The account id and caller
 * clock are always bound, while SQLite's clock prevents stale callers from
 * extending access.
 */
export function accountAccessCondition(
  rules: DeploymentRules,
  organizationId: string,
  accessMode: AccountAccessMode,
  nowMs: number,
): SQL {
  const deadlineChecks = [sql`julianday(o.expires_at)>${effectiveNow(nowMs)}`];
  if (requiresUnclaimedAccess(rules, accessMode)) {
    deadlineChecks.push(
      sql`(julianday(o.created_at)+(${UNCLAIMED_ACCESS_MS}/86400000.0))>${effectiveNow(nowMs)}`,
    );
  }
  return sql`EXISTS (SELECT 1 FROM mgmt_organization o WHERE o.id=${organizationId} AND (
      ${humanOwnerCondition(sql.raw("o.id"))}
      OR o.expires_at IS NULL
      OR (${sql.join(deadlineChecks, sql` AND `)})
    ))`;
}

/**
 * Fixed-cutoff cleanup predicate over `mgmt_organization o`; every statement in
 * a batch binds the same instant.
 */
export function expiredUnclaimedAccountsCondition(cutoffMs: number): SQL {
  return sql`(o.expires_at IS NOT NULL
      AND julianday(o.expires_at)<=julianday(${new Date(cutoffMs).toISOString()})
      AND NOT ${humanOwnerCondition(sql.raw("o.id"))})`;
}
