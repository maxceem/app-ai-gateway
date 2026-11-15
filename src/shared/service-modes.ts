/**
 * Service modes: the gateway's own names for the ways a provider can serve one
 * request at a price other than its standard one.
 *
 * A mode has two independent axes, and every request has exactly one value on
 * each:
 *
 * - **tier**: how the provider schedules the request — `flex` (cheaper, may be
 *   refused when busy), `standard`, `priority` and `fast` (more expensive, served
 *   first or faster), `ultrafast`;
 * - **region**: where it runs — `global`, or a region the request is pinned to.
 *
 * Clients never send these names. They send the provider's own field
 * (`service_tier`, `speed`, `inference_geo`), which the gateway forwards
 * unchanged; each provider type declares in `src/shared/providers.ts` what its
 * values mean in these terms, and that table is the only place a provider's
 * spelling appears. Prices, usage records, logs and reports then speak these
 * names, so nothing downstream branches on a provider.
 *
 * Erasable syntax only, and it imports nothing but `./token-rates.ts` (by its
 * full name), so the console and the price list's updates can load it as it is.
 */

import { TOKEN_RATE_FIELDS, type ModePrice } from "./token-rates.ts";

/** Each tier, cheapest first. `rank` orders them by what they cost against standard. */
export const SERVICE_TIERS = {
  flex: { rank: 0 },
  standard: { rank: 1 },
  priority: { rank: 2 },
  fast: { rank: 2 },
  ultrafast: { rank: 3 },
} as const;

/**
 * Each region a request can be pinned to. `global` is the provider's default
 * placement. The others are the regions a provider prices apart: Anthropic's
 * `inference_geo`, and the regional hosts of OpenAI, xAI, Mistral and Together.
 */
export const SERVICE_REGIONS = ["global", "us", "eu", "gb", "ca", "au", "jp", "kr", "in", "sg", "ae"] as const;

export type ServiceTier = keyof typeof SERVICE_TIERS;
export type ServiceRegion = (typeof SERVICE_REGIONS)[number];

export interface ServiceMode {
  readonly tier: ServiceTier;
  readonly region: ServiceRegion;
}

/** What a request that names no mode is served in, and what every price without a mode means. */
export const STANDARD_MODE: ServiceMode = { tier: "standard", region: "global" };

/**
 * A mode's name, the one spelling prices, usage records, the usage API, logs
 * and messages all use: the tier and the region that differ from the default,
 * joined by `+` — `fast`, `us`, `fast+us`, or `standard` for the default
 * itself. {@link parseServiceModeName} reads it back.
 */
export function serviceModeName(mode: ServiceMode): string {
  const parts = [
    ...(mode.tier === "standard" ? [] : [mode.tier]),
    ...(mode.region === "global" ? [] : [mode.region]),
  ];
  return parts.length === 0 ? "standard" : parts.join("+");
}

export function isStandardMode(mode: ServiceMode): boolean {
  return mode.tier === "standard" && mode.region === "global";
}

/** Every rate a mode's factor multiplies. */
export const MODE_PRICE_FIELDS = [...TOKEN_RATE_FIELDS, "per_minute", "per_hour", "per_image"] as const;

/** A price shaped like a price-list entry: its rates, and the modes it is sold in. */
export type ModalPrice = Partial<Record<(typeof MODE_PRICE_FIELDS)[number], number>> & {
  modes?: Readonly<Record<string, ModePrice>>;
};

/** `price` with one mode entry applied: every rate × `factor` (1 if left out), then the entry's own rates. */
export function withModePrice<P extends ModalPrice>(price: P, entry: ModePrice): P {
  const factor = typeof entry.factor === "number" && Number.isFinite(entry.factor) && entry.factor >= 0
    ? entry.factor
    : 1;
  const next: P = { ...price };
  for (const field of MODE_PRICE_FIELDS) {
    const own = entry[field];
    const rate = price[field];
    if (typeof own === "number" && Number.isFinite(own) && own >= 0) next[field] = own as P[typeof field];
    else if (typeof rate === "number") next[field] = rate * factor as P[typeof field];
  }
  return next;
}

/**
 * A model's price in one service mode, or `undefined` where it has none.
 *
 * The standard mode is the entry itself. Any other is the entry's own
 * `modes[name]`: an exact key wins, so a provider that prices a combination
 * apart (Mistral's priority with regional inference, ×1.85 rather than
 * 1.75 × 1.1) states it. Failing one, a tier in a region is the tier's price
 * times the region's factor — Anthropic's fast mode in the US is 2 × 1.1. A
 * region's own rates are its standard-tier prices there, not a surcharge, so
 * they apply to a standard request in that region only: on top of a tier they
 * would replace the tier's price. Everything downstream — the long-context threshold, cache-write
 * variants, modality rates and every fallback in `bucketRates` — then reads
 * the derived price exactly as it reads a standard one.
 */
export function priceInMode<P extends ModalPrice>(price: P, mode: ServiceMode): P | undefined {
  if (isStandardMode(mode)) return price;
  const modes = price.modes;
  if (!modes) return undefined;
  const entry = (name: string) => Object.hasOwn(modes, name) ? modes[name] : undefined;
  const exact = entry(serviceModeName(mode));
  if (exact) return withModePrice(price, exact);
  if (mode.tier === "standard" || mode.region === "global") return undefined;
  const tier = entry(mode.tier);
  const region = entry(mode.region);
  return tier && region ? withModePrice(withModePrice(price, tier), { factor: region.factor ?? 1 }) : undefined;
}

/**
 * A mode spelled the way {@link serviceModeName} spells it — `fast`, `us`,
 * `fast+us`, `standard` — or `null` for anything else. A price's `modes` keys
 * are read with it, so a key that names no mode is refused where prices are
 * written.
 */
