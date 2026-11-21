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
import type { KeptMedia } from "../contracts/app-config.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { wholeBody } from "../proxy/observe.ts";
import type { GatewayIdentity } from "../core/types.ts";
import type { ConversationCapture } from "./record.ts";
import { appFolderName, conversationsBucket } from "./storage.ts";

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
  /** The app's `conversations.keep` as cached when the call was served. The saved setting, read fresh, is what is written. */
  readonly keep: KeptMedia;
  /** Answer fields that hold a recording in base64 (`OperationDescription.storedAudio`). */
  readonly audio?: { readonly fields: readonly string[]; readonly mime: string };
  /** The request body is a recording sent as raw bytes (`OperationDescription.rawAudio`). */
  readonly rawAudio?: true;
  /** A successful answer that is not JSON, events or JSON lines is a recording (`OperationDescription.rawAudioResponse`). */
  readonly rawAudioResponse?: true;
  /** Request form fields that carry a recording (`OperationDescription.audioFormFields`). */
  readonly audioFormFields?: readonly string[];
  /** The answer is newline-delimited JSON, whatever its content type (`OperationDescription.responseJsonLines`). */
  readonly responseJsonLines?: true;
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

async function sentBytes(sent: SentBody): Promise<{ contentType: string; bytes: Uint8Array<ArrayBuffer> }> {
  if ("form" in sent) {
    const encoded = new Response(sent.form);
    return { contentType: encoded.headers.get("content-type") ?? "", bytes: new Uint8Array(await encoded.arrayBuffer()) };
  }
  return { contentType: sent.contentType ?? "", bytes: new Uint8Array(sent.bytes) };
}

/** What a body that held a credential is stored as instead (`withoutCredentials`). */
const OMITTED = new TextEncoder().encode(JSON.stringify({ omitted: "credential" }));

/** A secret shorter than this is not looked for: it would match ordinary text. */
const MIN_SECRET_LENGTH = 8;

/**
 * A body that contains one of the call's credentials, exactly as sent, is
 * replaced by a marker, so history never holds a key an upstream echoed back
 * (an error that repeats its auth header, say). Checked once, here.
 */
function withoutCredentials(
  input: CaptureInput,
  which: "request" | "response",
  body: { contentType: string; bytes: Uint8Array | null },
): { contentType: string; bytes: Uint8Array | null } {
  if (body.bytes === null || body.bytes.byteLength === 0) return body;
  const secrets = input.secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  if (secrets.length === 0) return body;
  const text = new TextDecoder().decode(body.bytes);
  if (!secrets.some((secret) => text.includes(secret))) return body;
  log("warn", "conversation_body_omitted", { app: input.appId, chargeId: input.chargeId, body: which, reason: "credential" });
  return { contentType: "application/json", bytes: OMITTED };
}

/**
 * A stored metadata field (the trace id, the user id, ...) that holds a credential
 * used on the call is left out of the record, the same check as for bodies.
 */
/** Stands in for a required metadata field that held a credential. */
const OMITTED_FIELD = "agw-omitted:credential";

function metadataWithoutCredentials(input: CaptureInput, field: string, value: string | null): string | null {
  if (value === null) return null;
  const secrets = input.secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  if (!secrets.some((secret) => value.includes(secret))) return value;
  log("warn", "conversation_field_omitted", { app: input.appId, chargeId: input.chargeId, field, reason: "credential" });
  return null;
}

async function capture(env: Env, input: CaptureInput): Promise<void> {
  if (conversationsBucket(env) === null) return;
  // An app that turned storage on under a plan that included it keeps its
  // setting, and stores nothing while its plan does not (v1). Read in the
  // background, so the plan is never waited on by the call.
  if (!planIncludes(await getBillingAccess(env, input.accountId), "conversationStorage")) return;
  // The app's saved setting, read fresh: an isolate that cached the app before
  // storage was turned off must not store. Its media policy is the one used.
  const keep = await readSavedConversations(env, input.accountId, input.appId);
  if (keep === null) return;
  const sentRequest = await sentBytes(input.sent);
  const requestBytes = sentRequest.bytes.byteLength > CAPTURE_MAX_BYTES ? null : sentRequest.bytes;
  // A content type is checked on its own, even where the body is empty or too large to keep:
  // one that holds a credential is left out.
  const request = withoutCredentials(input, "request", {
    contentType: metadataWithoutCredentials(input, "request_content_type", sentRequest.contentType) ?? "",
    bytes: requestBytes,
  });
  const response = withoutCredentials(input, "response", {
    contentType: metadataWithoutCredentials(input, "response_content_type", input.response.contentType) ?? "",
    bytes: input.response.pieces === null ? null : wholeBody(input.response.pieces),
  });
  const record: ConversationCapture = {
    eventId: input.chargeId,
    createdAt: new Date(input.startedAt).toISOString(),
    accountId: input.accountId,
    appId: input.appId,
    userId: metadataWithoutCredentials(input, "user_id", input.identity.userId),
    installId: metadataWithoutCredentials(input, "install_id", input.identity.installId),
    appVersion: metadataWithoutCredentials(input, "app_version", input.appVersion),
    clientTraceId: metadataWithoutCredentials(input, "trace_id", input.clientTraceId),
    endpointSlug: metadataWithoutCredentials(input, "endpoint", input.preset),
    route: metadataWithoutCredentials(input, "route", input.route) ?? OMITTED_FIELD,
    provider: input.provider,
    model: metadataWithoutCredentials(input, "model", input.model) ?? OMITTED_FIELD,
    status: input.status,
    httpStatus: input.httpStatus,
    latencyMs: input.latencyMs,
    keep,
    ...(input.audio !== undefined ? { audio: { fields: [...input.audio.fields], mime: input.audio.mime } } : {}),
    ...(input.rawAudio === true ? { rawAudioRequest: true } : {}),
    ...(input.rawAudioResponse === true && input.status === "ok" ? { rawAudioResponse: true } : {}),
    ...(input.audioFormFields !== undefined && input.audioFormFields.length > 0 ? { audioFormFields: [...input.audioFormFields] } : {}),
    ...(input.responseJsonLines === true ? { responseJsonLines: true } : {}),
    request: {
      contentType: request.contentType,
      bytes: request.bytes === null ? null : new Uint8Array(request.bytes),
      totalBytes: sentRequest.bytes.byteLength,
    },
    response: {
      contentType: response.contentType,
      bytes: response.bytes === null ? null : new Uint8Array(response.bytes),
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
