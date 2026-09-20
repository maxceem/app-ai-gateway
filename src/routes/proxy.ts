import { Hono, type MiddlewareHandler } from "hono";
import { GatewayError } from "../core/errors";
import { requireProvider } from "../core/provider-store";
import { PROVIDER_SLUG_PATTERN } from "../core/providers";
import {
  prepareProxyRequest,
} from "../core/proxyrules";
import {
  preparedExecutionAttempt,
  type ExecutionPlan,
  type ExecutionVariables,
} from "../execution/plan";
import type { GatewayVariables } from "../middleware/auth";
import { executionHandler } from "./execution";

type ProxyEnv = { Bindings: Env; Variables: GatewayVariables & ExecutionVariables };

export const proxyPrepare: MiddlewareHandler<ProxyEnv> = async (c, next) => {
  const identity = c.get("identity");
  if (identity.credentialType === "gateway_token" && !c.req.header("x-app-version")) {
    throw new GatewayError(400, "invalid_request", "X-App-Version header is required");
  }
  const providerSlug = c.req.param("provider") ?? "";
  if (!PROVIDER_SLUG_PATTERN.test(providerSlug)) {
    throw new GatewayError(403, "path_not_allowed", "Provider slug is invalid");
  }
  const marker = `/proxy/${providerSlug}/`;
  const markerIndex = c.req.path.indexOf(marker);
  const providerPath = markerIndex === -1 ? undefined : c.req.path.slice(markerIndex + marker.length);
  if (!providerPath) throw new GatewayError(403, "path_not_allowed", "Provider path is required");
  const app = c.get("appConfig");
  const resolved = await requireProvider(c.env, app.organizationId, providerSlug);
  const provider = resolved.type;
  const preparedProxyRequest = await prepareProxyRequest({
    request: c.req.raw,
    app,
    userId: identity.userId,
    provider,
    providerSlug,
    providerPath,
    route: resolved.gateway?.type ?? "direct",
    gatewayRoute: resolved.gatewayRoute,
    tokenHeader: c.get("authHeaderName"),
    pricing: resolved.pricing,
  });
  c.set("executionPlan", {
    method: c.req.method,
    endpointSlug: null,
    attempts: [preparedExecutionAttempt(resolved, preparedProxyRequest)],
  } satisfies ExecutionPlan);
  await next();
};

export const proxyRoutes = new Hono<ProxyEnv>();

proxyRoutes.all("/:provider/*", executionHandler);
