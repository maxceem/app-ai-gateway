/**
 * The price file and the rates the gateway prices with (plan section 4.2,
 * "Prices"; D12, D20).
 *
 * `models.json` is v1's price file, copied as it is: price updates on v1's
 * main branch are copied here, never merged (D16). It writes dollars per
 * million units, and per minute, per hour or per image for the models priced
 * that way. Each number is converted once, when this module loads, to an
 * integer: nano-dollars per million tokens, or nano-dollars per minute, hour
 * or image. Fields not priced with are kept as they are.
 *
 * A price is never removed: a model the providers stopped listing keeps its
 * entry with `unlisted_since`, and is still priced.
 */
import models from "./models.json";
import { MoneyError, rate, rateFromDollarsPerMillion, type RateNanoPerMillion } from "../money.ts";
import {
  isStandardMode,
  parseServiceModeName,
  serviceModeName,
  type ModePrice,
  type ServiceMode,
} from "../usage/service-modes.ts";
import { RATE_FIELDS } from "../usage/token-rates.ts";

/** The name of a rate a price may carry: a token rate (`input`, `long_cache_write_1h`, ...) or a unit rate (`per_minute`). */
export type RateField = string;

/** A model's rates as integers, plus the rest of its price-file entry as written. */
export interface ModelPrice {
  readonly rates: Readonly<Partial<Record<RateField, RateNanoPerMillion>>>;
  /** Prompt size above which the `long_*` rates apply. */
  readonly longContextThreshold?: number;
  readonly kind?: string;
  readonly unlistedSince?: string;
  /** Its price in each service mode other than standard, as the price file writes it (dollars). */
  readonly modes?: Readonly<Record<string, ModePrice>>;
  /** Everything else in the entry, for later steps. */
  readonly raw: Readonly<Record<string, unknown>>;
}

type PriceFile = Record<string, Record<string, Record<string, unknown>>>;

function loadEntry(provider: string, model: string, entry: Record<string, unknown>): ModelPrice {
  const rates: Partial<Record<RateField, RateNanoPerMillion>> = {};
  for (const field of RATE_FIELDS) {
    const value = entry[field];
    if (value === undefined) continue;
    if (typeof value !== "number") throw new MoneyError(`Price file: ${provider}/${model}.${field} is not a number`);
    rates[field] = rateFromDollarsPerMillion(value);
  }
  const threshold = entry.long_context_threshold;
  const modes = entry.modes;
  return {
    rates,
    ...(typeof threshold === "number" ? { longContextThreshold: threshold } : {}),
    ...(typeof entry.kind === "string" ? { kind: entry.kind } : {}),
    ...(typeof entry.unlisted_since === "string" ? { unlistedSince: entry.unlisted_since } : {}),
    ...(typeof modes === "object" && modes !== null ? { modes: modes as Record<string, ModePrice> } : {}),
    raw: entry,
  };
}

function loadPriceFile(file: PriceFile): ReadonlyMap<string, ReadonlyMap<string, ModelPrice>> {
  const byProvider = new Map<string, Map<string, ModelPrice>>();
  for (const [provider, entries] of Object.entries(file)) {
    const byModel = new Map<string, ModelPrice>();
    for (const [model, entry] of Object.entries(entries)) byModel.set(model, loadEntry(provider, model, entry));
    byProvider.set(provider, byModel);
  }
  return byProvider;
}

/** Our price list, converted once. */
export const PRICE_LIST = loadPriceFile(models as PriceFile);

/**
 * A customer's own rates for one connection, as stored in `rates_json`:
 * integer nano-dollars per million tokens, keyed by model.
 */
export type CustomerRates = Readonly<
  Record<string, Partial<Record<RateField, number>> & { readonly long_context_threshold?: number }>
>;

/** Each mode's factor alone, without the rates our list states for it. */
function modeFactors(modes: Readonly<Record<string, ModePrice>> | undefined): Record<string, ModePrice> | undefined {
  if (modes === undefined) return undefined;
  return Object.fromEntries(Object.entries(modes).map(([name, entry]) => [name, { factor: entry.factor ?? 1 }]));
}

/**
 * A customer's rates for one model, checked and wrapped. Null when the model
 * has none. A customer's rate replaces ours: a rate it leaves out falls back
 * as it would on an entry without it, never to our figure. Our list's service
 * modes still apply, but only as factors: a rate the list states for a mode is
 * the list's figure, not the customer's (v1).
 */
