import {
  billingPlanLimits,
  getBillingAccess,
  type PlanLimits,
} from "../billing/gateway";
import { GatewayError } from "../core/errors";
import type { SqlCondition } from "../policy/sql";
import type { ManagementScope } from "./scope";

const UNCONDITIONAL: SqlCondition = { sql: "1", params: [] };

/**
 * The resources a plan can put a ceiling on, and how each one is counted.
 *
 * `from` carries the count's own `WHERE`, whose single parameter is the scope
 * being counted within: the organization for everything it owns directly, the
 * application for its keys. `subject` names the thing in the refusal, and is
 * plural because a ceiling is always a count.
 */
const CAPPED_RESOURCES = {
  app: {
    limit: "maxApps",
    from: "app WHERE organization_id = ?",
    subject: "applications",
  },
  provider: {
    limit: "maxProviders",
    from: "provider WHERE organization_id = ?",
    subject: "providers",
  },
  providerGateway: {
    limit: "maxProviderGateways",
    from: "provider_gateway WHERE organization_id = ?",
    subject: "provider gateways",
  },
  // Revoking is the only status transition a key has, so counting at insert
  // time is complete: nothing ever moves back into `active`.
  appKey: {
    limit: "maxActiveKeysPerApp",
    from: "app_api_key WHERE app_id = ? AND status = 'active'",
    subject: "active API keys per application",
  },
} as const satisfies Record<string, { limit: keyof PlanLimits; from: string; subject: string }>;

export type CappedResource = keyof typeof CAPPED_RESOURCES;

export interface PlanCap {
  /**
   * ANDs into the WHERE of the statement that inserts, so the count and the
   * write are one statement and a concurrent create cannot slip between them.
   * Unconditional when the plan sets no ceiling on this resource.
   */
  condition: SqlCondition;
  /**
   * Explains a write that changed nothing.
   *
   * The guard above refuses silently — it can only make the insert match no
   * rows — and a caller that wrote nothing cannot tell a reached ceiling from
   * the concurrent change every one of these statements is also guarding
   * against. Counting again on that path alone costs a read only where the
   * write already failed, and throws if the cap is what stopped it.
   */
  assertNotReached(): Promise<void>;
}

const UNCAPPED: PlanCap = {
  condition: UNCONDITIONAL,
  assertNotReached: () => Promise.resolve(),
};

/**
 * Resolves the organization's plan ceiling on one resource.
 *
 * The number comes from the plan and from nowhere else: a plan that omits the
 * key leaves the resource unlimited, and a deployment with no billing service
 * leaves every resource unlimited. Nothing here depends on which plan an
 * organization holds or on how it came by it.
 *
 * `scopeId` is what the count is taken over — the organization for everything
 * it owns directly, the application for `appKey` — and defaults to the
 * organization whose plan is being read.
 */
export async function planCap(
  scope: ManagementScope,
  resource: CappedResource,
  organizationId: string,
  scopeId: string = organizationId,
): Promise<PlanCap> {
  const capped = CAPPED_RESOURCES[resource];
  const limit = billingPlanLimits(
    await getBillingAccess(scope.deployment, organizationId, scope.billingCache),
  )[capped.limit];
  if (limit === undefined) return UNCAPPED;
  return {
    condition: {
      sql: `(SELECT COUNT(*) FROM ${capped.from}) < ?`,
      params: [scopeId, limit],
    },
    async assertNotReached(): Promise<void> {
      const row = await scope.env.DB.prepare(`SELECT COUNT(*) AS used FROM ${capped.from}`)
        .bind(scopeId)
        .first<{ used: number }>();
      const used = row?.used ?? 0;
      if (used < limit) return;
      throw new GatewayError(
        409,
        "billing_plan_limit_reached",
        `This plan allows at most ${limit} ${capped.subject}`,
        undefined,
        { data: { limit, used } },
      );
    },
  };
}
