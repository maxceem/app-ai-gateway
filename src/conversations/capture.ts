/**
 * Handing one served request to its application's conversation log. Runs in
 * `waitUntil`, after the client has its answer, and does as little as it can
 * here: it waits for the response to finish, then passes the raw bytes on.
 * Parsing them, decoding images and writing to R2 all happen in the log.
 *
 * A capture that fails is logged and dropped. Conversation storage is a record
 * for later analysis, not part of serving or billing the request, and a few
 * missing conversations are not worth retrying a served request's work for.
 */

import type { GatewayIdentity } from "../core/types";
import { log } from "../core/log";
import { errorFacts } from "../core/error-facts";
import type { ObservedBody } from "../usage/body-observer";
import type { AttemptAttribution } from "../usage/usage-record";
import type { ExecutionRequest } from "../execution/plan";
import type { ConversationCapture, KeptMedia } from "./record";

/** A request or response body larger than this is recorded by its size alone. */
export const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

/** What the serving path keeps for a request whose conversation is stored. */
export interface CaptureSource {
  contentType: string;
  /** The app's `conversations.keep`. */
  keep: KeptMedia;
  /** The request body, read once and shared; see `PrepareInput.body`. */
  body: () => Promise<Uint8Array<ArrayBuffer>>;
}

export interface CaptureInput {
  env: Env;
  source: CaptureSource;
  /** The request as it went upstream, after an endpoint's params, model and clamps. */
  sent: ExecutionRequest;
  eventId: string;
  appId: string;
  identity: GatewayIdentity;
  appVersion: string | null;
  clientTraceId: string | null;
  endpointSlug: string | null;
  attribution: AttemptAttribution;
  status: "ok" | "provider_error";
  httpStatus: number;
  latencyMs: number;
  responseContentType: string;
  observed: Promise<ObservedBody>;
}

/**
 * The body the provider received. An endpoint builds its own, as JSON text or a
 * form; a body passed through as the client sent it is the client's, read once.
 */
async function sentBody(input: CaptureInput): Promise<{ contentType: string; bytes: Uint8Array<ArrayBuffer> }> {
  const body = input.sent.body;
  if (typeof body === "string") {
    return { contentType: input.sent.headers.get("content-type") ?? input.source.contentType, bytes: new TextEncoder().encode(body) };
  }
  if (body instanceof FormData) {
    const encoded = new Response(body);
    return { contentType: encoded.headers.get("content-type") ?? "", bytes: new Uint8Array(await encoded.arrayBuffer()) };
  }
  return { contentType: input.source.contentType, bytes: await input.source.body() };
}

export async function conversationCapture(input: CaptureInput): Promise<void> {
  try {
    const createdAt = new Date().toISOString();
    const [sent, observed] = await Promise.all([sentBody(input), input.observed]);
    const requestBytes = sent.bytes;
    const capture: ConversationCapture = {
      eventId: input.eventId,
      createdAt,
      appId: input.appId,
      userId: input.identity.userId,
      installId: input.identity.installId,
      appVersion: input.appVersion,
      clientTraceId: input.clientTraceId,
      endpointSlug: input.endpointSlug,
      route: input.attribution.route,
      provider: input.attribution.provider,
      model: input.attribution.model,
      status: input.status,
      httpStatus: input.httpStatus,
      latencyMs: input.latencyMs,
      keep: input.source.keep,
      request: {
        contentType: sent.contentType,
        bytes: requestBytes.byteLength > CAPTURE_MAX_BYTES ? null : requestBytes,
        totalBytes: requestBytes.byteLength,
      },
      response: {
        contentType: input.responseContentType,
        bytes: observed.whole ?? null,
        totalBytes: observed.totalBytes,
        aborted: observed.aborted,
      },
    };
    await input.env.CONVERSATION_LOG.getByName(input.appId).append(capture);
  } catch (error) {
    log("warn", "conversation_capture_failed", {
      eventId: input.eventId,
      appId: input.appId,
      error: errorFacts(error),
    });
  }
}
