import type { GatewayIdentity } from '../core/types';

/**
 * The `UserLimiter` object one realtime caller's sessions are held in, and the
 * subject its handshakes are rate limited by: the install for an App Attest
 * app, which owns the install's assertion counter and is what its limits count
 * by; the end user for a server app that names one; the API key otherwise.
 */
export function realtimeCaller(identity: GatewayIdentity): string {
  if (identity.authMethod === 'attest') return `${identity.appId}:install:${identity.installId}`;
  return identity.userId === null ? `${identity.appId}:realtime:key:${identity.apiKeyId}` : `${identity.appId}:${identity.userId}`;
}
