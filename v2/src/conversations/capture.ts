/**
 * Handing one served call to its app's conversation log (v1's
 * `src/conversations/capture.ts`, on v2's call pipeline).
 *
 * Runs in `waitUntil`, after the app has its answer, and does as little as it
 * can here: it waits for the answer to end, checks the plan still includes
 * conversation storage and that the app's saved setting (read fresh, not from
 * the cache) still stores, then passes the raw bytes on. Parsing them, decoding
 * media and writing to R2 all happen in the log (`../do/ConversationLog.ts`).
 *
 * A capture that fails is logged and dropped. Conversation storage is a record
 * for later reading, not part of serving or billing the call, and a missing
 * conversation is never worth failing or delaying a served request for
 * (`AGENTS.md`).
 */
import { readSavedConversations } from "../apps/app-records.ts";
import { getBillingAccess, planIncludes } from "../billing/access.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { storedAudioType, type OperationDescription } from "../providers/operation.ts";
import { wholeBody } from "../proxy/observe.ts";
import type { GatewayIdentity } from "../core/types.ts";
import type { CaptureHints, ConversationCapture } from "./record.ts";
import { appFolderName, conversationsBucket } from "./storage.ts";

/** A request or response body larger than this is recorded by its size alone (v1). */
export const CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

/** How long a capture may take, plan check and hand-over included. Past it, it is dropped and logged. */
export const CAPTURE_DEADLINE_MS = 20_000;

/** The body the provider received: the bytes sent, or a form the gateway rebuilt. */
export type SentBody =
  | { readonly bytes: Uint8Array; readonly contentType: string | null }
  | { readonly form: FormData };

/**
 * What the operation declares about its bodies for capture, gathered once
 * from its description and passed through to the log unchanged.
 */
export function captureHints(operation: OperationDescription, query: string): CaptureHints {
  return {
    ...(operation.storedAudio !== undefined
      ? { audio: { fields: [...operation.storedAudio.fields], mime: storedAudioType(operation.storedAudio, query) } }
      : {}),
    ...(operation.rawAudio === true ? { rawAudioRequest: true } : {}),
    ...(operation.rawAudioResponse === true ? { rawAudioResponse: true } : {}),
    ...(operation.audioFormFields !== undefined && operation.audioFormFields.length > 0 ? { audioFormFields: [...operation.audioFormFields] } : {}),
    ...(operation.imageFormFields !== undefined && operation.imageFormFields.length > 0 ? { imageFormFields: [...operation.imageFormFields] } : {}),
    ...(operation.responseJsonLines === true ? { responseJsonLines: true } : {}),
  };
}

export interface CaptureInput {
  readonly accountId: string;
  readonly appId: string;
  /** What the operation declares about its bodies (`captureHints`). */
  readonly hints: CaptureHints;
  /** When the attempt started: a record's day is its charge's usage day, even for a stream that ends after midnight. */
  readonly startedAt: number;
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
  /**
   * The credentials the call carried: the provider's key and the gateway
   * credentials the app sent. A body that contains one is never stored.
   */
  readonly secrets: readonly string[];
  readonly response: {
    readonly contentType: string;
    /** The body's pieces, or null where it was larger than `CAPTURE_MAX_BYTES`. Joined here, in the background. */
    readonly pieces: readonly Uint8Array[] | null;
    readonly totalBytes: number;
    readonly aborted: boolean;
  };
}

/** The same bytes, as a view over a plain `ArrayBuffer`: copied only where they sit in another kind of buffer. */
function plainBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

/**
 * The request as sent: its content type, its size, and its bytes where it is
 * small enough to keep. Its size is checked before anything is copied, so a
 * large upload is never copied just to be dropped.
 */
async function sentBody(sent: SentBody): Promise<{ contentType: string; bytes: Uint8Array<ArrayBuffer> | null; totalBytes: number }> {
  if ("form" in sent) {
    const encoded = new Response(sent.form);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    return { contentType: encoded.headers.get("content-type") ?? "", bytes: bytes.byteLength > CAPTURE_MAX_BYTES ? null : bytes, totalBytes: bytes.byteLength };
  }
  const totalBytes = sent.bytes.byteLength;
  return { contentType: sent.contentType ?? "", bytes: totalBytes > CAPTURE_MAX_BYTES ? null : plainBytes(sent.bytes), totalBytes };
}

/** What a body that held a credential is stored as instead (`withoutCredentials`). */
const OMITTED = new TextEncoder().encode(JSON.stringify({ omitted: "credential" }));

