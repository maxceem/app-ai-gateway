import type { MiddlewareHandler } from "hono";
import { hasAppLevelLimits } from "../core/config";
import { GatewayError } from "../core/errors";
import { recordBlockedUsageEvent } from "../core/usage";
import type { UserLimiter } from "../do/UserLimiter";
import type { ProxyVariables } from "../routes/proxy";
import type { GatewayVariables } from "./auth";

export const limiterGate: MiddlewareHandler<{
  Bindings: Env;
  Variables: GatewayVariables & ProxyVariables;
}> = async (c, next) => {
  const start = performance.now();
  const app = c.get("appConfig");
  const identity = c.get("identity");
  const provider = c.get("provider");
  const providerSlug = c.get("providerSlug");
  const providerPath = c.get("providerPath");
  const providerId = c.get("resolvedProvider").id;
  const model = c.get("preparedProxyRequest").model;
  const now = Date.now();
  let result: Awaited<ReturnType<UserLimiter["checkAndIncrement"]>>;

  if (hasAppLevelLimits(app)) {
    const appLimiter = c.env.USER_LIMITER.getByName(identity.appId) as DurableObjectStub<UserLimiter>;
    result = await appLimiter.checkAndIncrement({
      now,
      rpm: app.limits.perApp.requestsPerMinute,
      rpd: app.limits.perApp.requestsPerDay,
      monthlyBudgetMicrousd: app.limits.perApp.monthlyBudgetMicrousd,
    });
    if (!result.allowed) {
      const limiterDurationMs = performance.now() - start;
      c.set("limiterDurationMs", limiterDurationMs);
      const status = result.reason === "budget"
        ? "blocked_budget"
        : result.reason === "blocked"
          ? "blocked_user"
          : "blocked_rate";
      c.executionCtx.waitUntil(
        recordBlockedUsageEvent({
          env: c.env,
          appId: identity.appId,
          userId: identity.userId,
          authMethod: identity.authMethod,
          apiKeyId: identity.apiKeyId,
          provider,
          providerId,
          providerSlug,
          model,
          route: `${providerSlug}/${providerPath}`,
          endpointSlug: c.get("endpointSlug") ?? null,
          appVersion: c.req.header("x-app-version") ?? null,
          status,
          latencyMs: Math.round(limiterDurationMs),
        }),
      );
      if (result.reason === "budget") {
        throw new GatewayError(429, "budget_exhausted", "Monthly spending budget is exhausted");
      }
      throw new GatewayError(429, "rate_limited", "Request rate limit exceeded", {
        "Retry-After": String(result.retryAfterSeconds ?? 60),
      });
    }
  }

  const limiter = c.env.USER_LIMITER.getByName(`${identity.appId}:${identity.userId}`) as DurableObjectStub<UserLimiter>;
  result = await limiter.checkAndIncrement({
    now,
    rpm: app.limits.perUser.requestsPerMinute,
    rpd: app.limits.perUser.requestsPerDay,
    monthlyBudgetMicrousd: app.limits.perUser.monthlyBudgetMicrousd,
  });
  const limiterDurationMs = performance.now() - start;
  c.set("limiterDurationMs", limiterDurationMs);
  if (!result.allowed) {
    const status = result.reason === "budget"
      ? "blocked_budget"
      : result.reason === "blocked"
        ? "blocked_user"
        : "blocked_rate";
    c.executionCtx.waitUntil(
      recordBlockedUsageEvent({
        env: c.env,
        appId: identity.appId,
        userId: identity.userId,
        authMethod: identity.authMethod,
        apiKeyId: identity.apiKeyId,
        provider,
        providerId,
        providerSlug,
        model,
        route: `${providerSlug}/${providerPath}`,
        endpointSlug: c.get("endpointSlug") ?? null,
        appVersion: c.req.header("x-app-version") ?? null,
        status,
        latencyMs: Math.round(limiterDurationMs),
      }),
    );
    if (result.reason === "budget") {
      throw new GatewayError(429, "budget_exhausted", "Monthly spending budget is exhausted");
    }
    if (result.reason === "blocked") {
      throw new GatewayError(403, "auth_required", "User is blocked");
    }
    throw new GatewayError(429, "rate_limited", "Request rate limit exceeded", {
      "Retry-After": String(result.retryAfterSeconds ?? 60),
    });
  }
  await next();
};
