import type { GatewayIdentity } from '../core/types';
import type { UsageObservation } from '../usage/pricing';
import type { QuotaAdmissionInput } from '../do/OrgQuota';
import type { UsageEvent } from '../usage/usage-record';
import type { RealtimeProtocol } from '../shared/capabilities';

export type JsonObject = Record<string, unknown>;
export interface Bootstrap {
  sessionId: string; appId: string; organizationId: string; providerId: string;
  providerSlug: string; model: string; requestedModel: string; protocol: RealtimeProtocol;
  identity: GatewayIdentity; appVersion: string | null; origin: string;
}
export type CompletionStatus = 'completed' | 'cancelled' | 'failed' | 'incomplete' | 'interrupted';
export type AdapterEffect =
  | { kind: 'forward'; frame: JsonObject; useful?: boolean; input?: boolean; endInput?: boolean }
  | { kind: 'configure'; frame: JsonObject }
  | { kind: 'ready' }
  | { kind: 'generate'; frame: JsonObject; correlation?: string; inputActivity?: boolean }
  | { kind: 'cancel' }
  | { kind: 'created'; responseId: string }
  | { kind: 'observe'; usage: UsageObservation }
  | { kind: 'finalize'; responseId: string; usage: UsageObservation | null; status: CompletionStatus; frame: JsonObject }
  | { kind: 'pendingAuto'; frame: JsonObject; correlation: string };
export interface AdapterState {
  ready: boolean; active: boolean; responseId: string | null; configuring: boolean;
}
export interface ProtocolAdapter {
  initial(): JsonObject | null;
  client(frame: JsonObject, state: AdapterState): AdapterEffect[];
  server(frame: JsonObject, state: AdapterState): AdapterEffect[];
  cancel(): JsonObject | null;
}
export interface Generation {
  id: string; ordinal: number; at: number;
  stage: 'prepared' | 'admitting' | 'admitted' | 'dispatching' | 'active' | 'settled' | 'refused';
  intent?: { kind: string; fingerprint: string };
  claim?: QuotaAdmissionInput | null;
  responseId: string | null; observation: UsageObservation | null;
  outputBytes: number;
  price: import("../usage/pricing").Price;
  /** Complete metadata-only template permits recovery without provider keys or payloads. */
  event: UsageEvent;
}
