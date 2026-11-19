/**
 * The plan ceilings on stored settings: how many apps, provider connections
 * and active app keys an account may have (v1's `plan-caps.ts`, ported).
 *
 * The number comes from the plan and nowhere else. A plan without the key
 * leaves the resource unlimited, and a deployment with no billing service
 * (self-hosted) leaves every resource unlimited.
 *
 * The count and the insert are one SQL statement: the insert's `WHERE` holds
 * the count, so two creates at the same moment cannot both slip under the
 * ceiling. A hosted deployment that cannot read the plan refuses the create
 * (503, or 402 with no plan) instead of guessing "no ceiling": rows created
 * over a ceiling are never removed later.
 */
import {
  BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS,
  billingPlanLimits,
  getBillingAccess,
  requireActiveBilling,
} from "../billing/access.ts";
import type { PlanLimitKey } from "../contracts/billing.ts";
import { GatewayError } from "../core/errors.ts";

const CAPPED = {
  app: {
    limit: "maxApps",
    count: "SELECT COUNT(*) FROM app WHERE account_id = ?",
    subject: "apps",
  },
  provider: {
    limit: "maxProviders",
    count: "SELECT COUNT(*) FROM provider_connection WHERE account_id = ?",
    subject: "provider connections",
  },
  // Revoking is the only change a key's status makes, so nothing moves back
  // into `active` behind this count.
  appKey: {
    limit: "maxActiveKeysPerApp",
    count: "SELECT COUNT(*) FROM app_key WHERE app_id = ? AND status = 'active'",
    subject: "active keys per app",
  },
} as const satisfies Record<string, { limit: PlanLimitKey; count: string; subject: string }>;

export type CappedResource = keyof typeof CAPPED;

export interface PlanCap {
  /** SQL to AND into the insert's `WHERE`, with its values. `1` when there is no ceiling. */
  readonly condition: string;
  readonly binds: readonly unknown[];
  /**
   * Explains an insert that wrote nothing. The guard refuses silently, so a
   * caller cannot tell a reached ceiling from another conflict: this counts
   * again, only on that path, and throws `409 billing_plan_limit_reached` if
   * the ceiling is what stopped it.
   */
  assertNotReached(): Promise<void>;
}

const UNCAPPED: PlanCap = { condition: "1", binds: [], assertNotReached: () => Promise.resolve() };

/**
 * The account's ceiling on one resource. `scopeId` is what the count is taken
 * over: the account for apps and connections, the app for its keys.
 */
export async function planCap(env: Env, db: D1Database, accountId: string, resource: CappedResource, scopeId: string = accountId): Promise<PlanCap> {
  const capped = CAPPED[resource];
  const limit = await planCeiling(env, accountId, resource);
  if (limit === undefined) return UNCAPPED;
  return {
    condition: `(${capped.count}) < ?`,
    binds: [scopeId, limit],
    async assertNotReached() {
      const used = (await db.prepare(`SELECT (${capped.count}) AS used`).bind(scopeId).first<number>("used")) ?? 0;
      if (used < limit) return;
      throw new GatewayError(409, "billing_plan_limit_reached", `This plan allows at most ${limit} ${capped.subject}`, undefined, {
        data: { limit, used },
      });
    },
  };
}

/**
 * The account's ceiling on one resource, or undefined for none. Throws 503
 * when the plan cannot be read, and 402 with no plan.
 */
export async function planCeiling(env: Env, accountId: string, resource: CappedResource): Promise<number | undefined> {
  const capped = CAPPED[resource];
  const access = requireActiveBilling(await getBillingAccess(env, accountId));
  try {
    return billingPlanLimits(access, [capped.limit])[capped.limit];
  } catch (error) {
    // A ceiling the plan data cannot give is a plan that cannot be read:
    // refuse the write as temporary, never guess "no ceiling".
    if (!(error instanceof GatewayError) || error.code !== "billing_unavailable") throw error;
    throw new GatewayError(503, "billing_unavailable", "The plan's limits could not be read, so nothing was saved; retry shortly", {
      "Retry-After": String(BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS),
    });
  }
}
