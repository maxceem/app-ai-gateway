/**
 * What a model does, as the price catalog records it.
 *
 * Every entry of `src/usage/models.json` names one kind. A kind is not an API:
 * a Gemini image or speech model answers on `generateContent` like a text one.
 * Which kinds an API carries is its protocol's `kinds` in `./protocols.ts`, and
 * the rule that makes the two enough together lives with the descriptors: a
 * provider type composes each kind through one endpoint style at most, so "this
 * type serves style S, S carries kind K, the model is K" is exact, and a model
 * that only one of its provider's APIs serves (a Responses-only `*-pro`) never
 * meets the other.
 *
 * Shared with the console, which reads the catalog off `listModelPrices`
 * rather than bundling it, so every lookup here takes the catalog it reads.
 */

import { lookup } from "./records.ts";

/**
 * `realtime` is a model served only over a realtime session, which no HTTP
 * endpoint carries: it is priced, and no custom endpoint can name it.
 */
export const MODEL_KINDS = ["text", "image", "speech", "transcription", "embedding", "realtime"] as const;

export type ModelKind = (typeof MODEL_KINDS)[number];

/** The kinds a custom endpoint can serve, in the order a person picks among them. */
export const ENDPOINT_KINDS = [
  "text",
  "image",
  "speech",
  "transcription",
  "embedding",
] as const satisfies readonly ModelKind[];

export type EndpointKind = (typeof ENDPOINT_KINDS)[number];

export function isModelKind(value: unknown): value is ModelKind {
  return typeof value === "string" && (MODEL_KINDS as readonly string[]).includes(value);
}

/** As much of a catalog as a kind lookup reads: provider type, then model. */
export type KindCatalog = Partial<Record<string, Record<string, { kind: ModelKind }>>>;

/**
 * A model's kind on one provider type, or `null` where nothing records one.
 *
 * The catalog answers first, because it is curated per model; an operator's
 * price override shadowing a catalog entry carries prices only and keeps the
 * catalog's kind. A model only an override prices is `text`: an override holds
 * token prices, which is what a text model is billed by. Anything else is
 * unknown — a model a route's own cost report bills — and the provider itself
 * is the judge of what it serves.
 */
export function modelKind(
  catalog: KindCatalog | undefined,
  type: string,
  model: string,
  overrides?: Record<string, unknown> | null,
): ModelKind | null {
  const entry = lookup(lookup(catalog, type), model);
  if (entry) return entry.kind;
  return lookup(overrides, model) ? "text" : null;
}

/** Whether a model of this kind may serve an endpoint of that one; an unknown kind may. */
export function servesKind(kind: ModelKind | null, wanted: ModelKind): boolean {
  return kind === null || kind === wanted;
}
