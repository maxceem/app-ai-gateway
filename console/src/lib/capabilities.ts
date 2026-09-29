import { API_STYLE_PATHS, type ApiStyle as CoreApiStyle } from "@shared/capabilities";
import { providerLabel } from "./config-types";
import type { ProviderCredential } from "./types";

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
 * style list is filtered through it, so a style added to the matrix without a
 * label is left out rather than rendered as `undefined`.
 */
function displayable(style: CoreApiStyle): style is ApiStyle {
  return Object.hasOwn(API_STYLE_LABELS, style);
}

export interface ApiSurfaceEntry {
  style: ApiStyle;
  label: string;
  /** Appended to this instance's `/proxy/{slug}/` prefix. */
  path: string;
}

export interface RoutedSurface {
  /** Client APIs this route carries, with the path each is reached at. */
  available: ApiSurfaceEntry[];
  /**
   * What clients put in `model`. Canonical on every route: the provider's own
   * ID, with any gateway namespace added on the wire and never by the caller.
   */
  modelIds: string;
}

/**
 * What an instance can be called with where its gateway publishes a URL layout
 * of its own, as the gateway reports on the instance itself.
 *
 * `null` wherever clients call the provider's own paths — a direct instance,
 * or a gateway that forwards to the provider's API unchanged: claiming
 * "Anthropic Messages available" on an OpenAI row routed through such a
 * gateway would be this console answering a question only OpenAI can, so the
 * provider's own hint stands.
 */
export function routedSurface(
  instance: Pick<ProviderCredential, "type" | "capability">,
): RoutedSurface | null {
  if (instance.capability.paths !== "gateway") return null;
  const prefix = instance.capability.modelPrefix;
  return {
    available: instance.capability.apiStyles.filter(displayable).map((style) => ({
      style,
      label: API_STYLE_LABELS[style],
      path: API_STYLE_PATHS[style],
    })),
    modelIds: prefix
      ? `${providerLabel(instance.type)} model IDs with no "${prefix}" prefix — the gateway adds it upstream`
      : `${providerLabel(instance.type)} model IDs, unchanged`,
  };
}
