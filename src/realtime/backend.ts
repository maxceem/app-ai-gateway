import type { AppRecord } from '../core/types';
import type { ResolvedProvider } from '../providers/provider-store';
import type { QuotaAdmission, QuotaAdmissionInput } from '../do/OrgQuota';
import type { AttemptAttribution, UsageEvent } from '../usage/usage-record';
import type { Bootstrap } from './types';

/** Versioned, domain-only internal contract. Never called for audio frames. */
export { REALTIME_BACKEND_CONTRACT } from './contract';
export interface SessionAccess { app: AppRecord; provider: ResolvedProvider }
export interface SessionLease { allowed: boolean; expiresAt: number }
export interface SessionBackend {
  revalidate(bootstrap: Bootstrap, headers: Headers): Promise<SessionAccess>;
  capacity(bootstrap: Bootstrap, scope: 'user' | 'app', operation: 'acquire' | 'renew' | 'release', cap?: number): Promise<SessionLease>;
  admit(bootstrap: Bootstrap, app: AppRecord, attribution: AttemptAttribution, generationId: string, now: number,
    beforeClaim: (claim: QuotaAdmissionInput | null) => void | Promise<void>, mayContinue: () => boolean): Promise<void>;
  receipt(bootstrap: Bootstrap, generationId: string): Promise<QuotaAdmission | null>;
  persist(event: UsageEvent): Promise<void>;
  maintain(bootstrap: Bootstrap, app: AppRecord, active: boolean): Promise<void>;
}