/** A secret shorter than this is not looked for: it would match ordinary text. */
const MIN_SECRET_LENGTH = 8;

/** Stands in for a required metadata field that held a credential. */
const OMITTED_FIELD = "agw-omitted:credential";

/**
 * Whether `text` holds one of the call's credentials, exactly as sent. The one
 * test for bodies and metadata alike: history never holds a key an upstream
 * echoed back (an error that repeats its auth header, say).
 */
function holdsCredential(secrets: readonly string[], text: string): boolean {
  return secrets.some((secret) => text.includes(secret));
}

/** A body that holds a credential is replaced by a marker. Bodies are decoded only where a secret could match. */
function withoutCredentials(
  input: CaptureInput,
  secrets: readonly string[],
  which: "request" | "response",
  body: { contentType: string; bytes: Uint8Array<ArrayBuffer> | null },
): { contentType: string; bytes: Uint8Array<ArrayBuffer> | null } {
  if (body.bytes === null || body.bytes.byteLength === 0 || secrets.length === 0) return body;
  if (!holdsCredential(secrets, new TextDecoder().decode(body.bytes))) return body;
  log("warn", "conversation_body_omitted", { app: input.appId, chargeId: input.chargeId, body: which, reason: "credential" });
  return { contentType: "application/json", bytes: OMITTED };
}

/** A stored metadata field (the trace id, the user id, ...) that holds a credential is left out of the record. */
function metadataWithoutCredentials(input: CaptureInput, secrets: readonly string[], field: string, value: string | null): string | null {
  if (value === null || !holdsCredential(secrets, value)) return value;
  log("warn", "conversation_field_omitted", { app: input.appId, chargeId: input.chargeId, field, reason: "credential" });
  return null;
}

async function capture(env: Env, input: CaptureInput): Promise<void> {
  if (conversationsBucket(env) === null) return;
  // An app that turned storage on under a plan that included it keeps its
  // setting, and stores nothing while its plan does not (v1). Read in the
  // background, so the plan is never waited on by the call.
  const access = await getBillingAccess(env, input.accountId);
  if (access.state === "unavailable") {
    // Nothing is stored while billing cannot be read: logged, so a gap in history has a cause.
    log("warn", "conversation_capture_skipped", { app: input.appId, chargeId: input.chargeId, reason: "billing_unavailable" });
    return;
  }
  if (!planIncludes(access, "conversationStorage")) return;
  // The app's saved setting, read fresh: an isolate that cached the app before
  // storage was turned off must not store. Its media policy is the one used.
  const keep = await readSavedConversations(env, input.accountId, input.appId);
  if (keep === null) return;
  // A secret shorter than this would match ordinary text: it is not looked for.
  const secrets = input.secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  const field = (name: string, value: string | null) => metadataWithoutCredentials(input, secrets, name, value);
  const sentRequest = await sentBody(input.sent);
  // A content type is checked on its own, even where the body is empty or too large to keep:
  // one that holds a credential is left out.
  const request = withoutCredentials(input, secrets, "request", {
    contentType: field("request_content_type", sentRequest.contentType) ?? "",
    bytes: sentRequest.bytes,
  });
  const response = withoutCredentials(input, secrets, "response", {
    contentType: field("response_content_type", input.response.contentType) ?? "",
    bytes: input.response.pieces === null ? null : plainBytes(wholeBody(input.response.pieces)),
  });
  const record: ConversationCapture = {
    eventId: input.chargeId,
    createdAt: new Date(input.startedAt).toISOString(),
    accountId: input.accountId,
    appId: input.appId,
    userId: field("user_id", input.identity.userId),
    installId: field("install_id", input.identity.installId),
    appVersion: field("app_version", input.appVersion),
    clientTraceId: field("trace_id", input.clientTraceId),
    endpointSlug: field("endpoint", input.preset),
    route: field("route", input.route) ?? OMITTED_FIELD,
    provider: input.provider,
    model: field("model", input.model) ?? OMITTED_FIELD,
    status: input.status,
    httpStatus: input.httpStatus,
    latencyMs: input.latencyMs,
    keep,
    hints: input.hints,
    request: { contentType: request.contentType, bytes: request.bytes, totalBytes: sentRequest.totalBytes },
    response: {
      contentType: response.contentType,
      bytes: response.bytes,
      totalBytes: input.response.totalBytes,
      aborted: input.response.aborted,
    },
  };
  await env.CONVERSATION_LOG.getByName(appFolderName(input.accountId, input.appId)).append(record);
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
