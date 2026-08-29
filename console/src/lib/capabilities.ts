import { PROVIDER_LABELS, type Provider } from "./config-types";
import type { ProviderGatewayType } from "./types";

/**
 * The client API contract a proxied request speaks. Mirrors `API_STYLES` in
 * `src/core/api-styles.ts`, minus `other`, which names no contract and so has
 * nothing to display.
 */
export const API_STYLE_LABELS = {
  responses: "Responses",
  chat_completions: "Chat Completions",
  anthropic_messages: "Anthropic Messages",
  gemini_native: "Gemini generateContent",
  audio_transcription: "Transcription",
} as const;

export type ApiStyle = keyof typeof API_STYLE_LABELS;

/**
 * The provider path each style is reached at *through a gateway that publishes
 * one URL space for every provider it serves*. Direct rows are deliberately
 * absent: each provider names its own prefix (`chat/completions` on DeepSeek,
 * `openai/v1/chat/completions` on Groq), which is what the per-provider hints
 * on the proxy-policy tab are for.
 */
const STYLE_PATHS: Record<ApiStyle, string> = {
  responses: "v1/responses",
  chat_completions: "v1/chat/completions",
  anthropic_messages: "v1/messages",
  gemini_native: "v1beta/models/{model}:generateContent",
  audio_transcription: "v1/audio/transcriptions",
};

/**
 * The API a provider type has that no OpenAI-compatible republisher carries for
 * free, so "this route cannot do it" is worth saying out loud. Everything else a
 * provider offers is one of the three cross-provider contracts, which every
 * gateway here serves.
 */
const NATIVE_STYLES: Partial<Record<Provider, readonly ApiStyle[]>> = {
  gemini: ["gemini_native"],
  openai: ["audio_transcription"],
  xai: ["audio_transcription"],
};

interface GatewayRoute {
  /** Absent means the gateway forwards whatever the provider's own API offers. */
  apiStyles?: readonly ApiStyle[];
  /** Namespace the gateway prepends to the canonical model ID on the wire. */
  modelPrefix?: string;
}

/** The three APIs Vercel republishes in front of every model it serves. */
const VERCEL_STYLES: readonly ApiStyle[] = ["responses", "chat_completions", "anthropic_messages"];

const vercel = (modelPrefix: string): GatewayRoute => ({ apiStyles: VERCEL_STYLES, modelPrefix });

/**
 * Which provider types each gateway serves, and how. Mirrors `CF_AIG_ROUTES`
 * and `VERCEL_ROUTES` in `src/core/gateways.ts`; a provider type absent from a
 * gateway's map is not served by it at all, which is what makes most types
 * direct-only. The backend is authoritative and refuses anything this disagrees
 * with — the mirror exists so the console can describe a row without a round
 * trip per instance.
 */
const GATEWAY_ROUTES: Record<ProviderGatewayType, Partial<Record<Provider, GatewayRoute>>> = {
  // Cloudflare forwards to each provider's own API under a provider slug, so
  // every API that provider has survives, native ones included.
  cf_aig: { openai: {}, anthropic: {}, xai: {}, gemini: {}, perplexity: {} },
  // Vercel names the provider in the model ID rather than the URL, and
  // namespaces those IDs by the model's author — Grok under `spacexai/`, Gemini
  // under `google/`.
  vercel: {
    openai: vercel("openai/"),
    anthropic: vercel("anthropic/"),
    gemini: vercel("google/"),
    xai: vercel("spacexai/"),
    perplexity: vercel("perplexity/"),
    deepseek: vercel("deepseek/"),
    moonshot: vercel("moonshotai/"),
  },
};

export interface ApiSurfaceEntry {
  style: ApiStyle;
  label: string;
  /** Appended to this instance's `/proxy/{slug}/` prefix. */
  path: string;
}

export interface ApiSurface {
  /**
   * Whether this route publishes APIs of its own. A transparent gateway
   * forwards to the provider's own API and so has no list to show: claiming
   * "Anthropic Messages available" on an OpenAI row would be this console
   * answering a question only OpenAI can.
   */
  narrowed: boolean;
  /** Client APIs this route carries, with the path each is reached at. */
  available: ApiSurfaceEntry[];
  /** APIs the provider itself has that this route cannot carry. */
  unavailable: ApiSurfaceEntry[];
  /**
   * What clients put in `model`. Canonical on every route: the provider's own
   * ID, with any gateway namespace added on the wire and never by the caller.
   */
  modelIds: string;
}

function entry(style: ApiStyle): ApiSurfaceEntry {
  return { style, label: API_STYLE_LABELS[style], path: STYLE_PATHS[style] };
}

/**
 * What a gateway-routed instance can be called with, derived from the route
 * rather than configured anywhere. `null` for a provider type the gateway does
 * not serve, which the backend refuses to store in the first place.
 */
export function gatewayApiSurface(
  gatewayType: ProviderGatewayType,
  provider: Provider,
): ApiSurface | null {
  const route = GATEWAY_ROUTES[gatewayType]?.[provider];
  if (!route) return null;
  const native = NATIVE_STYLES[provider] ?? [];
  const carried = route.apiStyles;
  return {
    narrowed: carried !== undefined,
    available: (carried ?? []).map(entry),
    unavailable: carried ? native.filter((style) => !carried.includes(style)).map(entry) : [],
    modelIds: route.modelPrefix
      ? `${PROVIDER_LABELS[provider]} model IDs with no "${route.modelPrefix}" prefix — the gateway adds it upstream`
      : `${PROVIDER_LABELS[provider]} model IDs, unchanged`,
  };
}

/**
 * The client API a named endpoint of each style composes, so endpoint
 * eligibility comes off the same matrix the proxy paths do rather than a second
 * list. Mirrors `endpointProviderPath` in `src/core/endpointrules.ts`.
 */
const ENDPOINT_STYLE_APIS = {
  responses: "responses",
  transcription: "audio_transcription",
} as const satisfies Record<string, ApiStyle>;

/**
 * Whether a gateway-routed instance can serve a named endpoint of this style.
 * A route may carry fewer of a provider's operations than the provider itself
 * has — Vercel serves no transcription API — so the route decides, not the type.
 */
export function routeServesEndpointStyle(
  gatewayType: ProviderGatewayType | null,
  provider: Provider,
  style: keyof typeof ENDPOINT_STYLE_APIS,
): boolean {
  if (gatewayType === null) return true;
  const surface = gatewayApiSurface(gatewayType, provider);
  if (!surface) return false;
  // A transparent gateway forwards to the provider's own API, so whatever the
  // provider offers survives the trip.
  if (!surface.narrowed) return true;
  const api = ENDPOINT_STYLE_APIS[style];
  return surface.available.some((entry) => entry.style === api);
}
