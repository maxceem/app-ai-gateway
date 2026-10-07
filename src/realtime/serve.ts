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

export const serveRealtime: Handler<{ Bindings: Env; Variables: ServedVariables }> = async c => {
  if (c.req.method !== 'GET' || c.req.header('upgrade')?.toLowerCase() !== 'websocket') throw new GatewayError(426, 'upgrade_required', 'A WebSocket upgrade is required', { Upgrade: 'websocket' });
  const url = new URL(c.req.url);
  const params = [...url.searchParams.keys()];
  const model = url.searchParams.get('model');
  if (!model || model.length > 200 || params.length !== 1 || params[0] !== 'model') throw new GatewayError(400, 'invalid_request', 'Specify exactly one model query parameter');
  if (!/^Bearer \S+$/iu.test(c.req.header('authorization') ?? '')) throw new GatewayError(401, 'auth_required', 'Authorization: Bearer is required');
  const providerSlug = c.req.param('provider') ?? '';
  const { app, identity } = await authenticatedAccess({ env: c.env, deployment: c.get('deployment'), appId: c.req.param('app'), headers: c.req.raw.headers, providerSlug });
  await enforceEndpointRateLimit(c.env, 'realtime_connect', JSON.stringify([app.id, identity.userId ?? ['key', identity.apiKeyId]]));
  const provider = await requireProvider(c.env, app.organizationId, providerSlug);
  const policy = realtimePolicy(app, provider, model);
  const quota = await billingQuota(c.get('deployment'), c.env, app.organizationId, new Map());
  requireActiveBilling(quota.access);
  if (quota.kind === 'metered' && await c.env.ORG_QUOTA.getByName(app.organizationId).usage(quota.period.periodId) >= quota.limit) {
    throw new GatewayError(429, 'billing_request_quota_exceeded', 'Request allowance exhausted');
  }
  const bootstrap: Bootstrap = { sessionId: crypto.randomUUID(), appId: app.id, organizationId: app.organizationId,
    providerId: provider.id, providerSlug, model: policy.model, requestedModel: model, protocol: policy.protocol,
    identity, appVersion: c.req.header('x-app-version') ?? null, origin: url.origin };
  // Fresh headers: client internal metadata, cookies and provider control headers never enter the DO.
  const headers = new Headers({ Upgrade: 'websocket', 'x-realtime-bootstrap': JSON.stringify(bootstrap), Authorization: c.req.header('authorization')! });
  const endUser = app.config.authentication.end_user;
  if (endUser.source === 'header' && endUser.header.toLowerCase() === 'x-realtime-bootstrap') {
    throw new GatewayError(400, 'realtime_not_supported', 'Realtime requires a different end-user header');
  }
  if (endUser.source === 'header') headers.set(endUser.header, c.req.raw.headers.get(endUser.header)!);
  if (bootstrap.appVersion) headers.set('x-app-version', bootstrap.appVersion);
  return c.env.REALTIME_SESSION.get(c.env.REALTIME_SESSION.newUniqueId()).fetch(new Request('https://realtime.internal/', { headers }));
};
