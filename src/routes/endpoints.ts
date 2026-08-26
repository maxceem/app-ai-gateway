import { Hono, type MiddlewareHandler } from "hono";
import { ENDPOINT_SLUG, hasAppLevelLimits } from "../core/config";
import {
  endpointAttempt,
  prepareEndpointRequest,
  type PreparedEndpointRequest,
} from "../core/endpointrules";
import { GatewayError } from "../core/errors";
import { providerGatewayUrl, type PreparedProxyRequest } from "../core/proxyrules";
import { recordUsageEvent } from "../core/usage";
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
  // reading a body or spending a rate-limit token before the router gives up.
  if (c.req.method !== "POST") {
    throw new GatewayError(404, "invalid_request", "Route not found");
  }
  const identity = c.get("identity");
  if (identity.apiKeyId === undefined && !c.req.header("x-app-version")) {
    throw new GatewayError(400, "invalid_request", "X-App-Version header is required");
  }
  const slug = c.req.param("slug") ?? "";
  const app = c.get("appConfig");
  // Own-property lookup only: a path segment must never reach Object.prototype.
  const endpoint = ENDPOINT_SLUG.test(slug) && Object.hasOwn(app.endpoints, slug)
    ? app.endpoints[slug]
    : undefined;
  if (!endpoint) {
    throw new GatewayError(404, "endpoint_not_found", "Endpoint is not configured for this app");
  }
  const prepared = await prepareEndpointRequest({
    request: c.req.raw,
    app,
    userId: identity.userId,
    slug,
    endpoint,
    tokenHeader: c.get("authHeaderName"),
    cfAigToken: c.env.CF_AIG_TOKEN,
  });
  const attempt = endpointAttempt(prepared, prepared.targets[0]!);
  c.set("preparedEndpointRequest", prepared);
  c.set("endpointSlug", slug);
  c.set("provider", attempt.provider);
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

  const record = (input: {
    attempt: PreparedProxyRequest;
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
        appLevelLimitsEnabled: hasAppLevelLimits(app),
        provider: input.attempt.provider,
        model: input.attempt.model,
        route: `${input.attempt.provider}/${input.attempt.providerPath}`,
        endpointSlug: slug,
        appVersion: c.req.header("x-app-version") ?? null,
        status: input.status,
        latencyMs: input.latencyMs,
      }),
    );

  for (const [index, target] of prepared.targets.entries()) {
    const last = index === prepared.targets.length - 1;
    // The first attempt was prepared by the middleware so the limiter could see
    // its model; later attempts only differ by provider, model, and URL.
    const attempt = index === 0
      ? c.get("preparedProxyRequest")
      : endpointAttempt(prepared, target);
    const providerStart = performance.now();
    let upstream: Response;
    try {
      upstream = await fetch(await providerGatewayUrl(c.env, attempt), {
        method: "POST",
        headers: attempt.headers,
        body: attempt.body,
        redirect: "manual",
      });
    } catch {
      record({
        attempt,
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