export function parseServiceModeName(name: string): ServiceMode | null {
  if (name === "standard") return STANDARD_MODE;
  const [first, second, ...rest] = name.split("+");
  if (first === undefined || rest.length > 0) return null;
  const isTier = (part: string): part is ServiceTier => Object.hasOwn(SERVICE_TIERS, part) && part !== "standard";
  const isRegion = (part: string): part is ServiceRegion =>
    (SERVICE_REGIONS as readonly string[]).includes(part) && part !== "global";
  if (second === undefined) {
    if (isTier(first)) return { tier: first, region: "global" };
    if (isRegion(first)) return { tier: "standard", region: first };
    return null;
  }
  return isTier(first) && isRegion(second) ? { tier: first, region: second } : null;
}

/**
 * One request field a provider reads a mode from, and what each of its values
 * means. A value not listed is one the gateway does not know yet, such as a
 * tier the provider added since: it is forwarded and billed at standard, and
 * reported so the table can learn it.
 */
export type ServiceModeField =
  | {
    /**
     * The field's names; more than one where the provider accepts several
     * spellings. A dotted name is a path into nested objects
     * (`providerOptions.gateway.serviceTier`).
     */
    readonly names: readonly string[];
    readonly axis: "tier";
    readonly values: Readonly<Record<string, ServiceTier>>;
    /**
     * For a gateway's own field that it passes on as the provider's: the
     * provider's field whose table its values are read with, where the
     * provider has one, so a value means what it means to that provider
     * (OpenAI's `priority` is its fast mode). `values` answers otherwise.
     */
    readonly as?: string;
  }
  | {
    readonly names: readonly string[];
    readonly axis: "region";
    readonly values: Readonly<Record<string, ServiceRegion>>;
    readonly as?: string;
  };

/** One field's value, as a request or a response gave it: the field's name and the value, made safe to log. */
export interface ServiceModeValue {
  readonly field: string;
  readonly value: string;
}

export interface ServiceModeReading {
  /** What the known values ask for; an unknown value leaves its axis at the default. */
  readonly mode: ServiceMode;
  /**
   * Each axis a known value named, even where it named the default: a response
   * that says `standard` has said something, and is believed over the request.
   */
  readonly named: { readonly tier?: ServiceTier; readonly region?: ServiceRegion };
  /**
   * The fields, as the client spelled them, that set the mode's tier and
   * region where they are not the default: what a message about the mode
   * quotes back, so the client sees the field it sent rather than only the
   * gateway's name for it.
   */
  readonly askedBy: readonly ServiceModeValue[];
  /** The first value the table does not know, if any. */
  readonly unknown?: ServiceModeValue;
}

/**
 * The mode a request asks for, read from its body with its provider's table.
 *
 * `read` returns a top-level body field's value: a JSON property, or a form
 * field. An absent or `null` field asks for nothing. Values are matched without
 * regard to case, as a lenient provider parser might accept them. Where several fields, or several
 * spellings of one, set the tier, the dearest wins: a provider may honour any
 * of them, so a cheap value beside a dear one must never hide it. A region
 * other than global wins over global.
 *
 * A few property reads on a body the caller has already parsed: no copy, no
 * second parse.
 */
export function readServiceMode(
  fields: readonly ServiceModeField[],
  read: (name: string) => unknown,
): ServiceModeReading {
  let tier: ServiceTier | undefined;
  let tierAskedBy: ServiceModeValue | undefined;
  let region: ServiceRegion = "global";
  let regionNamed = false;
  let regionAskedBy: ServiceModeValue | undefined;
  let unknown: ServiceModeValue | undefined;
  for (const field of fields) {
    for (const name of field.names) {
      const value = fieldValue(read, name);
      if (value === undefined || value === null) continue;
      const key = typeof value === "string" ? value.toLowerCase() : undefined;
      const meaning = key !== undefined && Object.hasOwn(field.values, key) ? field.values[key] : undefined;
      if (meaning === undefined) {
        unknown ??= { field: name, value: describeValue(value) };
        continue;
      }
      if (field.axis === "tier") {
        const asked = meaning as ServiceTier;
        if (tier === undefined || SERVICE_TIERS[asked].rank > SERVICE_TIERS[tier].rank) {
          tier = asked;
          tierAskedBy = { field: name, value: describeValue(value) };
        }
      } else {
        regionNamed = true;
        if (region === "global") {
          region = meaning as ServiceRegion;
          regionAskedBy = { field: name, value: describeValue(value) };
        }
      }
    }
  }
  const mode = (tier ?? "standard") === "standard" && region === "global"
    ? STANDARD_MODE
    : { tier: tier ?? "standard", region };
  const askedBy = [
    ...(mode.tier !== "standard" && tierAskedBy ? [tierAskedBy] : []),
    ...(mode.region !== "global" && regionAskedBy ? [regionAskedBy] : []),
  ];
  const named = {
    ...(tier !== undefined && { tier }),
    ...(regionNamed && { region }),
  };
  return unknown ? { mode, named, askedBy, unknown } : { mode, named, askedBy };
}

/** A field's value, following a dotted name into nested objects. */
function fieldValue(read: (name: string) => unknown, name: string): unknown {
  const dot = name.indexOf(".");
  if (dot === -1) return read(name);
  let value = read(name.slice(0, dot));
  for (const key of name.slice(dot + 1).split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * A client value as a log line may carry it: a short token of the kind a
 * provider names a tier with, or a constant. Never arbitrary client text.
 */
function describeValue(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,40}$/u.test(value) ? value : "(other)";
}