export function customerPrice(rates: CustomerRates | null | undefined, model: string, listed?: ModelPrice | null): ModelPrice | null {
  if (!rates || !Object.hasOwn(rates, model)) return null;
  const entry = rates[model]!;
  const wrapped: Partial<Record<RateField, RateNanoPerMillion>> = {};
  for (const field of RATE_FIELDS) {
    const value = entry[field];
    if (value !== undefined) wrapped[field] = rate(value);
  }
  const modes = modeFactors(listed?.modes);
  return {
    rates: wrapped,
    ...(entry.long_context_threshold !== undefined ? { longContextThreshold: entry.long_context_threshold } : {}),
    ...(listed?.kind !== undefined ? { kind: listed.kind } : {}),
    ...(modes !== undefined ? { modes } : {}),
    raw: entry,
  };
}

/** Our price for a model of a provider type, or null. */
export function listPrice(providerType: string, model: string): ModelPrice | null {
  return PRICE_LIST.get(providerType)?.get(model) ?? null;
}

export type PriceSourceKind = "customer_rate" | "list_rate";

/**
 * The price a model is billed at: the customer's own rate first, then ours.
 * Null when neither exists.
 */
export function resolvePrice(
  providerType: string,
  model: string,
  customer: CustomerRates | null | undefined,
): { readonly price: ModelPrice; readonly source: PriceSourceKind } | null {
  const listed = listPrice(providerType, model);
  const own = customerPrice(customer, model, listed);
  if (own !== null) return { price: own, source: "customer_rate" };
  return listed === null ? null : { price: listed, source: "list_rate" };
}

/** Whether a price can bill something: tokens (input and output rates), or a time or image rate. */
export function isComplete(price: ModelPrice): boolean {
  const { rates } = price;
  return (
    rates.per_minute !== undefined ||
    rates.per_hour !== undefined ||
    rates.per_image !== undefined ||
    (rates.input !== undefined && rates.output !== undefined)
  );
}

/** Whether a model has a price, ours or the customer's, that a call can be billed at. */
export function hasModelPrice(providerType: string, model: string, customer: CustomerRates | null | undefined): boolean {
  const resolved = resolvePrice(providerType, model, customer);
  return resolved !== null && isComplete(resolved.price);
}

/** A rate × factor, rounded up once, so a mode price is never under its true figure. */
function scaled(value: RateNanoPerMillion, factor: number): RateNanoPerMillion {
  return rate(Math.ceil(Number((value * factor).toPrecision(15))));
}

/** `price` with one mode entry applied: every rate × `factor` (1 if left out), then the entry's own rates. */
function withModePrice(price: ModelPrice, entry: ModePrice): ModelPrice {
  const factor = typeof entry.factor === "number" && Number.isFinite(entry.factor) && entry.factor >= 0 ? entry.factor : 1;
  const rates: Partial<Record<RateField, RateNanoPerMillion>> = {};
  for (const field of RATE_FIELDS) {
    const own = entry[field];
    const current = price.rates[field];
    if (typeof own === "number" && Number.isFinite(own) && own >= 0) rates[field] = rateFromDollarsPerMillion(own);
    else if (current !== undefined) rates[field] = scaled(current, factor);
  }
  return { ...price, rates };
}

/**
 * A model's price in one service mode, or undefined where it has none
 * (v1's `priceInMode`).
 *
 * The standard mode is the price itself. Any other is the entry's own
 * `modes[name]`: an exact key wins, so a provider that prices a combination
 * apart states it. Failing one, a tier in a region is the tier's price times
 * the region's factor. A region's own rates are its standard-tier prices
 * there, so on top of a tier only its factor applies.
 */
export function priceInMode(price: ModelPrice, mode: ServiceMode): ModelPrice | undefined {
  if (isStandardMode(mode)) return price;
  const modes = price.modes;
  if (modes === undefined) return undefined;
  const entry = (name: string) => (Object.hasOwn(modes, name) ? modes[name] : undefined);
  const exact = entry(serviceModeName(mode));
  if (exact) return withModePrice(price, exact);
  if (mode.tier === "standard" || mode.region === "global") return undefined;
  const tier = entry(mode.tier);
  const region = entry(mode.region);
  return tier && region ? withModePrice(withModePrice(price, tier), { factor: region.factor ?? 1 }) : undefined;
}

/** The modes a price lists on their own (not inside a pair): what an estimate may search. */
export function listedModes(price: ModelPrice): ServiceMode[] {
  return Object.keys(price.modes ?? {}).flatMap((name) => {
    const mode = parseServiceModeName(name);
    return mode === null ? [] : [mode];
  });
}
