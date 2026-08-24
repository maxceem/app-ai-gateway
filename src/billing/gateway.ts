import {
  billingErrorCodeOf,
  type BillingAccess,
  type BillingRuntime,
} from "cf-billing";
import { GatewayError } from "../core/errors";

export const BILLING_SERVICE_ID = "ai-gateway";

export interface BillingPlanLimits {
  maxApps?: number;
  maxRpm?: number;
  maxRpd?: number;
  maxMonthlyUsd?: number;
}

export type GatewayBillingAccess =
  | (BillingAccess & { selfHosted?: false })
  | { status: "active"; selfHosted: true }
  | {
      status: "inactive";
      reason: "billing_unavailable";
      selfHosted: false;
      billingErrorCode?: string;
    };

export type BillingRequestCache = Map<string, Promise<GatewayBillingAccess>>;

export interface BillingVariables {
  billingRequestCache: BillingRequestCache;
}

/** Structural RPC stub shape; avoids coupling the OSS gateway to the worker class. */
export type BillingBinding = BillingRuntime;
export interface BillingEnv {
  BILLING?: BillingBinding;
}

export function billingBinding(env: BillingEnv): BillingBinding | undefined {
  return env.BILLING;
}

async function loadBillingAccess(env: BillingEnv, organizationId: string): Promise<GatewayBillingAccess> {
  const binding = billingBinding(env);
  if (!binding) return { status: "active", selfHosted: true };

  try {
    return await binding.getTenantAccess({
      serviceId: BILLING_SERVICE_ID,
      tenantId: organizationId,
    });
  } catch (error) {
    const code = billingErrorCodeOf(error);
    console.error(JSON.stringify({
      message: "billing access RPC failed",
      serviceId: BILLING_SERVICE_ID,
      organizationId,
      billingErrorCode: code,
    }));
    return {
      status: "inactive",
      reason: "billing_unavailable",
      selfHosted: false,
      ...(code ? { billingErrorCode: code } : {}),
    };
  }
}

/**
 * Reads billing access with an optional request-owned cache. Callers in Hono
 * pass `c.get("billingRequestCache")`; omitting it performs one uncached read.
 */
export function getBillingAccess(
  env: BillingEnv,
  organizationId: string,
  cache?: BillingRequestCache,
): Promise<GatewayBillingAccess> {
  if (!cache) return loadBillingAccess(env, organizationId);
  const existing = cache.get(organizationId);
  if (existing) return existing;
  const pending = loadBillingAccess(env, organizationId);
  cache.set(organizationId, pending);
  return pending;
}

export function requireActiveBilling(access: GatewayBillingAccess): GatewayBillingAccess {
  if (access.status === "inactive") {
    throw new GatewayError(
      402,
      "payment_required",
      "An active subscription or trial is required",
    );
  }
  return access;
}

function optionalLimit(
  value: unknown,
  key: keyof BillingPlanLimits,
  integer: boolean,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || (integer && !Number.isInteger(value))
  ) {
    throw new GatewayError(502, "billing_unavailable", `Billing plan limit ${key} is invalid`);
  }
  return value;
}

export function billingPlanLimits(access: GatewayBillingAccess): BillingPlanLimits {
  if (access.status === "inactive" || access.selfHosted || access.limits === undefined) return {};
  if (typeof access.limits !== "object" || access.limits === null || Array.isArray(access.limits)) {
    throw new GatewayError(502, "billing_unavailable", "Billing plan limits are invalid");
  }
  const limits = access.limits as Record<string, unknown>;
  const maxApps = optionalLimit(limits.maxApps, "maxApps", true);
  const maxRpm = optionalLimit(limits.maxRpm, "maxRpm", true);
  const maxRpd = optionalLimit(limits.maxRpd, "maxRpd", true);
  const maxMonthlyUsd = optionalLimit(limits.maxMonthlyUsd, "maxMonthlyUsd", false);
  return {
    ...(maxApps === undefined ? {} : { maxApps }),
    ...(maxRpm === undefined ? {} : { maxRpm }),
    ...(maxRpd === undefined ? {} : { maxRpd }),
    ...(maxMonthlyUsd === undefined ? {} : { maxMonthlyUsd }),
  };
}

export function billingRpcError(error: unknown): GatewayError {
  const code = billingErrorCodeOf(error);
  if (code === "service_not_found" || code === "billing_plan_not_found" || code === "billing_plan_price_not_found") {
    return new GatewayError(404, "billing_not_found", "The requested billing resource was not found");
  }
  if (code === "service_inactive" || code === "billing_manually_managed") {
    return new GatewayError(403, "billing_action_forbidden", "This billing action is not available");
  }
  if (code === "billing_subscription_already_active") {
    return new GatewayError(409, "billing_conflict", "A live subscription already exists");
  }
  return new GatewayError(502, "billing_unavailable", "The billing service is unavailable");
}
