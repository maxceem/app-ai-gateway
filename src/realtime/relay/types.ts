import type { CompletionStatus, JsonObject, UsageTicket } from "./contract";

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

/**
 * One response of a session, as its journal keeps it. Never holds a secret or
 * a payload. It is stored before the request leaves for the provider, so every
 * response sent gets a usage record, even after a restart.
 */
export interface Generation {
  id: string;
  ordinal: number;
  at: number;
  /** `dispatching` once sent to the provider, `active` once it answered, `settled` once its usage is stored. */
  stage: "dispatching" | "active" | "settled";
  intent?: { kind: string; fingerprint: string };
  /** What the gateway needs to record this response's usage, from the session's last check. */
  ticket: UsageTicket;
  responseId: string | null;
  /** The provider's usage object, as last reported. */
  usage: JsonObject | null;
  outputBytes: number;
}
