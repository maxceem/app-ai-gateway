import { RpcTarget } from 'cloudflare:workers';
import { GatewayError } from '../core/errors';
import { REALTIME_BACKEND_CONTRACT as V, type SessionBackend } from './backend';
import type { BackendResult, RealtimeBackend } from './rpc';
import type { QuotaAdmissionInput } from '../do/OrgQuota';
import { REALTIME_LIMITS } from './limits';

export function unwrapBackend<T>(result: BackendResult<T>): T {
  if (result.ok) return result.value;
  const e = result.error;
  throw new GatewayError(e.status, e.code, e.message, e.headers, { data: e.data });
}
/** Retry transport failures only. Public policy failures are never retried. */
export async function safeBackendCall<T>(call: () => Promise<BackendResult<T>>, deadline = Date.now() + REALTIME_LIMITS.setupMs): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let response: BackendResult<T>;
    try { response = await call(); }
    catch (error) {
      const transient = error instanceof Error && ('retryable' in error && error.retryable === true || 'overloaded' in error && error.overloaded === true);
      if (!transient || attempt >= 2 || Date.now() + 100 * (attempt + 1) >= deadline) throw new GatewayError(503, 'provider_unavailable', 'Realtime backend unavailable');
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      continue;
    }
    return unwrapBackend(response);
  }
}
class DurableClaimAcknowledgement extends RpcTarget {
  constructor(private beforeClaim: (claim: QuotaAdmissionInput | null) => void | Promise<void>, private live: () => boolean) { super(); }
  async acknowledge(claim: QuotaAdmissionInput | null) {
    if (!this.live()) throw new Error('Realtime session ended');
    await this.beforeClaim(claim);
    if (!this.live()) throw new Error('Realtime session ended');
  }
}
export function remoteSessionBackend(rpc: Service<typeof RealtimeBackend>): SessionBackend {
  return {
    revalidate: (b, headers) => safeBackendCall(() => rpc.revalidate(V, b, headers)),
    capacity: (b, scope, operation, cap) => safeBackendCall(() => rpc.capacity(V, b, scope, operation, cap)),
    async admit(b, app, attribution, generationId, now, beforeClaim, live) {
      // Never retry admission: an ambiguous reply is reconciled through the journal's receipt.
      const acknowledgement = new DurableClaimAcknowledgement(beforeClaim, live);
      unwrapBackend(await rpc.admit(V, b, app, attribution, generationId, now, acknowledgement));
    },
    receipt: (b, id) => safeBackendCall(() => rpc.receipt(V, b, id)),
    persist: event => safeBackendCall(() => rpc.persist(V, event)),
    maintain: (b, app, active) => safeBackendCall(() => rpc.maintain(V, b, app, active)),
  };
}
