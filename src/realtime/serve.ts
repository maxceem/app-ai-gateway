import type { Handler } from "hono";
import type { ServedVariables } from "../execution/serve";
import { authenticatedAccess } from "../execution/authenticated-access";
import { requireProvider } from "../providers/provider-store";
import { GatewayError } from "../core/errors";
import { enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import { billingQuota } from "../billing/quota";
import { requireActiveBilling } from "../billing/gateway";
import { realtimePolicy } from "./policy";
import type { Bootstrap } from "./types";
import { activeRealtimeRelease, seamlessReleases } from "./releases";
import { resolveDeployment } from "../policy/deployment";
import { recordRejectionEvent } from "../diagnostics/rejection-events";
import type { GatewayIdentity } from "../core/types";
import { realtimeCaller } from "./caller";
import { storedAppVersion } from "../core/app-version";

/** A handshake is a `GET`: there is no body for its App Attest proof to sign. */
const NO_BODY = async () => new Uint8Array();

/**
 * Spends the handshake's App Attest assertion counter, as every signed request
 * spends its own, so a discovery or handshake proof captured off the wire is
 * refused the second time rather than opening another session.
 */
async function spendAssertionCounter(
  env: Env,
  identity: GatewayIdentity,
  counter: number | null,
  providerSlug: string,
  model: string,
  appVersion: string | null,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<void> {
  if (counter === null || identity.authMethod !== "attest") return;
  const start = Date.now();
  const { accepted } = await env.USER_LIMITER.getByName(realtimeCaller(identity)).advanceCounter(counter);
  if (accepted) return;
  // Sampled exactly as admission samples a replayed proxy request.
  waitUntil(
    recordRejectionEvent({
      env,
      identity,
      attribution: { providerSlug, model, route: `${providerSlug}/realtime` },
      endpointSlug: null,
      appVersion,
      reason: "blocked_replay",
      scope: "install",
      latencyMs: Date.now() - start,
    }),
  );
  throw new GatewayError(403, "attest_failed", "App Attest assertion counter was replayed");
}

export async function prepareRealtime(
  env: Env,
  request: Request,
  appId: string,
  providerSlug: string,
  origin: string,
  action: "realtime_connect" | "realtime_discover" = "realtime_connect",
  waitUntil: (promise: Promise<unknown>) => void = promise => {
    void promise.catch(() => {});
  },
): Promise<{ bootstrap: Bootstrap; headers: Headers }> {
  const url = new URL(request.url);
  const params = [...url.searchParams.keys()];
  const model = url.searchParams.get("model");
  const onlyModel = params.length === 1 && params[0] === "model";
  if (!model || model.length > 200 || !onlyModel) {
    throw new GatewayError(400, "invalid_request", "Specify exactly one model query parameter");
  }
  if (!/^Bearer \S+$/iu.test(request.headers.get("authorization") ?? "")) {
    throw new GatewayError(401, "auth_required", "Authorization: Bearer is required");
  }
  const { app, identity, assertionCounter } = await authenticatedAccess({
    env,
    deployment: resolveDeployment(env, origin),
    appId,
    request,
    body: NO_BODY,
    providerSlug,
  });
  await spendAssertionCounter(
    env,
    identity,
    assertionCounter,
    providerSlug,
    model,
    request.headers.get("x-app-version"),
    waitUntil,
  );
  await enforceEndpointRateLimit(env, action, realtimeCaller(identity));
  const provider = await requireProvider(env, app.organizationId, providerSlug);
  const policy = realtimePolicy(app, provider, model);
  const quota = await billingQuota(resolveDeployment(env, origin), env, app.organizationId, new Map());
  requireActiveBilling(quota.access);
  if (
    quota.kind === "metered"
    && await env.ORG_QUOTA.getByName(app.organizationId).usage(quota.period.periodId) >= quota.limit
  ) {
    throw new GatewayError(429, "billing_request_quota_exceeded", "Request allowance exhausted");
  }
  const bootstrap: Bootstrap = {
    sessionId: crypto.randomUUID(),
    appId: app.id,
    organizationId: app.organizationId,
    providerId: provider.id,
    providerSlug,
    model: policy.model,
    requestedModel: model,
    protocol: policy.protocol,
    identity,
    appVersion: storedAppVersion(request.headers.get("x-app-version")),
    origin,
  };
  // Fresh headers: client internal metadata, cookies and provider control headers never enter the DO.
  const headers = new Headers({
    Upgrade: "websocket",
    "x-realtime-bootstrap": JSON.stringify(bootstrap),
    Authorization: request.headers.get("authorization")!,
  });
  const endUser = app.config.authentication.end_user;
  if (endUser.source === "header" && endUser.header.toLowerCase() === "x-realtime-bootstrap") {
    throw new GatewayError(400, "realtime_not_supported", "Realtime requires a different end-user header");
  }
  if (endUser.source === "header") headers.set(endUser.header, request.headers.get(endUser.header)!);
  if (bootstrap.appVersion) headers.set("x-app-version", bootstrap.appVersion);
  return { bootstrap, headers };
}

function localOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

/**
 * Whether this gateway serves sessions itself: always, unless releases are
 * seamless, and then only in local development, which has no release Worker.
 */
function servesSessions(env: Env, url: string): boolean {
  return !seamlessReleases(env) || (!env.GATEWAY_BUILD_ID && localOrigin(url));
}

/** With seamless releases, the stable gateway never transports production sockets. */
export const serveRealtime: Handler<{ Bindings: Env; Variables: ServedVariables }> = async c => {
  const upgrade = c.req.method === "GET" && c.req.header("upgrade")?.toLowerCase() === "websocket";
  if (!upgrade) {
    throw new GatewayError(
      426,
      "upgrade_required",
      "Discover the realtime URL before opening a WebSocket",
      { Upgrade: "websocket" },
    );
  }
  if (servesSessions(c.env, c.req.url)) {
    const { bootstrap, headers } = await prepareRealtime(
      c.env,
      c.req.raw,
      c.req.param("app")!,
      c.req.param("provider")!,
      new URL(c.req.url).origin,
      "realtime_connect",
      promise => c.executionCtx.waitUntil(promise),
    );
    const session = c.env.REALTIME_SESSION.get(c.env.REALTIME_SESSION.newUniqueId());
    return session.fetch(
      new Request("https://realtime.internal/", {
        headers: { ...Object.fromEntries(headers), "x-realtime-bootstrap": JSON.stringify(bootstrap) },
      }),
    );
  }
  throw new GatewayError(409, "conflict", "Discover the realtime URL before opening a WebSocket");
};

export const discoverRealtime: Handler<{ Bindings: Env; Variables: ServedVariables }> = async c => {
  const { bootstrap } = await prepareRealtime(
    c.env,
    c.req.raw,
    c.req.param("app")!,
    c.req.param("provider")!,
    new URL(c.req.url).origin,
    "realtime_discover",
    promise => c.executionCtx.waitUntil(promise),
  );
  const release = servesSessions(c.env, c.req.url)
    ? { id: c.env.GATEWAY_BUILD_ID ?? "local", url: new URL(c.req.url).origin.replace(/^http/u, "ws") }
    : await activeRealtimeRelease(c.env.DB);
  const url = new URL(release.url);
  const appId = encodeURIComponent(bootstrap.appId);
  const providerSlug = encodeURIComponent(bootstrap.providerSlug);
  url.pathname = `/v1/apps/${appId}/realtime/${providerSlug}`;
  url.search = new URLSearchParams({ model: bootstrap.requestedModel }).toString();
  c.header("Cache-Control", "no-store");
  return c.json({ url: url.toString(), releaseId: release.id });
};
