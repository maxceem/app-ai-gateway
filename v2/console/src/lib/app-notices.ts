import type { App, PriceList, ProviderConnection } from "@/lib/types";

/**
 * A model the app names that our price list marks as leaving: retiring on a
 * date, or no longer listed. Calls to it keep working until then; the app
 * should move to another model.
 */
export interface RetiringModel {
  type: string;
  model: string;
  /** Where the app names it, in words. */
  where: string[];
  retirementDate: string | null;
  unlistedSince: string | null;
}

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * The models an app names with the connection types they are called through:
 * its allowed models, its presets and their fallbacks, and its rewrite
 * targets (sent through any connection the app enables).
 */
function namedModels(app: App, providers: readonly ProviderConnection[]): { type: string; model: string; where: string }[] {
  const typeOf = new Map(providers.map((provider) => [provider.slug, provider.type]));
  const named: { type: string; model: string; where: string }[] = [];
  const routing = app.config.routing.providers;
  for (const [slug, entry] of Object.entries(routing)) {
    const type = typeOf.get(slug);
    if (type === undefined) continue;
    for (const model of entry.models ?? []) named.push({ type, model, where: `allowed on ${slug}` });
  }
  for (const [slug, preset] of Object.entries(app.config.presets ?? {})) {
    for (const target of [preset, ...(preset.fallback ?? [])]) {
      const type = typeOf.get(target.provider);
      if (type !== undefined) named.push({ type, model: target.model, where: `preset ${slug}` });
    }
  }
  const enabledTypes = [...new Set(Object.keys(routing).flatMap((slug) => (typeOf.has(slug) ? [typeOf.get(slug)!] : [])))];
  for (const [from, to] of Object.entries(app.config.routing.model_rewrites ?? {})) {
    for (const type of enabledTypes) named.push({ type, model: to, where: `rewrite from ${from}` });
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
