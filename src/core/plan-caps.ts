import {
  billingPlanLimits,
  getBillingAccess,
  type BillingRequestCache,
  type PlanLimits,
} from "../billing/gateway";
import { GatewayError } from "./errors";

/**
 * A predicate carried into the statement that writes, as SQL plus its bound
 * parameters. The same shape a resource receipt and a browser handoff boundary
 * already use, so a cap composes with whichever of those is in play.
 */
export interface WriteCondition {
  sql: string;
  params: unknown[];
}

const UNCONDITIONAL: WriteCondition = { sql: "1", params: [] };

/**
 * Joins conditions into one, preserving order.
 *
 * Order is the whole contract: every call site interpolates `sql` at one point
 * in a statement and binds `params` at the matching point, so the parameters of
 * the earlier condition must stay ahead of the later one's.
 */
export function andCondition(
  ...parts: Array<WriteCondition | undefined>
): WriteCondition {
  const present = parts.filter((part): part is WriteCondition => part !== undefined);
  if (present.length === 0) return UNCONDITIONAL;
  if (present.length === 1) return present[0]!;
  return {
    sql: present.map((part) => `(${part.sql})`).join(" AND "),
    params: present.flatMap((part) => part.params),
  };
}

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
  condition: WriteCondition;
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
  env: Env,
  resource: CappedResource,
  organizationId: string,
  cache?: BillingRequestCache,
  scopeId: string = organizationId,
): Promise<PlanCap> {
  const capped = CAPPED_RESOURCES[resource];
  const limit = billingPlanLimits(
    await getBillingAccess(env, organizationId, cache),
  )[capped.limit];
  if (limit === undefined) return UNCAPPED;
  return {
    condition: {
      sql: `(SELECT COUNT(*) FROM ${capped.from}) < ?`,
      params: [scopeId, limit],
    },
    async assertNotReached(): Promise<void> {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS used FROM ${capped.from}`)
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
