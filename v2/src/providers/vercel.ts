/**
 * Vercel AI Gateway, a provider of its own (D13). It serves many providers'
 * models through three client APIs, Chat Completions, Responses and Anthropic
 * Messages, at one origin; the token names the Vercel team and the model id
 * names the model's creator (`openai/gpt-4o`).
 *
 * Vercel answers in its own words, translating the serving provider's
 * protocol, so no provider's cost report survives: every model is priced from
 * our price file, under the provider type its namespace names
 * (`modelNamespaces`). Its own tier fields are read with that provider's
 * table, as v1 did.
 */
import { chat, messages, responses, withV1Paths } from "./llm.ts";
import { defineProvider } from "./operation.ts";

/** Vercel rejects a whole request whose attribution exceeds its limits, with a 400. */
const REPORTING_USER_MAX = 256;
const REPORTING_TAG_MAX = 64;

/**
 * Printable ASCII and space only: a header value outside the ByteString range
 * would make `Headers.set` throw, and the user id comes from the app's own
 * sign-in. An id Vercel would refuse, or that cannot be a header, is left out
 * rather than mangled: the gateway records the real one in its own ledger.
 */
function headerSafe(value: string): boolean {
  return /^[\x20-\x7E]*$/u.test(value);
}

export const vercel = defineProvider({
  type: "vercel",
  label: "Vercel AI Gateway",
  hosts: { main: "ai-gateway.vercel.sh" },
  auth: { header: "authorization", format: "Bearer {key}" },
  // An authenticated call on the gateway itself: `v1/models` is public, so it
  // would pass any token (v1).
  probe: { path: "v1/credits" },
  // Each namespace was checked against Vercel's live model list (v1). It is
  // the model's creator, so it matches a provider type only where that
  // provider serves its own models: Grok is under `spacexai/`, Gemini under
  // `google/`, Kimi under `moonshotai/`.
  // Vercel's own fallback models, tried when the first cannot serve: each must
  // be one the app allows and has a price for, and the one that served is billed.
  alternativeModels: { field: "providerOptions.gateway.models" },
  // The serving providers a connection may pin (v1's `providerOnly`).
  servingProvidersField: "providerOptions.gateway.only",
  modelNamespaces: {
    openai: "openai",
    anthropic: "anthropic",
    google: "gemini",
    spacexai: "xai",
    perplexity: "perplexity",
    deepseek: "deepseek",
    moonshotai: "moonshot",
  },
  // Vercel's own tier options, and the provider options it passes on (v1).
  // Its `serviceTier` is handed to the provider as the provider's own
  // `service_tier`, so it is read with that provider's table (`as`):
  // `priority` is fast on OpenAI and priority on Gemini.
  serviceModes: [
    {
      names: ["providerOptions.gateway.serviceTier"],
      as: "service_tier",
      axis: "tier",
      values: { default: "standard", standard: "standard", flex: "flex", priority: "priority", fast: "fast" },
    },
    { names: ["providerOptions.gateway.speed"], axis: "tier", values: { standard: "standard", fast: "fast" } },
    // A provider's own options apply to its models only (`forProvider`).
    { names: ["providerOptions.anthropic.speed"], forProvider: "anthropic", axis: "tier", values: { standard: "standard", fast: "fast" } },
    {
      names: ["providerOptions.openai.serviceTier"],
      forProvider: "openai",
      axis: "tier",
      values: { auto: "standard", default: "standard", flex: "flex", priority: "fast", fast: "fast", ultrafast: "ultrafast" },
    },
  ],
  // Vercel's answers do not carry the serving provider's tier: the request's is billed.
  servedModes: [],
  // Vercel's spend attribution, set by the gateway alone: it is the only one
  // that knows the real app and user behind a request (v1).
  attributionHeaders: ({ appId, userId }) => {
    const headers: Record<string, string> = {};
    if (userId !== null && userId.length > 0 && userId.length <= REPORTING_USER_MAX && headerSafe(userId)) {
      headers["ai-reporting-user"] = userId;
    }
    const tag = `app:${appId}`;
    if (appId.length > 0 && tag.length <= REPORTING_TAG_MAX && headerSafe(tag)) headers["ai-reporting-tags"] = tag;
    return headers;
  },
  // Vercel publishes no transcription or Gemini `generateContent` API (v1).
  operations: withV1Paths(
    "vercel",
    [chat("vercel.chat", "v1/chat/completions"), responses("vercel.responses", "v1/responses"), messages("vercel.messages", "v1/messages")],
    { styles: ["chat", "responses", "messages"] },
  ),
});
