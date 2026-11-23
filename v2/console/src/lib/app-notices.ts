import { BUILT_IN_PROVIDERS } from "@providers/index";
import { listedAs } from "@providers/listing";
import { rewrittenModel } from "@providers/operation";
import type { App, PriceList, ProviderConnection } from "@/lib/types";

/**
 * A model the app names that our price list marks as leaving: retiring on a
 * date (the provider stops serving it), or unlisted (still priced and served,
 * but no longer offered for new use).
 */
export interface RetiringModel {
  /** The provider type and model as our price list names them. */
  type: string;
  model: string;
  /** Where the app names it, in words. */
  where: string[];
  retirementDate: string | null;
  unlistedSince: string | null;
}

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Whether a rewrite from `from` applies to any call the app enables on a
 * connection of this type: only a call that carries its model, through an
 * operation the app enables there, is rewritten (`rewrittenModel`).
 */
function rewriteApplies(type: string, operations: readonly string[], from: string, to: string): boolean {
  const description = Object.hasOwn(BUILT_IN_PROVIDERS, type) ? BUILT_IN_PROVIDERS[type]! : null;
  if (description === null) return false;
  return description.operations.some((operation) => operations.includes(operation.name) && rewrittenModel(operation, from, { [from]: to }) === to && from !== to);
}

/**
 * The models an app names with the connection types they are called through:
 * its allowed models, its presets and their fallbacks, and its rewrite
 * targets, counted on each connection whose allowed models admit the source
 * and where an enabled operation applies them.
 * Each is looked up as our price list names it (`listedAs`), so a gateway's
 * namespaced model, such as Vercel's `openai/gpt-4.1`, finds its entry.
 */
function namedModels(app: App, providers: readonly ProviderConnection[]): { type: string; model: string; where: string }[] {
  const typeOf = new Map(providers.map((provider) => [provider.slug, provider.type]));
  const named: { type: string; model: string; where: string }[] = [];
  const add = (type: string, model: string, where: string) => {
    const listed = listedAs(type, model);
    named.push({ type: listed.type, model: listed.model, where });
  };
  const routing = app.config.routing.providers;
  for (const [slug, entry] of Object.entries(routing)) {
    const type = typeOf.get(slug);
    if (type === undefined) continue;
    for (const model of entry.models ?? []) add(type, model, `allowed on ${slug}`);
    for (const [from, to] of Object.entries(app.config.routing.model_rewrites ?? {})) {
      // A request naming a model the connection does not allow is refused before any rewrite (the gateway's rule).
      if (entry.models !== undefined && !entry.models.includes(from)) continue;
      if (rewriteApplies(type, entry.operations, from, to)) add(type, to, `rewrite from ${from}`);
    }
  }
  for (const [slug, preset] of Object.entries(app.config.presets ?? {})) {
    for (const target of [preset, ...(preset.fallback ?? [])]) {
      const type = typeOf.get(target.provider);
      if (type !== undefined) add(type, target.model, `preset ${slug}`);
    }
  }
  return named;
}

/** The models an app names that our price list marks as retiring or unlisted, each once. */
export function retiringModels(app: App, providers: readonly ProviderConnection[], prices: PriceList): RetiringModel[] {
  const found = new Map<string, RetiringModel>();
  for (const { type, model, where } of namedModels(app, providers)) {
    const entry = Object.hasOwn(prices, type) && Object.hasOwn(prices[type]!, model) ? prices[type]![model]! : null;
    if (entry === null) continue;
    const retirementDate = textOrNull(entry.retirement_date);
    const unlistedSince = textOrNull(entry.unlisted_since);
    if (retirementDate === null && unlistedSince === null) continue;
    const key = `${type}\u0000${model}`;
    const known = found.get(key);
    if (known) {
      if (!known.where.includes(where)) known.where.push(where);
    } else {
      found.set(key, { type, model, where: [where], retirementDate, unlistedSince });
    }
  }
  return [...found.values()];
}
