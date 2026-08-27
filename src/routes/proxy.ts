import { Hono, type MiddlewareHandler } from "hono";
import { hasAppLevelLimits } from "../core/config";
import { GatewayError } from "../core/errors";
import { requireProvider, type ResolvedProvider } from "../core/provider-store";
import { isProviderType } from "../core/providers";
import {
  prepareProxyRequest,
  providerUpstream,
  type PreparedProxyRequest,
} from "../core/proxyrules";
import type { ProviderType } from "../core/types";
import { recordUsageEvent } from "../core/usage";
import type { GatewayVariables } from "../middleware/auth";

export interface ProxyVariables {
  provider: ProviderType;
  providerPath: string;
  preparedProxyRequest: PreparedProxyRequest;
  /** The organization's credential for the requested provider type. */
  resolvedProvider: ResolvedProvider;
  /** Named endpoint routes set this; passthrough proxy traffic leaves it unset. */
  endpointSlug?: string;
  /** Fallback targets may span providers, so each attempt resolves its own row. */
  resolvedProviders?: Map<ProviderType, ResolvedProvider>;
}

type ProxyEnv = { Bindings: Env; Variables: GatewayVariables & ProxyVariables };

export const proxyPrepare: MiddlewareHandler<ProxyEnv> = async (c, next) => {
  const identity = c.get("identity");
  if (identity.credentialType === "gateway_token" && !c.req.header("x-app-version")) {
    throw new GatewayError(400, "invalid_request", "X-App-Version header is required");
  }
  const providerValue = c.req.param("provider");
  if (!isProviderType(providerValue)) {
    throw new GatewayError(403, "path_not_allowed", "Provider is not supported");
  }
  const provider = providerValue;
  const marker = `/proxy/${provider}/`;
  const markerIndex = c.req.path.indexOf(marker);
  const providerPath = markerIndex === -1 ? undefined : c.req.path.slice(markerIndex + marker.length);
  if (!providerPath) throw new GatewayError(403, "path_not_allowed", "Provider path is required");
  const app = c.get("appConfig");
  const resolved = await requireProvider(c.env, app.organizationId, provider);
  const preparedProxyRequest = await prepareProxyRequest({
    request: c.req.raw,
    app,
    userId: identity.userId,
    provider,
    providerPath,
    tokenHeader: c.get("authHeaderName"),
    pricing: resolved.pricing,
  });
  c.set("resolvedProvider", resolved);
  c.set("provider", provider);
  c.set("providerPath", providerPath);
  c.set("preparedProxyRequest", preparedProxyRequest);
  await next();
};

export const proxyRoutes = new Hono<ProxyEnv>();

proxyRoutes.all("/:provider/*", async (c) => {
  const identity = c.get("identity");
  const app = c.get("appConfig");
  const provider = c.get("provider");
  const providerPath = c.get("providerPath");
  const prepared = c.get("preparedProxyRequest");
  const resolved = c.get("resolvedProvider");
  const upstreamRequest = providerUpstream({
    resolved,
    prepared,
    appId: app.id,
    userId: identity.userId,
  });
  const providerStart = performance.now();
  let upstream: Response;
  try {
    upstream = await fetch(upstreamRequest.url, {
      method: c.req.method,
      headers: upstreamRequest.headers,
      body: prepared.body,
      redirect: "manual",
    });
  } catch {
    const latencyMs = Math.round(performance.now() - providerStart);
    c.executionCtx.waitUntil(
      recordUsageEvent({
        env: c.env,
        stream: null,
        contentType: "",
        appId: app.id,
        userId: identity.userId,
        authMethod: identity.authMethod,
        apiKeyId: identity.apiKeyId,
        appLevelLimitsEnabled: hasAppLevelLimits(app),
        provider,
        providerId: resolved.id,
        pricing: resolved.pricing,
        model: prepared.model,
        route: `${provider}/${providerPath}`,
        appVersion: c.req.header("x-app-version") ?? null,
        status: "provider_error",
        latencyMs,
      }),
    );
    throw new GatewayError(502, "provider_error", "Provider request failed");
  }
  const providerTtfb = performance.now() - providerStart;
  const headers = new Headers(upstream.headers);
  for (const name of ["content-length", "content-encoding", "transfer-encoding"]) {
    headers.delete(name);
  }
  headers.set(
    "Server-Timing",
    `auth;dur=${c.get("authDurationMs").toFixed(1)}, limiter;dur=${c.get("limiterDurationMs").toFixed(1)}, provider_ttfb;dur=${providerTtfb.toFixed(1)}`,
  );
  const status = upstream.ok ? "ok" : "provider_error";
  let clientStream = upstream.body;
  let observerStream: ReadableStream<Uint8Array> | null = null;
  if (upstream.body) {
    [clientStream, observerStream] = upstream.body.tee();
  }
  c.executionCtx.waitUntil(
    recordUsageEvent({
      env: c.env,
      stream: observerStream,
      contentType: upstream.headers.get("content-type") ?? "",
      appId: app.id,
      userId: identity.userId,
      authMethod: identity.authMethod,
      apiKeyId: identity.apiKeyId,
      appLevelLimitsEnabled: hasAppLevelLimits(app),
      provider,
      providerId: resolved.id,
      pricing: resolved.pricing,
      model: prepared.model,
      route: `${provider}/${providerPath}`,
      appVersion: c.req.header("x-app-version") ?? null,
      status,
      latencyMs: Math.round(providerTtfb),
    }),
  );
  return new Response(clientStream, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
});
