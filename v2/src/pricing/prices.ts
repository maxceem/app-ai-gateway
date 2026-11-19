/**
 * The price file and the rates the gateway prices with (plan section 4.2,
 * "Prices"; D12, D20).
 *
 * `models.json` is v1's price file, copied as it is: price updates on v1's
 * main branch are copied here, never merged (D16). It writes dollars per
 * million units. Each number is converted once, when this module loads, to an
 * integer rate in nano-dollars per million units. Fields this step does not
 * price with are kept as they are, so later steps can read them.
 *
 * A price is never removed: a model the providers stopped listing keeps its
 * entry with `unlisted_since`, and is still priced.
 */
import models from "./models.json";
import { MoneyError, rate, rateFromDollarsPerMillion, type RateNanoPerMillion } from "../money.ts";

/** The rate fields a token price can have, by bucket and long-context variant. */
export const TOKEN_RATE_FIELDS = [
  "input",
  "cached_input",
  "cache_write",
  "cache_write_1h",
  "cache_write_12h",
  "output",
  "long_input",
  "long_cached_input",
  "long_cache_write",
  "long_cache_write_1h",
  "long_cache_write_12h",
  "long_output",
  "audio_input",
  "long_audio_input",
  "cached_input_audio",
  "long_cached_input_audio",
  "image_input",
  "image_output",
  "video_input",
  "per_minute",
  "per_hour",
  "per_image",
] as const;
export type TokenRateField = (typeof TOKEN_RATE_FIELDS)[number];

/** A model's rates as integers, plus the rest of its price-file entry as written. */
export interface ModelPrice {
  readonly rates: Partial<Record<TokenRateField, RateNanoPerMillion>>;
  /** Prompt size above which the `long_*` rates apply. */
  readonly longContextThreshold?: number;
  readonly kind?: string;
  readonly unlistedSince?: string;
  /** Everything else in the entry, for later steps (modes, price changes, author). */
  readonly raw: Readonly<Record<string, unknown>>;
}

type PriceFile = Record<string, Record<string, Record<string, unknown>>>;

function loadEntry(provider: string, model: string, entry: Record<string, unknown>): ModelPrice {
  const rates: Partial<Record<TokenRateField, RateNanoPerMillion>> = {};
  for (const field of TOKEN_RATE_FIELDS) {
    const value = entry[field];
    if (value === undefined) continue;
    if (typeof value !== "number") throw new MoneyError(`Price file: ${provider}/${model}.${field} is not a number`);
    rates[field] = rateFromDollarsPerMillion(value);
  }
  const threshold = entry.long_context_threshold;
  return {
    rates,
    ...(typeof threshold === "number" ? { longContextThreshold: threshold } : {}),
    ...(typeof entry.kind === "string" ? { kind: entry.kind } : {}),
    ...(typeof entry.unlisted_since === "string" ? { unlistedSince: entry.unlisted_since } : {}),
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
 * integer nano-dollars per million units, keyed by model.
 */
export type CustomerRates = Readonly<
  Record<string, Partial<Record<TokenRateField, number>> & { readonly long_context_threshold?: number }>
>;

/** A customer's rates for one model, checked and wrapped. Null when the model has none. */
export function customerPrice(rates: CustomerRates | null | undefined, model: string): ModelPrice | null {
  if (!rates || !Object.hasOwn(rates, model)) return null;
  const entry = rates[model]!;
  const wrapped: Partial<Record<TokenRateField, RateNanoPerMillion>> = {};
  for (const field of TOKEN_RATE_FIELDS) {
    const value = entry[field];
    if (value !== undefined) wrapped[field] = rate(value);
  }
  return {
    rates: wrapped,
    ...(entry.long_context_threshold !== undefined ? { longContextThreshold: entry.long_context_threshold } : {}),
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
  const own = customerPrice(customer, model);
  if (own !== null) return { price: own, source: "customer_rate" };
  const listed = listPrice(providerType, model);
  return listed === null ? null : { price: listed, source: "list_rate" };
}

/** Whether a model can be priced as a token model: it has both an input and an output rate. */
export function pricesTokens(price: ModelPrice): boolean {
  return price.rates.input !== undefined && price.rates.output !== undefined;
}

/** Whether a model has a price, ours or the customer's, that a chat call can be billed at. */
export function hasTokenPrice(providerType: string, model: string, customer: CustomerRates | null | undefined): boolean {
  const resolved = resolvePrice(providerType, model, customer);
  return resolved !== null && pricesTokens(resolved.price);
}
