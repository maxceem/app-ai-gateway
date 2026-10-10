import { authenticatedAccess } from '../execution/authenticated-access';
import { admitGeneration } from '../execution/admission';
import { requireProvider } from '../providers/provider-store';
import { cachedAppUserBlocked } from '../client-auth/user-status';
import { resolveDeployment } from '../policy/deployment';
import { billingQuota } from '../billing/quota';
import { requireActiveBilling } from '../billing/gateway';
import { monthlyBudgetMicrousd } from '../shared/app-config';
import { monthlySpendMicrousd } from '../usage/app-usage-accounting';
import { persistUsageEventAcknowledged, markUsageApiKeyUsed } from '../usage/usage-record';
import { GatewayError } from '../core/errors';
import type { SessionBackend } from './backend';
import type { Bootstrap } from './types';

/** The same auth, application limits and account allowance used by HTTP. */
export function localSessionBackend(env: Env, waitUntil: (promise: Promise<unknown>) => void): SessionBackend {
  const limiter = (b: Bootstrap, scope: 'user' | 'app') => env.USER_LIMITER.getByName(scope === 'app' ? b.appId
    : b.identity.userId === null ? `${b.appId}:realtime:key:${b.identity.apiKeyId}` : `${b.appId}:${b.identity.userId}`);
  const backend: SessionBackend = {
    async revalidate(b, headers) {
      const access = await authenticatedAccess({ env, deployment: resolveDeployment(env, b.origin), appId: b.appId, headers, providerSlug: b.providerSlug });
      if (access.app.organizationId !== b.organizationId || JSON.stringify(access.identity) !== JSON.stringify(b.identity)) throw new GatewayError(401, 'auth_required', 'Realtime identity changed');
      if (b.identity.userId !== null && await cachedAppUserBlocked(env.DB, b.appId, b.identity.userId)) throw new GatewayError(403, 'auth_required', 'User is blocked');
      return { app: access.app, provider: await requireProvider(env, b.organizationId, b.providerSlug) };
    },
    async capacity(b, scope, operation, cap) {
      const stub = limiter(b, scope);
      if (operation === 'release') { await stub.releaseSession(b.sessionId); return { allowed: true, expiresAt: 0 }; }
      return operation === 'renew' ? stub.renewSession(b.sessionId) : stub.acquireSession(b.sessionId, cap!);
    },
    async admit(b, app, attribution, generationId, now, beforeClaim, mayContinue) {
      await admitGeneration({ env, deployment: resolveDeployment(env, b.origin), billingCache: new Map(), app, identity: b.identity,
        attribution, endpointSlug: null, appVersion: b.appVersion, admissionId: generationId, now, freshSpend: true,
        beforeClaim, mayContinue, waitUntil });
    },
    async receipt(b, generationId) { return env.ORG_QUOTA.getByName(b.organizationId).receipt(generationId); },
    async persist(event) {
      const result = await persistUsageEventAcknowledged(env, event);
      if (result === 'stored') waitUntil(markUsageApiKeyUsed(env, event));
    },
    async maintain(b, app, active) {
      const quota = await billingQuota(resolveDeployment(env, b.origin), env, b.organizationId, new Map());
      requireActiveBilling(quota.access);
      if (!active && quota.kind === 'metered' && await env.ORG_QUOTA.getByName(b.organizationId).usage(quota.period.periodId) >= quota.limit) {
        throw new GatewayError(429, 'billing_request_quota_exceeded', 'Request allowance exhausted');
      }
      const month = new Date().toISOString().slice(0, 7);
      for (const userKey of [null, b.identity.userId]) {
        const scope = userKey === null ? app.config.limits.per_app : app.config.limits.per_user;
        const budget = monthlyBudgetMicrousd(scope);
        if (!active && budget !== null && await monthlySpendMicrousd(env.DB, { appId: b.appId, userKey }, month) >= budget) {
          throw new GatewayError(429, 'app_budget_exhausted', 'Application spending budget exhausted');
        }
        if (b.identity.userId === null) break;
      }
    },
  };
  return backend;
}
