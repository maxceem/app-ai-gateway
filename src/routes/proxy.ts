import { Hono, type MiddlewareHandler } from "hono";
import { hasAppLevelLimits } from "../core/config";
import { GatewayError } from "../core/errors";
import { log } from "../core/log";
import { requireProvider, type ResolvedProvider } from "../core/provider-store";
import { PROVIDER_SLUG_PATTERN } from "../core/providers";
import {
  clientResponseHeaders,
  fetchWithTtfbTimeout,
  prepareProxyRequest,
  providerTtfbTimeoutMs,
  ProviderTtfbTimeoutError,
  providerUpstream,
  type PreparedProxyRequest,
} from "../core/proxyrules";
import type { ProviderType } from "../core/types";
import { observeUpstreamBody, recordUsageEvent, type ObservedBody } from "../core/usage";
import type { GatewayVariables } from "../middleware/auth";

export interface ProxyVariables {
  provider: ProviderType;
  providerSlug: string;
  providerPath: string;
  preparedProxyRequest: PreparedProxyRequest;
  /** The organization's credential for the requested provider type. */
  resolvedProvider: ResolvedProvider;
  /** Named endpoint routes set this; passthrough proxy traffic leaves it unset. */
  endpointSlug?: string;
  /** Fallback targets may span providers, so each attempt resolves its own row. */
  resolvedProviders?: Map<string, ResolvedProvider>;
}

type ProxyEnv = { Bindings: Env; Variables: GatewayVariables & ProxyVariables };

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
  c.set("resolvedProvider", resolved);
  c.set("provider", provider);
  c.set("providerSlug", providerSlug);
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
  const timeoutMs = providerTtfbTimeoutMs(c.env);
  const providerStart = performance.now();
  let upstream: Response;
  try {
    upstream = await fetchWithTtfbTimeout(
      upstreamRequest.url,
      {
        method: c.req.method,
        headers: upstreamRequest.headers,
        body: prepared.body,
        redirect: "manual",
      },
      timeoutMs,
    );
  } catch (error) {
    // A provider that never answers is its own failure: the client is told to
    // expect nothing more from this attempt, rather than waiting it out.
    const timedOut = error instanceof ProviderTtfbTimeoutError;
    if (timedOut) {
      log("warn", "provider_ttfb_timeout", {
        appId: app.id,
        providerSlug: resolved.slug,
        route: `${resolved.slug}/${providerPath}`,
        timeoutMs,
      });
    }
    const latencyMs = timedOut ? timeoutMs : Math.round(performance.now() - providerStart);
    c.executionCtx.waitUntil(
      recordUsageEvent({
        appLevelLimitsEnabled: hasAppLevelLimits(app),
        env: c.env,
        observed: null,
        contentType: "",
        appId: app.id,
        userId: identity.userId,
        authMethod: identity.authMethod,
        apiKeyId: identity.apiKeyId,
        provider,
        providerId: resolved.id,
        providerSlug: resolved.slug,
        gateway: resolved.gateway,
        gatewayRoute: resolved.gatewayRoute,
        pricing: resolved.pricing,
        model: prepared.model,
        route: `${resolved.slug}/${providerPath}`,
        appVersion: c.req.header("x-app-version") ?? null,
        status: "provider_error",
        latencyMs,
      }),
    );
    throw timedOut
      ? new GatewayError(504, "provider_error", "Provider did not respond in time")
      : new GatewayError(502, "provider_error", "Provider request failed");
  }
  const providerTtfb = performance.now() - providerStart;
  const headers = clientResponseHeaders(upstream);
  headers.set(
    "Server-Timing",
    `auth;dur=${c.get("authDurationMs").toFixed(1)}, limiter;dur=${c.get("limiterDurationMs").toFixed(1)}, provider_ttfb;dur=${providerTtfb.toFixed(1)}`,
  );
  const status = upstream.ok ? "ok" : "provider_error";
  let clientStream = upstream.body;
  let observed: Promise<ObservedBody> | null = null;
  if (upstream.body) {
    // The observer rides the client's own stream, so a client that hangs up
    // cancels the provider call instead of leaving it running unwatched.
    ({ stream: clientStream, observed } = observeUpstreamBody(upstream.body));
  }
  c.executionCtx.waitUntil(
    recordUsageEvent({
      appLevelLimitsEnabled: hasAppLevelLimits(app),
      env: c.env,
      observed,
      contentType: upstream.headers.get("content-type") ?? "",
      appId: app.id,
      userId: identity.userId,
      authMethod: identity.authMethod,
      apiKeyId: identity.apiKeyId,
      provider,
      providerId: resolved.id,
      providerSlug: resolved.slug,
      gateway: resolved.gateway,
      gatewayRoute: resolved.gatewayRoute,
      pricing: resolved.pricing,
      model: prepared.model,
      route: `${resolved.slug}/${providerPath}`,
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
