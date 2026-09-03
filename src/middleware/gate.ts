import type { MiddlewareHandler } from "hono";
import {
  billingBinding,
  billingPlanLimits,
  getBillingAccess,
  requireActiveBilling,
  type BillingVariables,
} from "../billing/gateway";
import { GatewayError } from "../core/errors";
import { recordBlockedUsageEvent } from "../core/usage";
import type { ProxyVariables } from "../routes/proxy";
import type { GatewayVariables } from "./auth";

/**
 * The dispatch boundary.
 *
 * Everything that could still refuse this request has already run: the token was
 * verified, the entitlement checked, the provider row resolved, the path and
 * model validated, the body prepared. The next thing that happens is a call to a
 * provider, so this is the one place where "a request was made" is true, and the
 * only place the organization's monthly allowance is spent.
 *
 * It runs once per incoming gateway request. A named endpoint that falls back
 * across several providers, or an upstream that fails after being dispatched to,
 * has already been counted here and is never counted again.
 */

async function monthlyRequestAllowance(
  env: Env,
  organizationId: string,
  cache: BillingVariables["billingRequestCache"],
): Promise<number | undefined> {
  // No billing service means self-hosted, which is unlimited and must never
  // depend on a hosted plan lookup that cannot happen.
  if (!billingBinding(env)) return undefined;
  const access = requireActiveBilling(await getBillingAccess(env, organizationId, cache));
  return billingPlanLimits(access).maxRequestsPerMonth;
}

export const quotaGate: MiddlewareHandler<{
  Bindings: Env;
  Variables: GatewayVariables & ProxyVariables & BillingVariables;
}> = async (c, next) => {
  const start = performance.now();
  const app = c.get("appConfig");
  const identity = c.get("identity");

  const blockedEvent = (status: "blocked_user" | "blocked_rate", latencyMs: number) =>
    c.executionCtx.waitUntil(
      recordBlockedUsageEvent({
        env: c.env,
        appId: identity.appId,
        userId: identity.userId,
        authMethod: identity.authMethod,
        apiKeyId: identity.apiKeyId,
        provider: c.get("provider"),
        providerId: c.get("resolvedProvider").id,
        providerSlug: c.get("providerSlug"),
        model: c.get("preparedProxyRequest").model,
        route: `${c.get("providerSlug")}/${c.get("providerPath")}`,
        endpointSlug: c.get("endpointSlug") ?? null,
        appVersion: c.req.header("x-app-version") ?? null,
        status,
        latencyMs: Math.round(latencyMs),
      }),
    );

  const limiter = c.env.USER_LIMITER.getByName(`${identity.appId}:${identity.userId}`);
  if (await limiter.isBlocked()) {
    const durationMs = performance.now() - start;
    c.set("limiterDurationMs", durationMs);
    blockedEvent("blocked_user", durationMs);
    throw new GatewayError(403, "auth_required", "User is blocked");
  }

  const limit = await monthlyRequestAllowance(
    c.env,
    app.organizationId,
    c.get("billingRequestCache"),
  );
  if (limit === undefined) {
    // Unlimited: no coordination object is touched at all, so a self-hosted
    // deployment pays nothing for a quota it does not have.
    c.set("limiterDurationMs", performance.now() - start);
    await next();
    return;
  }

  const quota = c.env.ORG_QUOTA.getByName(app.organizationId);
  const admission = await quota.admit({ now: Date.now(), limit });
  const durationMs = performance.now() - start;
  c.set("limiterDurationMs", durationMs);
  if (!admission.allowed) {
    blockedEvent("blocked_rate", durationMs);
    throw new GatewayError(
      429,
      "monthly_request_quota_exceeded",
      `The organization's monthly request allowance of ${admission.limit} is exhausted until ${admission.resetAt}`,
      { "Retry-After": String(admission.retryAfterSeconds) },
      {
        data: {
          limit: admission.limit,
          used: admission.used,
          resetAt: admission.resetAt,
        },
      },
    );
  }
  await next();
};
