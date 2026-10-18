// What a new model does, read from the community lists before anyone is asked.
//
// Every catalog entry names a `kind` (MODEL_KINDS in src/shared/model-kinds.ts,
// which test/usage.test.ts holds this list to). A new model's kind comes from
// LiteLLM's `mode` first, which covers nearly every model these providers
// publish, then from Models.dev's `type`; only a model neither list knows is
// left to the AI review, and a person can override any of them from the PR.
// A mode the gateway serves no model of (video, rerank, moderation…) is a
// reason to skip the model, not a kind.

export const MODEL_KINDS = ["text", "image", "speech", "transcription", "embedding", "realtime"];

const LITELLM_MODES = {
  chat: "text",
  completion: "text",
  responses: "text",
  embedding: "embedding",
  audio_transcription: "transcription",
  audio_speech: "speech",
  image_generation: "image",
  realtime: "realtime",
};

const MODELS_DEV_TYPES = {
  chat: "text",
  image: "image",
  speech: "speech",
  transcription: "transcription",
  embedding: "embedding",
  realtime: "realtime",
};

/**
 * `{ kind }`, `{ unsupported }` naming a mode no gateway kind covers, or
 * undefined where the entry says nothing. A transcription model whose only
 * endpoints are realtime ones is a realtime model: the gateway's HTTP
 * transcription API cannot call it.
 */
export function kindFromLitellm(prices, key) {
  if (prices === null || typeof prices !== "object" || !Object.hasOwn(prices, key)) return undefined;
  const entry = prices[key];
  const mode = entry?.mode;
  if (typeof mode !== "string") return undefined;
  if (!Object.hasOwn(LITELLM_MODES, mode)) return { unsupported: mode };
  const endpoints = Array.isArray(entry.supported_endpoints) ? entry.supported_endpoints : [];
  if (mode === "audio_transcription" && endpoints.length > 0
    && endpoints.every((endpoint) => typeof endpoint === "string" && endpoint.startsWith("/v1/realtime"))) {
    return { kind: "realtime" };
  }
  return { kind: LITELLM_MODES[mode] };
}

/** The same answer from a Models.dev model's `type`, which few models carry yet. */
export function kindFromModelsDev(api, provider, model) {
  const models = api?.[provider]?.models;
  if (models === undefined || !Object.hasOwn(models, model)) return undefined;
  const type = models[model]?.type;
  if (typeof type !== "string") return undefined;
  return Object.hasOwn(MODELS_DEV_TYPES, type) ? { kind: MODELS_DEV_TYPES[type] } : { unsupported: type };
}

/**
 * Why a kind cannot be billed the way a price is denominated, or null. A
 * per-image price is an image model's; a time price is a transcription's or a
 * realtime session's. Token prices fit every kind.
 */
export function kindProblem(kind, price) {
  if (!MODEL_KINDS.includes(kind)) return `"${kind}" is not a model kind`;
  if (price.per_image !== undefined && kind !== "image") return `a per-image price does not fit a ${kind} model`;
  if ((price.per_minute !== undefined || price.per_hour !== undefined) && !["transcription", "realtime"].includes(kind)) {
    return `a time price does not fit a ${kind} model`;
  }
  return null;
}
