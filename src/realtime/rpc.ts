import { WorkerEntrypoint, RpcTarget } from 'cloudflare:workers';
import { GatewayError, type ErrorCode, type GatewayErrorData } from '../core/errors';
import { localSessionBackend } from './local-backend';
import { prepareRealtime } from './serve';
import { requireRealtimeAdmission } from './releases';
import { REALTIME_BACKEND_CONTRACT } from './backend';
import type { Bootstrap } from './types';
import type { QuotaAdmissionInput } from '../do/OrgQuota';
import type { AttemptAttribution, UsageEvent } from '../usage/usage-record';
import type { AppRecord } from '../core/types';

export type BackendResult<T> = { ok: true; value: T } | { ok: false; error: { status: number; code: ErrorCode; message: string; headers: Record<string, string>; data?: GatewayErrorData } };
export interface ClaimAcknowledgement extends RpcTarget {
  acknowledge(claim: QuotaAdmissionInput | null): Promise<void>;
}
async function result<T>(operation: () => Promise<T>): Promise<BackendResult<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) {
    if (!(error instanceof GatewayError)) {
      const sanitized = new Error('Realtime backend unavailable');
      if (error instanceof Error) for (const flag of ['retryable', 'overloaded'] as const) {
        if (flag in error && Reflect.get(error, flag) === true) Reflect.set(sanitized, flag, true);
      }
      throw sanitized;
    }
    return { ok: false, error: { status: error.status, code: error.code, message: error.message, headers: Object.fromEntries(new Headers(error.headers)), ...(error.data ? { data: error.data } : {}) } };
  }
}
/** Binding-only entrypoint. The public fetch handler exposes none of these methods. */
export class RealtimeBackend extends WorkerEntrypoint<Env> {
  private backend() { return localSessionBackend(this.env, promise => this.ctx.waitUntil(promise)); }
  private contract(version: number) {
    if (version !== REALTIME_BACKEND_CONTRACT) throw new GatewayError(503, 'provider_unavailable', 'Incompatible realtime backend');
  }
  async prepare(version: number, releaseId: string, request: Request, appId: string, provider: string, origin: string) {
    return result(async () => {
      this.contract(version);
      await requireRealtimeAdmission(this.env.DB, releaseId);
      return prepareRealtime(this.env, request, appId, provider, origin);
    });
  }
  async revalidate(version: number, b: Bootstrap, headers: Headers) {
    return result(async () => { this.contract(version); return this.backend().revalidate(b, headers); });
  }
  async capacity(version: number, b: Bootstrap, scope: 'user' | 'app', operation: 'acquire' | 'renew' | 'release', cap?: number) {
    return result(async () => { this.contract(version); return this.backend().capacity(b, scope, operation, cap); });
  }
  async admit(version: number, b: Bootstrap, app: AppRecord, attribution: AttemptAttribution, generationId: string, now: number, acknowledgement: ClaimAcknowledgement) {
    return result(async () => {
      this.contract(version);
      await this.backend().admit(b, app, attribution, generationId, now, claim => acknowledgement.acknowledge(claim), () => true);
    });
  }
  async receipt(version: number, b: Bootstrap, generationId: string) {
    return result(async () => { this.contract(version); return this.backend().receipt(b, generationId); });
  }
  async persist(version: number, event: UsageEvent) {
    return result(async () => { this.contract(version); await this.backend().persist(event); });
  }
  async maintain(version: number, b: Bootstrap, app: AppRecord, active: boolean) {
    return result(async () => { this.contract(version); await this.backend().maintain(b, app, active); });
  }
}
