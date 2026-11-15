/**
 * The two headers a client sends about its own conversation: the trace id that
 * groups its requests, and its opt-out from conversation storage. Neither is
 * ever forwarded upstream — the proxy forwards an allowlist, and neither is on
 * it.
 */

import { CLIENT_TRACE_ID_PATTERN } from "../contracts/schemas";
import { GatewayError } from "../core/errors";

export interface ConversationHeaders {
  /** `X-Client-Trace-Id`, or null where the client sent none. */
  clientTraceId: string | null;
  /** True when the client sent `X-Conversation-Storage: off`. */
  optedOut: boolean;
}

/**
 * Reads both headers, refusing a malformed one by name rather than dropping
 * it: a trace id that silently vanished would leave a client joining on
 * nothing, and a misspelled opt-out would store what a user asked not to be.
 */
export function readConversationHeaders(headers: Headers): ConversationHeaders {
  const trace = headers.get("x-client-trace-id");
  if (trace !== null && !CLIENT_TRACE_ID_PATTERN.test(trace)) {
    throw new GatewayError(
      400,
      "invalid_request",
      "X-Client-Trace-Id must be 1-128 characters from A-Z, a-z, 0-9, '.', '_', ':' and '-'",
    );
  }
  const storage = headers.get("x-conversation-storage");
  if (storage !== null && storage.trim().toLowerCase() !== "off") {
    throw new GatewayError(400, "invalid_request", "X-Conversation-Storage accepts only off");
  }
  return { clientTraceId: trace, optedOut: storage !== null };
}
