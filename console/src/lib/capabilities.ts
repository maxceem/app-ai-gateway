import {
  API_STYLE_PATHS,
  ENDPOINT_STYLE_API,
  GATEWAY_ROUTES,
  type ApiStyle as CoreApiStyle,
  type EndpointApiStyle,
} from "@shared/capabilities";
import { PROVIDER_LABELS, type Provider } from "./config-types";
import type { ProviderGatewayType } from "./types";

/**
 * Display names for the client API contracts this console shows. The style
 * *set* comes from the shared matrix; only the wording is the console's. `other`
 * has no entry because it names no contract and so has nothing to display — the
 * key set of this table is what makes a style displayable.
 */
export const API_STYLE_LABELS = {
  responses: "Responses",
  chat_completions: "Chat Completions",
  anthropic_messages: "Anthropic Messages",
  gemini_native: "Gemini generateContent",
  audio_transcription: "Transcription",
} as const satisfies Partial<Record<CoreApiStyle, string>>;

export type ApiStyle = keyof typeof API_STYLE_LABELS;

/**
 * Whether a style from the shared matrix is one this console can name. Every
 * route's style list is filtered through it, so a style added to the matrix
 * without a label is left out rather than rendered as `undefined`.
 */
function displayable(style: CoreApiStyle): style is ApiStyle {
  return Object.hasOwn(API_STYLE_LABELS, style);
}

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
  return { style, label: API_STYLE_LABELS[style], path: API_STYLE_PATHS[style] };
}

/**
 * What a gateway-routed instance can be called with, derived from the shared
 * route table the Worker routes with rather than configured anywhere. `null`
 * for a provider type the gateway does not serve, which the backend refuses to
 * store in the first place.
 */
export function gatewayApiSurface(
  gatewayType: ProviderGatewayType,
  provider: Provider,
): ApiSurface | null {
  const route = GATEWAY_ROUTES[gatewayType]?.[provider];
  if (!route) return null;
  const native = NATIVE_STYLES[provider] ?? [];
  const carried = route.apiStyles?.filter(displayable);
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
 * Whether a gateway-routed instance can serve a named endpoint of this style.
 * A route may carry fewer of a provider's operations than the provider itself
 * has — Vercel serves no transcription API — so the route decides, not the type.
 *
 * `null` is a direct row, which is judged by its provider type alone. A row
 * whose route is not yet known is not one of the answers: the caller has to
 * wait for it rather than be told yes.
 */
export function routeServesEndpointStyle(
  gatewayType: ProviderGatewayType | null,
  provider: Provider,
  style: EndpointApiStyle,
): boolean {
  if (gatewayType === null) return true;
  const surface = gatewayApiSurface(gatewayType, provider);
  if (!surface) return false;
  // A transparent gateway forwards to the provider's own API, so whatever the
  // provider offers survives the trip.
  if (!surface.narrowed) return true;
  const api = ENDPOINT_STYLE_API[style];
  return surface.available.some((entry) => entry.style === api);
}
