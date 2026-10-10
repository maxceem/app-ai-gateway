import type { Handler } from 'hono';
import type { ServedVariables } from '../execution/serve';
import { authenticatedAccess } from '../execution/authenticated-access';
import { requireProvider } from '../providers/provider-store';
import { GatewayError } from '../core/errors';
import { enforceEndpointRateLimit } from '../core/endpoint-rate-limit';
import { billingQuota } from '../billing/quota';
import { requireActiveBilling } from '../billing/gateway';
import { realtimePolicy } from './policy';
import type { Bootstrap } from './types';
import { activeRealtimeRelease } from './releases';
import { resolveDeployment } from '../policy/deployment';

export async function prepareRealtime(env: Env, request: Request, appId: string, providerSlug: string, origin: string, action: 'realtime_connect' | 'realtime_discover' = 'realtime_connect'): Promise<{ bootstrap: Bootstrap; headers: Headers }> {
  const url = new URL(request.url);
  const params = [...url.searchParams.keys()];
  const model = url.searchParams.get('model');
  if (!model || model.length > 200 || params.length !== 1 || params[0] !== 'model') throw new GatewayError(400, 'invalid_request', 'Specify exactly one model query parameter');
  if (!/^Bearer \S+$/iu.test(request.headers.get('authorization') ?? '')) throw new GatewayError(401, 'auth_required', 'Authorization: Bearer is required');
  const { app, identity } = await authenticatedAccess({ env: env, deployment: resolveDeployment(env, origin), appId, headers: request.headers, providerSlug });
  await enforceEndpointRateLimit(env, action, JSON.stringify([app.id, identity.userId ?? ['key', identity.apiKeyId]]));
  const provider = await requireProvider(env, app.organizationId, providerSlug);
  const policy = realtimePolicy(app, provider, model);
  const quota = await billingQuota(resolveDeployment(env, origin), env, app.organizationId, new Map());
  requireActiveBilling(quota.access);
  if (quota.kind === 'metered' && await env.ORG_QUOTA.getByName(app.organizationId).usage(quota.period.periodId) >= quota.limit) {
    throw new GatewayError(429, 'billing_request_quota_exceeded', 'Request allowance exhausted');
  }
  const bootstrap: Bootstrap = { sessionId: crypto.randomUUID(), appId: app.id, organizationId: app.organizationId,
    providerId: provider.id, providerSlug, model: policy.model, requestedModel: model, protocol: policy.protocol,
    identity, appVersion: request.headers.get('x-app-version') ?? null, origin };
  // Fresh headers: client internal metadata, cookies and provider control headers never enter the DO.
  const headers = new Headers({ Upgrade: 'websocket', 'x-realtime-bootstrap': JSON.stringify(bootstrap), Authorization: request.headers.get('authorization')! });
  const endUser = app.config.authentication.end_user;
  if (endUser.source === 'header' && endUser.header.toLowerCase() === 'x-realtime-bootstrap') {
    throw new GatewayError(400, 'realtime_not_supported', 'Realtime requires a different end-user header');
  }
  if (endUser.source === 'header') headers.set(endUser.header, request.headers.get(endUser.header)!);
  if (bootstrap.appVersion) headers.set('x-app-version', bootstrap.appVersion);
  return { bootstrap, headers };
}

function localOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
}
/** The stable gateway never transports production sockets. */
export const serveRealtime: Handler<{ Bindings: Env; Variables: ServedVariables }> = async c => {
  if (c.req.method !== 'GET' || c.req.header('upgrade')?.toLowerCase() !== 'websocket') throw new GatewayError(426, 'upgrade_required', 'Discover the realtime URL before opening a WebSocket', { Upgrade: 'websocket' });
  if (!c.env.GATEWAY_BUILD_ID && localOrigin(c.req.url)) {
    const { bootstrap, headers } = await prepareRealtime(c.env, c.req.raw, c.req.param('app')!, c.req.param('provider')!, new URL(c.req.url).origin);
    return c.env.REALTIME_SESSION.get(c.env.REALTIME_SESSION.newUniqueId()).fetch(new Request('https://realtime.internal/', { headers: { ...Object.fromEntries(headers), 'x-realtime-bootstrap': JSON.stringify(bootstrap) } }));
  }
  throw new GatewayError(409, 'conflict', 'Discover the realtime URL before opening a WebSocket');
};
export const discoverRealtime: Handler<{ Bindings: Env; Variables: ServedVariables }> = async c => {
  const { bootstrap } = await prepareRealtime(c.env, c.req.raw, c.req.param('app')!, c.req.param('provider')!, new URL(c.req.url).origin, 'realtime_discover');
  const local = !c.env.GATEWAY_BUILD_ID && localOrigin(c.req.url);
  const release = local ? { id: 'local', url: new URL(c.req.url).origin.replace(/^http/u, 'ws') } : await activeRealtimeRelease(c.env.DB);
  const url = new URL(release.url);
  url.pathname = `/v1/apps/${encodeURIComponent(bootstrap.appId)}/realtime/${encodeURIComponent(bootstrap.providerSlug)}`;
  url.search = new URLSearchParams({ model: bootstrap.requestedModel }).toString();
  c.header('Cache-Control', 'no-store');
  return c.json({ url: url.toString(), releaseId: release.id });
};
