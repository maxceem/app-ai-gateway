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
 * spelling appears. Pricing, restrictions, usage records and reports then speak
 * these names, so nothing downstream branches on a provider.
 *
 * Import-free and erasable syntax only, like `token-rates.ts`, so the console
 * and the model sync can load it.
 */

/** Each tier, cheapest first. `rank` orders them by what they cost against standard. */
export const SERVICE_TIERS = {
  flex: { label: "Flex", rank: 0 },
  standard: { label: "Standard", rank: 1 },
  priority: { label: "Priority", rank: 2 },
  fast: { label: "Fast", rank: 2 },
  ultrafast: { label: "Ultrafast", rank: 3 },
} as const;

/**
 * Each region a request can be pinned to. `global` is the provider's default
 * placement. The others are the regions a provider prices apart: Anthropic's
 * `inference_geo`, and the regional hosts of OpenAI, xAI, Mistral and Together.
 */
export const SERVICE_REGIONS = {
  global: { label: "Global" },
  us: { label: "US" },
  eu: { label: "EU" },
  gb: { label: "UK" },
  ca: { label: "Canada" },
  au: { label: "Australia" },
  jp: { label: "Japan" },
  kr: { label: "South Korea" },
  in: { label: "India" },
  sg: { label: "Singapore" },
  ae: { label: "UAE" },
} as const;

export type ServiceTier = keyof typeof SERVICE_TIERS;
export type ServiceRegion = keyof typeof SERVICE_REGIONS;

export interface ServiceMode {
  readonly tier: ServiceTier;
  readonly region: ServiceRegion;
}

/** What a request that names no mode is served in, and what every price without a mode means. */
export const STANDARD_MODE: ServiceMode = { tier: "standard", region: "global" };

/** A mode as a usage row stores it: only the axes that differ from the default. */
export interface StoredServiceMode {
  readonly tier?: ServiceTier;
  readonly region?: ServiceRegion;
}

/** The stored form of a mode, or `null` for the standard one. */
export function storedServiceMode(mode: ServiceMode): StoredServiceMode | null {
  if (mode.tier === "standard" && mode.region === "global") return null;
  return {
    ...(mode.tier !== "standard" && { tier: mode.tier }),
    ...(mode.region !== "global" && { region: mode.region }),
  };
}

/**
 * A stored mode read back, whatever a row holds: an axis it names that this
 * deployment does not know reads as the default, so an old row never fails
 * to reprice.
 */
export function serviceModeFromStored(stored: unknown): ServiceMode {
  if (typeof stored !== "object" || stored === null) return STANDARD_MODE;
  const { tier, region } = stored as Record<string, unknown>;
  const knownTier = typeof tier === "string" && Object.hasOwn(SERVICE_TIERS, tier) ? tier as ServiceTier : "standard";
  const knownRegion = typeof region === "string" && Object.hasOwn(SERVICE_REGIONS, region)
    ? region as ServiceRegion
    : "global";
  return knownTier === "standard" && knownRegion === "global"
    ? STANDARD_MODE
    : { tier: knownTier, region: knownRegion };
}

/**
 * A mode's name as prices, restrictions and messages spell it: the tier and the
 * region that differ from the default, joined by `+` — `fast`, `us`, `fast+us`,
 * or `standard` for the default itself.
 */
export function serviceModeName(mode: ServiceMode): string {
  const parts = [
    ...(mode.tier === "standard" ? [] : [mode.tier]),
    ...(mode.region === "global" ? [] : [mode.region]),
  ];
  return parts.length === 0 ? "standard" : parts.join("+");
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
  const isRegion = (part: string): part is ServiceRegion => Object.hasOwn(SERVICE_REGIONS, part) && part !== "global";
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
  }
  | {
    readonly names: readonly string[];
    readonly axis: "region";
    readonly values: Readonly<Record<string, ServiceRegion>>;
  };

/** A field value no entry of a provider's table names. */
export interface UnknownServiceMode {
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
  readonly askedBy: readonly UnknownServiceMode[];
  /** The first value the table does not know, if any. */
  readonly unknown?: UnknownServiceMode;
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
  let tierAskedBy: UnknownServiceMode | undefined;
  let region: ServiceRegion = "global";
  let regionNamed = false;
  let regionAskedBy: UnknownServiceMode | undefined;
  let unknown: UnknownServiceMode | undefined;
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
