/**
 * The price file and the rates the gateway prices with (plan section 4.2,
 * "Prices"; D12, D20).
 *
 * The price file is v1's `models.json`, copied as it is, plus v2's own
 * prices (`./price-file.ts`): price updates on v1's
 * main branch are copied here, never merged (D16). It writes dollars per
 * million units, and per minute, per hour or per image for the models priced
 * that way. Each number is converted once, when this module loads, to an
 * integer: nano-dollars per million tokens, or nano-dollars per minute, hour
 * or image. Fields not priced with are kept as they are.
 *
 * A price is never removed: a model the providers stopped listing keeps its
 * entry with `unlisted_since`, and is still priced.
 */
import { PRICE_FILE } from "./price-file.ts";
import type { OperationDescription, Unit } from "../providers/operation.ts";
import { MoneyError, NANO_PER_DOLLAR, rate, rateFromDollarsPerMillion, type RateNanoPerMillion } from "../money.ts";
import {
  isStandardMode,
  parseServiceModeName,
  serviceModeName,
  type ModePrice,
  type ServiceMode,
} from "../usage/service-modes.ts";
import { RATE_FIELDS } from "../usage/token-rates.ts";
import { operationUnits, UNIT_RATES } from "./units.ts";

/** The name of a rate a price may carry: a token rate (`input`, `long_cache_write_1h`, ...) or a unit rate (`per_minute`). */
export type RateField = string;

/** Rates as integers, by field. */
export type RateSet = Readonly<Partial<Record<RateField, RateNanoPerMillion>>>;

/**
 * Rates that depend on a request field (an operation's price key): for each
 * key, the rates each value of it bills at, replacing the model's own
 * (`by: { size: { "1024x1024": { per_image: 0.04 } } }` in the price file).
 */
export type KeyedRates = Readonly<Record<string, Readonly<Record<string, RateSet>>>>;

