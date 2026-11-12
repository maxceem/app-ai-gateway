/**
 * The mint guard: what an OpenAI realtime `client_secrets` request may ask
 * OpenAI to mint.
 *
 * Such a request returns an ephemeral key, and the client then talks to the
 * realtime session directly, so the gateway never sees the session itself.
 * Everything that session may cost is therefore decided by the body of this
 * one request: which model runs it, which model transcribes its audio, and how
 * long the key may open sessions for. The guard judges all three before the
 * body is forwarded. The rest of the body stays the client's: like every other
 * proxied body, it is forwarded as sent.
 *
 * The field layout is OpenAI's `RealtimeCreateClientSecretRequest`. A realtime
 * session names its model in `session.model`; either type of session names
 * the model that transcribes its input audio in
 * `session.audio.input.transcription.model`. The schema has no other field
 * that names a model.
 */

import { GatewayError } from "../core/errors";
import type { ProviderType } from "../shared/providers";

/**
 * The longest an ephemeral key may stay valid, in seconds. A key can open
 * several sessions until it expires, so its lifetime bounds how much one mint
 * can be used for. 600 is OpenAI's own default.
 */
export const REALTIME_CLIENT_SECRET_MAX_SECONDS = 600;

/** One model the guard judged, as the proxy's model policy settled it. */
export interface JudgedModel {
  /** The model the client named. */
  requestedModel: string;
  /** The model after the app's rewrites: what was priced and is recorded. */
  actualModel: string;
  /** What the route puts on the wire for it. */
  wireModel: string;
}

/**
 * How the guard treats an OpenAI path: `mint` for `v1/realtime/client_secrets`,
 * `refuse` for every other realtime path, `null` for everything else.
 *
 * The other realtime paths are refused because the gateway cannot judge them.
 * `v1/realtime/sessions` and `v1/realtime/transcription_sessions` are the older
 * ways to mint a key, and `v1/realtime/calls` starts a session directly with
 * the provider key. Refusing them is smaller than guarding each one's own body
 * layout, and `client_secrets` covers both session types.
 *
 * The path is compared in a canonical form, decoded, lowercased, with repeated
 * and trailing slashes removed, so a spelling the allowlist happens to admit
 * cannot reach the same operation without the guard.
 */
export function realtimePathKind(
  provider: ProviderType,
  providerPath: string,
): "mint" | "refuse" | null {
  if (provider !== "openai") return null;
  let decoded = providerPath;
  try {
    decoded = decodeURIComponent(providerPath);
  } catch {
    // A malformed escape is compared as sent; refusing it, if it matters, is
    // the allowlist's job.
  }
  const path = decoded.toLowerCase().replace(/\/{2,}/gu, "/").replace(/^\/|\/$/gu, "");
  if (path === "v1/realtime/client_secrets") return "mint";
  return /^v1\/realtime(?:\/|$)/u.test(path) ? "refuse" : null;
}

/** The answer to a realtime path {@link realtimePathKind} refuses. */
export function refusedRealtimePath(): GatewayError {
  return new GatewayError(
    403,
    "path_not_allowed",
    "Realtime sessions can only be created through v1/realtime/client_secrets",
  );
}

/** A model the body names, and the object whose `model` field holds it. */
interface NamedModel {
  model: string;
  field: string;
  parent: Record<string, unknown>;
}

