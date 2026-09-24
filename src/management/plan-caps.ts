import { sql, type SQL } from "drizzle-orm";
import {
  billingPlanLimits,
  getBillingAccess,
  type PlanLimits,
} from "../billing/gateway";
import { GatewayError } from "../core/errors";
import { prepared } from "../db/sql";
import type { ManagementScope } from "./scope";

/**
 * The resources a plan can put a ceiling on, and how each one is counted.
 *
 * `count` counts within one scope: the organization for everything it owns
 * directly, the application for its keys. `subject` names the thing in the
 * refusal, and is plural because a ceiling is always a count.
 */
const CAPPED_RESOURCES = {
  app: {
    limit: "maxApps",
    count: (scopeId) => sql`SELECT COUNT(*) FROM app WHERE organization_id = ${scopeId}`,
    subject: "applications",
  },
  provider: {
    limit: "maxProviders",
    count: (scopeId) => sql`SELECT COUNT(*) FROM provider WHERE organization_id = ${scopeId}`,
    subject: "providers",
  },
  providerGateway: {
    limit: "maxProviderGateways",
    count: (scopeId) => sql`SELECT COUNT(*) FROM provider_gateway WHERE organization_id = ${scopeId}`,
    subject: "provider gateways",
  },
  // Revoking is the only status transition a key has, so counting at insert
  // time is complete: nothing ever moves back into `active`.
  appKey: {
    limit: "maxActiveKeysPerApp",
    count: (scopeId) =>
      sql`SELECT COUNT(*) FROM app_api_key WHERE app_id = ${scopeId} AND status = 'active'`,
    subject: "active API keys per application",
  },
} as const satisfies Record<
  string,
  { limit: keyof PlanLimits; count: (scopeId: string) => SQL; subject: string }
>;

export type CappedResource = keyof typeof CAPPED_RESOURCES;

export interface PlanCap {
  /**
   * ANDs into the WHERE of the statement that inserts, so the count and the
   * write are one statement and a concurrent create cannot slip between them.
   * Absent when the plan sets no ceiling on this resource.
   */
  condition: SQL | undefined;
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
  condition: undefined,
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
    condition: sql`(${capped.count(scopeId)}) < ${limit}`,
    async assertNotReached(): Promise<void> {
      const used = (await prepared(scope.env.DB, sql`SELECT (${capped.count(scopeId)}) AS used`)
        .first<number>("used")) ?? 0;
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
