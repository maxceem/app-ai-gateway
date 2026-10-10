import { assertAccountAccess } from '../core/account-lifecycle';
import { authenticateRequest } from '../client-auth/client-auth';
import { assertAppActive, loadApp } from '../core/app-records';
import { GatewayError } from '../core/errors';
import { organizationProviders } from '../providers/provider-store';
import type { AppRecord, GatewayIdentity } from '../core/types';
import type { Deployment } from '../policy/deployment';
import type { ServedTimings } from './timing';

export async function authenticatedAccess(input: {
  env: Env; deployment: Deployment; appId?: string; headers: Headers;
  providerSlug?: string; timings?: ServedTimings;
}): Promise<{ app: AppRecord; identity: GatewayIdentity; credentialHeader: string }> {
  const start = performance.now();
  if (!input.appId) throw new GatewayError(400, 'invalid_request', 'App id is required');
  const app = await loadApp(input.env, input.appId);
  const providers = organizationProviders(input.env, app.organizationId);
  providers.catch(() => {});
  if (input.deployment.rules.accountDeadlines) await assertAccountAccess(input.deployment, input.env, app.organizationId, 'proxy');
  assertAppActive(app);
  const { identity, credential } = await authenticateRequest({ ...input, app, providers });
  if (input.timings) input.timings.authMs = performance.now() - start;
  if (identity.credentialType === 'gateway_token' && !input.headers.get('x-app-version')) {
    throw new GatewayError(400, 'invalid_request', 'X-App-Version header is required');
  }
  return { app, identity, credentialHeader: credential.headerName };
}