function invalid(message: string): GatewayError {
  return new GatewayError(400, "invalid_request", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object field that may be absent or `null`, or a refusal when it is anything else. */
function optionalObject(
  parent: Record<string, unknown>,
  key: string,
  field: string,
): Record<string, unknown> | undefined {
  const value = parent[key];
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw invalid(`${field} must be an object`);
  return value;
}

/** A model field: absent, or a non-empty string. */
function modelField(parent: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(parent, "model")) return undefined;
  const value = parent.model;
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${field} must name a model`);
  }
  return value;
}

/**
 * Judges a `client_secrets` body and finishes it: every model it names, the
 * session type, and the key's lifetime. Mutates `body` only where a model is
 * rewritten or the lifetime is injected, and returns the model the usage event
 * records together with whether the body changed.
 *
 * `fixedModel` is the matched allowed path's `fixed_model`. On this path it is
 * a requirement, not a fallback: every model the body names must be it.
 * `judge` applies the rest of the app's model policy to one requested model.
 */
export function guardRealtimeMint(
  body: Record<string, unknown>,
  input: {
    fixedModel: string | undefined;
    judge: (requestedModel: string) => JudgedModel;
  },
): { model: string; changed: boolean } {
  // The schema has no top-level model, and the policy below judges only the
  // fields the session type reads.
  if (Object.hasOwn(body, "model")) {
    throw invalid("A realtime client secret names its models inside session");
  }
  const session = body.session;
  if (!isObject(session)) throw invalid("A realtime client secret needs a session object");
  const type = session.type;
  if (type !== "realtime" && type !== "transcription") {
    throw invalid("session.type must be realtime or transcription");
  }
  // The beta session layout named its transcription model here. The guard
  // would not read it, so a body that uses it is refused rather than forwarded.
  if (Object.hasOwn(session, "input_audio_transcription")) {
    throw invalid("Name the transcription model in session.audio.input.transcription.model");
  }
  const audio = optionalObject(session, "audio", "session.audio");
  const audioInput = audio && optionalObject(audio, "input", "session.audio.input");
  const transcription = audioInput && optionalObject(audioInput, "transcription", "session.audio.input.transcription");

  // Every model the session would run, with the field it is written back to.
  // A missing model is refused rather than left to OpenAI's default, so what
  // the gateway judged is exactly what is minted. With a fixed model the
  // gateway could inject it instead, but it cannot know which field a given
  // session type expects a fixed model in, and a session the client did not
  // build is harder to debug than a refusal that names the field to set.
  let primary: NamedModel;
  const others: NamedModel[] = [];
  if (type === "realtime") {
    const model = modelField(session, "session.model");
    if (model === undefined) throw invalid("A realtime session must name its model in session.model");
    primary = { model, field: "session.model", parent: session };
    // Transcribing the input audio is optional on a realtime session, but once
    // it is on, its model must be named rather than defaulted.
    if (transcription) {
      const transcriptionModel = modelField(transcription, "session.audio.input.transcription.model");
      if (transcriptionModel === undefined) {
        throw invalid("Input audio transcription must name its model in session.audio.input.transcription.model");
      }
      others.push({ model: transcriptionModel, field: "session.audio.input.transcription.model", parent: transcription });
    }
  } else {
    // A transcription session has no model of its own; a `session.model` here
    // would be a field this type does not read.
    if (Object.hasOwn(session, "model")) {
      throw invalid("A transcription session names its model in session.audio.input.transcription.model");
    }
    const transcriptionModel = transcription
      && modelField(transcription, "session.audio.input.transcription.model");
    if (!transcription || transcriptionModel === undefined) {
      throw invalid("A transcription session must name its model in session.audio.input.transcription.model");
    }
    primary = { model: transcriptionModel, field: "session.audio.input.transcription.model", parent: transcription };
  }

  let changed = false;
  const judge = (entry: NamedModel): JudgedModel => {
    if (input.fixedModel !== undefined && entry.model !== input.fixedModel) {
      throw new GatewayError(403, "model_not_allowed", `${entry.field} must be ${input.fixedModel} on this path`);
    }
    const model = input.judge(entry.model);
    if (model.wireModel !== model.requestedModel) {
      entry.parent.model = model.wireModel;
      changed = true;
    }
    return model;
  };
  // The usage event names the session's own model: the realtime model, or a
  // transcription session's only one.
  const recorded = judge(primary);
  for (const entry of others) judge(entry);

  changed = capLifetime(body) || changed;
  return { model: recorded.actualModel, changed };
}

/**
 * Refuses an `expires_after.seconds` above the cap and writes the cap where the
 * client named none, the way the output cap treats `max_output_tokens`.
 * Returns whether the body changed.
 */
function capLifetime(body: Record<string, unknown>): boolean {
  const cap = REALTIME_CLIENT_SECRET_MAX_SECONDS;
  const expires = optionalObject(body, "expires_after", "expires_after");
  if (!expires) {
    body.expires_after = { anchor: "created_at", seconds: cap };
    return true;
  }
  const seconds = expires.seconds;
  if (seconds === undefined || seconds === null) {
    expires.seconds = cap;
    return true;
  }
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    throw invalid("expires_after.seconds must be a number");
  }
  if (seconds > cap) {
    throw invalid(`expires_after.seconds exceeds the gateway's cap of ${cap}`);
  }
  return false;
}
