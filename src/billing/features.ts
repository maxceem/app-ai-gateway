import {
  PLAN_FEATURES,
  type GatewayBillingAccess,
  type PlanFeature,
  type PlanFeatureAccess,
} from "../contracts/billing";
import type { ErrorCode } from "../core/errors";
import { GatewayError } from "../core/errors";
import type { Deployment } from "../policy/deployment";
import {
  billingPlanLimits,
  getBillingAccess,
  requireActiveBilling,
  type BillingRequestCache,
} from "./gateway";

/**
 * Features a plan can include or leave out, and the one question every caller
 * asks about them: does this account's plan include it?
 *
 * Which plan includes a feature is plan data alone — the plan's
 * `limits.includes`, authored in the billing service — and no plan is named
 * here. A plan with no `includes` includes every feature, exactly as a plan
 * with no `maxApps` has no ceiling on apps, and a deployment with no billing
 * service includes every feature without reading anything.
 *
 * Gating a new feature is one entry in `PLAN_FEATURES`, one entry below, and
 * one call to {@link requirePlanFeature} or {@link planIncludes} where the
 * feature is used.
 */

interface FeaturePolicy {
  /** How the feature is named in a refusal, at the start of a sentence. */
  name: string;
  /** The refusal's code. Its own code only where a client already reads one. */
  code: ErrorCode;
  /**
   * Whether the feature stays usable while billing cannot be read. Usually
   * not: admitting it would mean guessing the plan. Human support is the
   * exception, because an outage is when a paying customer most needs it.
   */
  whileBillingUnavailable: boolean;
}

const FEATURE_POLICY = {
  conversationStorage: {
    name: "Conversation history",
    code: "billing_feature_not_included",
    whileBillingUnavailable: false,
  },
  humanSupport: {
    name: "Human support",
    code: "support_plan_required",
    whileBillingUnavailable: true,
  },
} as const satisfies Record<PlanFeature, FeaturePolicy>;

/**
 * Whether the account's plan includes the feature, given its billing access.
 *
 * A malformed `limits` throws `502`, as it does for every other limit: the
 * plan is misconfigured and the gateway will not guess in either direction.
 */
export function planIncludes(access: GatewayBillingAccess, feature: PlanFeature): boolean {
  switch (access.state) {
    case "self_hosted":
      return true;
    case "unavailable":
      return FEATURE_POLICY[feature].whileBillingUnavailable;
    case "billed": {
      if (access.plan === null) return false;
      const includes = billingPlanLimits(access).includes;
      return includes === undefined || includes.includes(feature);
    }
  }
}

/** {@link planIncludes} for every feature, as the billing status reports it. */
export function planFeatures(access: GatewayBillingAccess): PlanFeatureAccess {
  return Object.fromEntries(PLAN_FEATURES.map((feature) => [feature, planIncludes(access, feature)])) as
    PlanFeatureAccess;
}

/**
 * Refuses the call unless the organization's plan includes the feature, and
 * answers with the billing access it read so a caller need not read it again.
 *
 * Billing that cannot be read is refused as `503 billing_unavailable` unless
 * the feature's policy allows it, never as the feature being missing: an
 * outage says nothing about the plan.
 */
export async function requirePlanFeature(
  scope: { deployment: Deployment; billingCache?: BillingRequestCache | undefined },
  organizationId: string,
  feature: PlanFeature,
): Promise<GatewayBillingAccess> {
  const access = await getBillingAccess(scope.deployment, organizationId, scope.billingCache);
  if (planIncludes(access, feature)) return access;
  if (access.state === "unavailable") requireActiveBilling(access);
  const policy = FEATURE_POLICY[feature];
  throw new GatewayError(
    403,
    policy.code,
    `${policy.name} is not included in this account's plan. An account owner can choose a plan that includes it on the Billing page of the console.`,
  );
}
