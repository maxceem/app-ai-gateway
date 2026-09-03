import { Hono, type MiddlewareHandler } from "hono";
import { ENDPOINT_SLUG } from "../core/config";
import {
  endpointAttempt,
  prepareEndpointRequest,
  type PreparedEndpointRequest,
} from "../core/endpointrules";
import { GatewayError } from "../core/errors";
import {
  requireProvider,
  resolveProvider,
  type ResolvedProvider,
} from "../core/provider-store";
import {
  providerUpstream,
  unpricedMessage,
  type PreparedProxyRequest,
} from "../core/proxyrules";
import { supportsEndpointStyle } from "../core/capabilities";
import { lookup } from "../core/records";
import { isBillable, recordUsageEvent } from "../core/usage";
import type { GatewayVariables } from "../middleware/auth";
import type { ProxyVariables } from "./proxy";

export interface EndpointVariables {
  preparedEndpointRequest: PreparedEndpointRequest;
}

type EndpointEnv = {
  Bindings: Env;
  Variables: GatewayVariables & ProxyVariables & EndpointVariables;
};

/** Upstream outcomes worth spending a fallback attempt on. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export const endpointPrepare: MiddlewareHandler<EndpointEnv> = async (c, next) => {
  // Named endpoints are POST-only. Rejecting here keeps other methods from
  // reading a body or reaching the dispatch boundary before the router gives up.
  if (c.req.method !== "POST") {
    throw new GatewayError(404, "invalid_request", "Route not found");
  }
  const identity = c.get("identity");
  if (identity.credentialType === "gateway_token" && !c.req.header("x-app-version")) {
    throw new GatewayError(400, "invalid_request", "X-App-Version header is required");
  }
  const slug = c.req.param("slug") ?? "";
  const app = c.get("appConfig");
  // Own-property lookup only: a path segment must never reach Object.prototype.
  const endpoint = ENDPOINT_SLUG.test(slug) && Object.hasOwn(app.endpoints, slug)
    ? lookup(app.endpoints, slug)
    : undefined;
  if (!endpoint) {
    throw new GatewayError(404, "endpoint_not_found", "Endpoint is not configured for this app");
  }
  const prepared = await prepareEndpointRequest({
    request: c.req.raw,
    app,
    slug,
    endpoint,
    tokenHeader: c.get("authHeaderName"),
  });

  // Every target needs its own credential, because a fallback may point at a
  // different provider. The primary target must work; a fallback the
  // organization has not configured, cannot decrypt, or cannot price is simply
  // dropped from the chain rather than turned into a request that is certain to
  // fail. Resolution itself can throw — an unreadable secret, or a gateway that
  // was revoked out from under the row — and on a fallback that is still just a
  // reason to skip it.
  //
  // A *disabled* primary is the one exception: disabling is a deliberate pause,
  // so the chain falls through to its fallbacks exactly as an upstream failure
  // would. Only when no fallback survives does the pause itself get reported.
  const resolvedProviders = new Map<string, ResolvedProvider>();
  const usableTargets: typeof prepared.targets = [];
  let disabledPrimary: GatewayError | undefined;
  for (const [index, target] of prepared.targets.entries()) {
    const primary = index === 0;
    let entry = resolvedProviders.get(target.provider);
    if (!entry) {
      let found: ResolvedProvider | null;
      try {
        found = primary
          ? await requireProvider(c.env, app.organizationId, target.provider)
          : await resolveProvider(c.env, app.organizationId, target.provider);
      } catch (error) {
        if (primary) {
          if (error instanceof GatewayError && error.code === "provider_disabled") {
            disabledPrimary = error;
            continue;
          }
          throw error;
        }
        continue;
      }
      if (!found) continue;
      entry = found;
      resolvedProviders.set(target.provider, entry);
    }
    const route = entry.gateway?.type ?? "direct";
    if (!supportsEndpointStyle(route, entry.type, endpoint.api_style)) {
      if (primary) {
        throw new GatewayError(
          502,
          "provider_unavailable",
          `Provider instance ${target.provider} does not support ${endpoint.api_style} endpoints`,
        );
      }
      continue;
    }
    if (!isBillable(entry.type, target.model, entry.pricing)) {
      if (primary) {
        throw new GatewayError(
          400,
          "pricing_not_configured",
          unpricedMessage(entry.type, target.model),
        );
      }
      continue;
    }
    usableTargets.push(target);
  }
  prepared.targets = usableTargets;

  // A skipped disabled primary is the only way the chain can end up empty: on
  // every other primary failure the loop threw above. With nothing left to try,
  // the pause is the answer.
  if (usableTargets.length === 0 && disabledPrimary) throw disabledPrimary;

  const primary = prepared.targets[0]!;
  const primaryResolved = resolvedProviders.get(primary.provider)!;
  const attempt = endpointAttempt(
    prepared,
    primary,
    primaryResolved.type,
    primaryResolved.gateway?.type ?? "direct",
    primaryResolved.gatewayRoute,
  );
  c.set("preparedEndpointRequest", prepared);
  c.set("resolvedProviders", resolvedProviders);
  c.set("resolvedProvider", primaryResolved);
  c.set("endpointSlug", slug);
  c.set("provider", attempt.provider);
  c.set("providerSlug", primary.provider);
  c.set("providerPath", attempt.providerPath);
  c.set("preparedProxyRequest", attempt);
  await next();
};

export const endpointRoutes = new Hono<EndpointEnv>();

endpointRoutes.post("/:slug", async (c) => {
  const identity = c.get("identity");
  const app = c.get("appConfig");
  const prepared = c.get("preparedEndpointRequest");
  const slug = prepared.slug;

  const resolvedProviders = c.get("resolvedProviders")!;

  const record = (input: {
    attempt: PreparedProxyRequest;
    resolved: ResolvedProvider;
    stream: ReadableStream<Uint8Array> | null;
    contentType: string;
    status: "ok" | "provider_error";
    latencyMs: number;
  }) =>
    c.executionCtx.waitUntil(
      recordUsageEvent({
        env: c.env,
        stream: input.stream,
        contentType: input.contentType,
        appId: app.id,
        userId: identity.userId,
        authMethod: identity.authMethod,
        apiKeyId: identity.apiKeyId,
        provider: input.attempt.provider,
        providerId: input.resolved.id,
        providerSlug: input.resolved.slug,
        gateway: input.resolved.gateway,
        gatewayRoute: input.resolved.gatewayRoute,
        pricing: input.resolved.pricing,
        model: input.attempt.model,
        route: `${input.resolved.slug}/${input.attempt.providerPath}`,
        endpointSlug: slug,
        appVersion: c.req.header("x-app-version") ?? null,
        status: input.status,
        latencyMs: input.latencyMs,
      }),
    );

  for (const [index, target] of prepared.targets.entries()) {
    const last = index === prepared.targets.length - 1;
    // The first attempt was prepared by the middleware, which is also where the
    // organization's monthly allowance was spent — once, for this incoming
    // request. Falling through the chain below never spends another.
    const resolved = resolvedProviders.get(target.provider)!;
    const attempt = index === 0
      ? c.get("preparedProxyRequest")
      : endpointAttempt(
        prepared,
        target,
        resolved.type,
        resolved.gateway?.type ?? "direct",
        resolved.gatewayRoute,
      );
    const upstreamRequest = providerUpstream({
      resolved,
      prepared: attempt,
      appId: app.id,
      userId: identity.userId,
    });
    const providerStart = performance.now();
    let upstream: Response;
    try {
      upstream = await fetch(upstreamRequest.url, {
        method: "POST",
        headers: upstreamRequest.headers,
        body: attempt.body,
        redirect: "manual",
      });
    } catch {
      record({
        attempt,
        resolved,
        stream: null,
        contentType: "",
        status: "provider_error",
        latencyMs: Math.round(performance.now() - providerStart),
      });
      if (!last) continue;
      throw new GatewayError(502, "provider_error", "Provider request failed");
    }
    const providerTtfb = performance.now() - providerStart;

    // Nothing has been written to the client yet, so a retryable upstream
    // status can still be replaced by the next target in the chain.
    if (!last && isRetryableStatus(upstream.status)) {
      await upstream.body?.cancel();
      record({
        attempt,
        resolved,
        stream: null,
        contentType: "",
        status: "provider_error",
        latencyMs: Math.round(providerTtfb),
      });
      continue;
    }

    const headers = new Headers(upstream.headers);
    for (const name of ["content-length", "content-encoding", "transfer-encoding"]) {
      headers.delete(name);
    }
    headers.set(
      "Server-Timing",
      `auth;dur=${c.get("authDurationMs").toFixed(1)}, limiter;dur=${c.get("limiterDurationMs").toFixed(1)}, provider_ttfb;dur=${providerTtfb.toFixed(1)}`,
    );
    let clientStream = upstream.body;
    let observerStream: ReadableStream<Uint8Array> | null = null;
    if (upstream.body) [clientStream, observerStream] = upstream.body.tee();
    record({
      attempt,
      resolved,
      stream: observerStream,
      contentType: upstream.headers.get("content-type") ?? "",
      status: upstream.ok ? "ok" : "provider_error",
      latencyMs: Math.round(providerTtfb),
    });
    return new Response(clientStream, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  throw new GatewayError(502, "provider_error", "Provider request failed");
});