/** A model's rates as integers, plus the rest of its price-file entry as written. */
export interface ModelPrice {
  readonly rates: RateSet;
  /** Rates by price key value (`keyedPrices`). */
  readonly keyed?: KeyedRates;
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

/** The rates an object states, converted from dollars once. `where` names it in an error. */
function dollarRates(entry: Readonly<Record<string, unknown>>, where: string): Partial<Record<RateField, RateNanoPerMillion>> {
  const rates: Partial<Record<RateField, RateNanoPerMillion>> = {};
  for (const field of RATE_FIELDS) {
    const value = entry[field];
    if (value === undefined) continue;
    if (typeof value !== "number") throw new MoneyError(`Price file: ${where}.${field} is not a number`);
    rates[field] = rateFromDollarsPerMillion(value);
  }
  return rates;
}

/** `by` as written, its rates converted the way `convert` says: a price file writes dollars, a customer's stored rates nano-dollars. */
function readKeyed(by: unknown, convert: (rates: Readonly<Record<string, unknown>>, where: string) => RateSet, where: string): KeyedRates | undefined {
  if (typeof by !== "object" || by === null) return undefined;
  const keyed: Record<string, Record<string, RateSet>> = {};
  for (const [key, values] of Object.entries(by as Record<string, unknown>)) {
    if (typeof values !== "object" || values === null) continue;
    const table: Record<string, RateSet> = {};
    for (const [value, rates] of Object.entries(values as Record<string, unknown>)) {
      if (typeof rates === "object" && rates !== null) table[value] = convert(rates as Record<string, unknown>, `${where}.by.${key}.${value}`);
    }
    keyed[key] = table;
  }
  return keyed;
}

function loadEntry(provider: string, model: string, entry: Record<string, unknown>): ModelPrice {
  const rates = dollarRates(entry, `${provider}/${model}`);
  const keyed = readKeyed(entry.by, dollarRates, `${provider}/${model}`);
  const threshold = entry.long_context_threshold;
  const modes = entry.modes;
  return {
    rates,
    ...(keyed !== undefined ? { keyed } : {}),
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
export const PRICE_LIST = loadPriceFile(PRICE_FILE as PriceFile);

/**
 * A customer's own rates for one connection, as stored in `rates_json`, keyed
 * by model. Each entry has its rates as integer nano-dollars (per million
 * tokens, or per the unit a unit rate names: `../pricing/units.ts`), and may
 * have `long_context_threshold`, `modes` (each mode's `factor` and its own
 * rates, in nano-dollars) and `by` (rates by price key value, in nano-dollars).
 */
export type CustomerRateEntry = Readonly<Record<string, unknown>>;
export type CustomerRates = Readonly<Record<string, CustomerRateEntry>>;

/** Stored nano-dollar rates, checked and wrapped. */
function nanoRates(entry: Readonly<Record<string, unknown>>): Partial<Record<RateField, RateNanoPerMillion>> {
  const rates: Partial<Record<RateField, RateNanoPerMillion>> = {};
  for (const field of RATE_FIELDS) {
    const value = entry[field];
    if (typeof value === "number") rates[field] = rate(value);
  }
  return rates;
}

/** Each mode's factor alone, without the rates our list states for it. */
function modeFactors(modes: Readonly<Record<string, ModePrice>> | undefined): Record<string, ModePrice> | undefined {
  if (modes === undefined) return undefined;
  return Object.fromEntries(Object.entries(modes).map(([name, entry]) => [name, { factor: entry.factor ?? 1 }]));
}

/**
 * A customer's own modes, as a mode entry reads them: the factor as it is,
 * and each rate back in dollars, which `withModePrice` converts again. The
 * round trip is exact for any rate a price can hold (below 10^15 nano-dollars).
 */
function customerModes(modes: unknown): Record<string, ModePrice> | undefined {
  if (typeof modes !== "object" || modes === null) return undefined;
  const out: Record<string, ModePrice> = {};
  for (const [name, entry] of Object.entries(modes as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const mode: Record<string, number> = {};
    for (const [field, value] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof value !== "number") continue;
      mode[field] = field === "factor" ? value : value / NANO_PER_DOLLAR;
    }
    out[name] = mode as ModePrice;
  }
  return out;
}

/**
 * A customer's rates for one model, checked and wrapped. Null when the model
 * has none. A customer's rate replaces ours: a rate it leaves out falls back
 * as it would on an entry without it, never to our figure. Its own `modes`
 * apply where it states them; otherwise our list's modes still apply, but
 * only as factors: a rate the list states for a mode is the list's figure, not
 * the customer's (v1).
 */
export function customerPrice(rates: CustomerRates | null | undefined, model: string, listed?: ModelPrice | null): ModelPrice | null {
  if (!rates || !Object.hasOwn(rates, model)) return null;
  const entry = rates[model]!;
  const threshold = entry.long_context_threshold;
  const modes = customerModes(entry.modes) ?? modeFactors(listed?.modes);
  const keyed = readKeyed(entry.by, (values) => nanoRates(values), model);
  return {
    rates: nanoRates(entry),
    ...(keyed !== undefined ? { keyed } : {}),
    ...(typeof threshold === "number" ? { longContextThreshold: threshold } : {}),
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
 * Null when neither exists. A customer's rate is keyed by the model as the
 * connection names it; ours is looked up as `listed` names it, which differs
 * only for a gateway serving other providers' models (`src/providers/listing.ts`).
 */
export function resolvePrice(
  providerType: string,
  model: string,
  customer: CustomerRates | null | undefined,
  listed: { readonly type: string; readonly model: string } = { type: providerType, model },
): { readonly price: ModelPrice; readonly source: PriceSourceKind } | null {
  const ours = listPrice(listed.type, listed.model);
  const own = customerPrice(customer, model, ours);
  if (own !== null) return { price: own, source: "customer_rate" };
  return ours === null ? null : { price: ours, source: "list_rate" };
}

/** A price's rates, with every rate any price-key value states: what it can bill at all. */
function everyRate(price: ModelPrice): RateSet {
  const merged: Partial<Record<RateField, RateNanoPerMillion>> = { ...price.rates };
  for (const table of Object.values(price.keyed ?? {})) {
    for (const rates of Object.values(table)) Object.assign(merged, rates);
  }
  return merged;
}

/** Whether rates bill tokens: they have input and output rates. */
function billsTokens(rates: RateSet): boolean {
  return rates.input !== undefined && rates.output !== undefined;
}

/**
 * Whether a price is in a unit an operation measures (`operationUnits`):
 * tokens, or a unit rate for one of its units. A price-key value's rates
 * count, since a request may name that value.
 */
export function pricesOperation(operation: OperationDescription, price: ModelPrice): boolean {
  const rates = everyRate(price);
  const { meter } = operation;
  // A header meter's price bills both the header's unit and its estimate's, so
  // a missing header falls back to a measure the price can still bill.
  if (meter.kind === "response_header" && meter.estimate !== undefined) {
    const bills = (unit: Unit) => UNIT_RATES.some((unitRate) => rates[unitRate.field] !== undefined && unitRate.units.includes(unit));
    return bills(meter.unit) && bills(meter.estimate.unit);
  }
  const units = operationUnits(operation);
  if (units.includes("tokens") && billsTokens(rates)) return true;
  return UNIT_RATES.some((unitRate) => rates[unitRate.field] !== undefined && unitRate.units.some((unit) => units.includes(unit)));
}

/** Whether the operation's answers carry the provider's own cost, so it bills without a price of ours. */
export function reportsCost(operation: OperationDescription): boolean {
  return operation.meter.kind === "response_json" && operation.meter.providerCost !== undefined;
}

/** Whether rates state a unit rate. */
function statesUnitRate(rates: RateSet): boolean {
  return UNIT_RATES.some((unitRate) => rates[unitRate.field] !== undefined);
}

/**
 * Rates with one price-key value's rates applied: they replace the model's
 * own. A value that states a unit rate replaces every unit rate the model
 * has, so the unit it names is the one billed, not one the model listed first.
 */
function withValue(rates: RateSet, value: RateSet): RateSet {
  const merged: Partial<Record<RateField, RateNanoPerMillion>> = { ...rates };
  if (statesUnitRate(value)) for (const unitRate of UNIT_RATES) delete merged[unitRate.field];
  return Object.assign(merged, value);
}

/** A candidate price for a request: the price with one value applied for each of its keys. */
export interface KeyCandidate {
  /** The value used for each key: the request's, or one the price lists when the request's is unknown. */
  readonly values: Readonly<Record<string, string>>;
  readonly price: ModelPrice;
}

/**
 * The prices a request may bill at, with its price keys applied (an
 * operation's `priceKeys`, a price's `by`). A value the request names and the
 * price lists gives one price. A value the price does not list, or a key the
 * request did not name and the operation gives no default for, gives one
 * candidate per value listed for that key, each applied on its own, never
 * merged. `estimated` says a key's value was unknown. Without `values`, every
 * value of every key: every price the model can bill at, which saving checks.
 */
export function keyCandidates(price: ModelPrice, values?: Readonly<Record<string, string>>): { candidates: KeyCandidate[]; estimated: boolean } {
  if (price.keyed === undefined) return { candidates: [{ values: {}, price }], estimated: false };
  let candidates: { values: Record<string, string>; rates: RateSet }[] = [{ values: {}, rates: price.rates }];
  let estimated = false;
  for (const [key, table] of Object.entries(price.keyed)) {
    const value = values !== undefined && Object.hasOwn(values, key) ? values[key] : undefined;
    if (value !== undefined && Object.hasOwn(table, value)) {
      candidates = candidates.map((candidate) => ({ values: { ...candidate.values, [key]: value }, rates: withValue(candidate.rates, table[value]!) }));
      continue;
    }
    estimated = true;
    const listed = Object.entries(table);
    if (listed.length === 0) continue;
    candidates = candidates.flatMap((candidate) =>
      listed.map(([name, rates]) => ({ values: { ...candidate.values, [key]: name }, rates: withValue(candidate.rates, rates) })),
    );
  }
  return { candidates: candidates.map(({ values: used, rates }) => ({ values: used, price: { ...price, rates } })), estimated };
}

/** Whether rates can bill anything: input and output tokens, or a unit rate. */
export function ratesBill(rates: RateSet): boolean {
  return (rates.input !== undefined && rates.output !== undefined) || statesUnitRate(rates);
}

/**
 * Every effective price a model's price can produce at run time: each key
 * value (and so every unknown-value candidate) in each service mode the
 * run-time selection can reach, resolved by the run-time functions themselves
 * (`keyCandidates`, `priceInMode`). Saving checks each for billability and
 * for rates that fit; there is no other composition. A rate that does not fit
 * throws here, as it would at run time (`MoneyError`).
 */
export function effectivePrices(price: ModelPrice): { values: Readonly<Record<string, string>>; mode: string; price: ModelPrice }[] {
  const listed = listedModes(price);
  const tiers = new Set(listed.filter((mode) => mode.region === "global").map((mode) => mode.tier));
  const regions = new Set(listed.filter((mode) => mode.tier === "standard").map((mode) => mode.region));
  // Standard, each listed mode, and each tier in each region, which
  // `priceInMode` resolves as run time does: an exact pair first, else the
  // tier's price times the region's factor.
  const modes: ServiceMode[] = [{ tier: "standard", region: "global" }, ...listed];
  for (const tier of tiers) for (const region of regions) if (tier !== "standard") modes.push({ tier, region });
  const out: { values: Readonly<Record<string, string>>; mode: string; price: ModelPrice }[] = [];
  for (const candidate of keyCandidates(price).candidates) {
    for (const mode of modes) {
      const effective = priceInMode(candidate.price, mode);
      if (effective !== undefined) out.push({ values: candidate.values, mode: serviceModeName(mode), price: effective });
    }
  }
  return out;
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
