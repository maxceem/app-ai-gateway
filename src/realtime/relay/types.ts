import type {
  AdmissionClaim,
  CompletionStatus,
  JsonObject,
  UsageTicket,
} from "./contract";

export type { CompletionStatus, JsonObject } from "./contract";

export type AdapterEffect =
  | { kind: "forward"; frame: JsonObject; useful?: boolean; input?: boolean; endInput?: boolean }
  | { kind: "configure"; frame: JsonObject }
  | { kind: "ready" }
  /** The provider emptied its input buffer: the turn's input bound starts again. */
  | { kind: "inputReset" }
  | { kind: "generate"; frame: JsonObject; correlation?: string; inputActivity?: boolean }
  | { kind: "cancel" }
  | { kind: "created"; responseId: string }
  /** The provider's usage so far, as it reported it. */
  | { kind: "observe"; usage: JsonObject }
  | {
    kind: "finalize";
    responseId: string;
    /** The provider's usage object, as it reported it; the gateway reads it. */
    usage: JsonObject | null;
    status: CompletionStatus;
    frame: JsonObject;
  }
  | { kind: "pendingAuto"; frame: JsonObject; correlation: string }
  /** Ends the session after the frames before it, such as a provider's error, were forwarded. */
  | { kind: "reject"; message: string };

export interface AdapterState {
  ready: boolean;
  active: boolean;
  responseId: string | null;
  configuring: boolean;
}

export interface ProtocolAdapter {
  initial(): JsonObject | null;
  client(frame: JsonObject, state: AdapterState): AdapterEffect[];
  server(frame: JsonObject, state: AdapterState): AdapterEffect[];
  cancel(): JsonObject | null;
}

/** One response of a session, as its journal keeps it. Never holds a secret or a payload. */
export interface Generation {
  id: string;
  ordinal: number;
  at: number;
  stage: "prepared" | "admitting" | "admitted" | "dispatching" | "active" | "settled" | "refused";
  intent?: { kind: string; fingerprint: string };
  /** Stored before the gateway spends it; null for an unmetered admission. */
  claim?: AdmissionClaim | null;
  /** What the gateway needs to record this response's usage, stored with the claim. */
  ticket?: UsageTicket;
  responseId: string | null;
  /** The provider's usage object, as last reported. */
  usage: JsonObject | null;
  outputBytes: number;
}
