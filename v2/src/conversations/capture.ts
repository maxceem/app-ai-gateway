/**
 * Handing one served call to its app's conversation log (v1's
 * `src/conversations/capture.ts`, on v2's call pipeline).
 *
 * Runs in `waitUntil`, after the app has its answer, and does as little as it
 * can here: it waits for the answer to end, checks the plan still includes
 * conversation storage, then passes the raw bytes on. Parsing them, decoding
 * media and writing to R2 all happen in the log (`../do/ConversationLog.ts`).
 *
 * A capture that fails is logged and dropped. Conversation storage is a record
 * for later reading, not part of serving or billing the call, and a missing
 * conversation is never worth failing or delaying a served request for
 * (`AGENTS.md`).
 */
import { getBillingAccess, planIncludes } from "../billing/access.ts";
import type { KeptMedia } from "../contracts/app-config.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import type { GatewayIdentity } from "../core/types.ts";
import type { ConversationCapture } from "./record.ts";
import { conversationsBucket } from "./storage.ts";

/** A request or response body larger than this is recorded by its size alone (v1). */
export const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

/** How long a capture may take, plan check and hand-over included. Past it, it is dropped and logged. */
export const CAPTURE_DEADLINE_MS = 20_000;

/** The body the provider received: the bytes sent, or a form the gateway rebuilt. */
export type SentBody =
  | { readonly bytes: Uint8Array; readonly contentType: string | null }
  | { readonly form: FormData };

export interface CaptureInput {
  readonly accountId: string;
  readonly appId: string;
  /** The app's `conversations.keep`. */
  readonly keep: KeptMedia;
  /** The charge's own id, so a stored conversation and its charge always name each other. */
  readonly chargeId: string;
  readonly identity: GatewayIdentity;
  readonly appVersion: string | null;
  readonly clientTraceId: string | null;
  /** The preset the call came through, if any (v1's endpoint). */
  readonly preset: string | null;
  /** `<connection slug>/<provider path>`, as v1's route. */
  readonly route: string;
  /** The provider type. */
  readonly provider: string;
  readonly model: string;
  readonly status: "ok" | "provider_error";
  readonly httpStatus: number;
  readonly latencyMs: number;
  readonly sent: SentBody;
  readonly response: {
    readonly contentType: string;
    /** The whole body, or null where it was larger than `CAPTURE_MAX_BYTES`. */
    readonly bytes: Uint8Array | null;
    readonly totalBytes: number;
    readonly aborted: boolean;
  };
}

async function sentBytes(sent: SentBody): Promise<{ contentType: string; bytes: Uint8Array<ArrayBuffer> }> {
  if ("form" in sent) {
    const encoded = new Response(sent.form);
    return { contentType: encoded.headers.get("content-type") ?? "", bytes: new Uint8Array(await encoded.arrayBuffer()) };
  }
  return { contentType: sent.contentType ?? "", bytes: new Uint8Array(sent.bytes) };
}

async function capture(env: Env, input: CaptureInput): Promise<void> {
  if (conversationsBucket(env) === null) return;
  // An app that turned storage on under a plan that included it keeps its
  // setting, and stores nothing while its plan does not (v1). Read in the
  // background, so the plan is never waited on by the call.
  if (!planIncludes(await getBillingAccess(env, input.accountId), "conversationStorage")) return;
  const request = await sentBytes(input.sent);
  const record: ConversationCapture = {
    eventId: input.chargeId,
    createdAt: new Date().toISOString(),
    appId: input.appId,
    userId: input.identity.userId,
    installId: input.identity.installId,
    appVersion: input.appVersion,
    clientTraceId: input.clientTraceId,
    endpointSlug: input.preset,
    route: input.route,
    provider: input.provider,
    model: input.model,
    status: input.status,
    httpStatus: input.httpStatus,
    latencyMs: input.latencyMs,
    keep: input.keep,
    request: {
      contentType: request.contentType,
      bytes: request.bytes.byteLength > CAPTURE_MAX_BYTES ? null : request.bytes,
      totalBytes: request.bytes.byteLength,
    },
    response: {
      contentType: input.response.contentType,
      bytes: input.response.bytes === null ? null : new Uint8Array(input.response.bytes),
      totalBytes: input.response.totalBytes,
      aborted: input.response.aborted,
    },
  };
  await env.CONVERSATION_LOG.getByName(input.appId).append(record);
}

/** Stores one call's conversation, within `CAPTURE_DEADLINE_MS`. Never throws. */
export async function captureConversation(env: Env, input: CaptureInput): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), CAPTURE_DEADLINE_MS);
  });
  try {
    const outcome = await Promise.race([capture(env, input).then(() => "done" as const), expired]);
    if (outcome === "expired") {
      log("warn", "conversation_capture_slow", { app: input.appId, chargeId: input.chargeId, deadlineMs: CAPTURE_DEADLINE_MS });
    }
  } catch (error) {
    log("warn", "conversation_capture_failed", { app: input.appId, chargeId: input.chargeId, error: errorFacts(error) });
  } finally {
    clearTimeout(timer);
  }
}
