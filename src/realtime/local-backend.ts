import { authenticatedAccess } from '../execution/authenticated-access';
import { admitGeneration } from '../execution/admission';
import { requireProvider } from '../providers/provider-store';
import { cachedAppUserBlocked } from '../client-auth/user-status';
import { resolveDeployment } from '../policy/deployment';
import { billingQuota } from '../billing/quota';
import { requireActiveBilling } from '../billing/gateway';
import { monthlyBudgetMicrousd } from '../shared/app-config';
import { monthlySpendMicrousd, type SpendKey } from '../usage/app-usage-accounting';
import { callerLimiter } from '../execution/admission';
import { realtimeCaller } from './caller';
import { persistUsageEventAcknowledged, markUsageApiKeyUsed } from '../usage/usage-record';
import { GatewayError } from '../core/errors';
import type { SessionBackend } from './backend';
import type { Bootstrap } from './types';

/** The same auth, application limits and account allowance used by HTTP. */
export function localSessionBackend(env: Env, waitUntil: (promise: Promise<unknown>) => void): SessionBackend {
  const limiter = (b: Bootstrap, scope: 'user' | 'app') => env.USER_LIMITER.getByName(scope === 'app' ? b.appId : realtimeCaller(b.identity));
  const backend: SessionBackend = {
    async revalidate(b, headers) {
      // The handshake's proof, if the app asks for one, was verified and its
      // counter spent when the session opened; what can change since is the
      // token, the key behind it and the app, and those are checked again.
      const access = await authenticatedAccess({ env, deployment: resolveDeployment(env, b.origin), appId: b.appId,
        request: new Request(`https://realtime.internal/v1/apps/${encodeURIComponent(b.appId)}/realtime/${encodeURIComponent(b.providerSlug)}`, { headers }),
        body: async () => new Uint8Array(), providerSlug: b.providerSlug, proofVerified: true });
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
        assertionCounter: null, attribution, endpointSlug: null, appVersion: b.appVersion, admissionId: generationId, now, freshSpend: true,
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
      if (active) return;
      // The same budgets admission refuses a generation by, each measured over
      // the month its scope is: the app's, and the caller's install or user.
      const month = new Date().toISOString().slice(0, 7);
      const budgets: { scope: string; budget: number | null; spend: SpendKey }[] = [
        { scope: 'app', budget: monthlyBudgetMicrousd(app.config.limits.per_app), spend: { appId: b.appId, scope: 'app', key: null } },
      ];
      const caller = callerLimiter(app, b.identity, null);
      if (caller) budgets.push({ scope: caller.spend.scope, budget: monthlyBudgetMicrousd(app.config.limits.per_user), spend: caller.spend });
      for (const { scope, budget, spend } of budgets) {
        if (budget !== null && await monthlySpendMicrousd(env.DB, spend, month) >= budget) {
          throw new GatewayError(429, 'app_budget_exhausted', `The application's monthly ${scope} spending budget is exhausted`, undefined, { data: { scope } });
        }
      }
    },
  };
  return backend;
}
