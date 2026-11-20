/**
 * Service modes: the gateway's own names for the ways a provider can serve one
 * request at a price other than its standard one (ported from v1's
 * `src/shared/service-modes.ts`; plan section 9, "Service modes, as today").
 *
 * A mode has two independent axes, and every request has exactly one value on
 * each:
 *
 * - **tier**: how the provider schedules the request: `flex` (cheaper, may be
 *   refused when busy), `standard`, `priority` and `fast` (dearer, served
 *   first or faster), `ultrafast`;
 * - **region**: where it runs: `global`, or a region the request is pinned to.
 *
 * Clients never send these names. They send the provider's own field
 * (`service_tier`, `speed`, `inference_geo`), which the gateway forwards
 * unchanged. Each provider description says what its values mean in these
 * terms. Prices and charges then use these names.
 *
 * Plain functions over plain data, so the console can load it too.
 */

/**
 * A model's price in one service mode, as the price file writes it: every
 * rate multiplied by `factor` (1 when left out), then any rate named here in
 * place of its multiplied figure. Rates are dollars per million units.
 */
export type ModePrice = Readonly<Record<string, number | string | undefined>> & {
  readonly factor?: number;
  /** The day the provider's page stopped listing the mode. It keeps its last price. */
  readonly unlisted_since?: string;
};

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
    /**
     * For a gateway serving many providers' models: the one provider type this
     * field is an option of (Vercel's `providerOptions.anthropic.speed`). It
     * is read only for a model of that provider, never carried to another's.
     */
    readonly forProvider?: string;
  }
  | {
    readonly names: readonly string[];
    readonly axis: "region";
    readonly values: Readonly<Record<string, ServiceRegion>>;
    readonly as?: string;
    readonly forProvider?: string;
    /**
     * Values that name no region: the answer does not say where it was
     * served (Anthropic's `inference_geo: "not_available"`, T27). The region
     * stays the one the request asked for. That is exact when it asked for
     * none; a request for another region is then billed at that region's
     * rate as an estimate (`servedServiceMode`).
     */
    readonly unstated?: readonly string[];
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
  /** The first value that names no region (`unstated`), if any. */
  readonly unstated?: ServiceModeValue;
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
  let unstated: ServiceModeValue | undefined;
  for (const field of fields) {
    for (const name of field.names) {
      const value = fieldValue(read, name);
      if (value === undefined || value === null) continue;
      const key = typeof value === "string" ? value.toLowerCase() : undefined;
      if (field.axis === "region" && key !== undefined && field.unstated?.includes(key) === true) {
        unstated ??= { field: name, value: describeValue(value) };
        continue;
      }
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
  return { mode, named, askedBy, ...(unknown ? { unknown } : {}), ...(unstated ? { unstated } : {}) };
}

/** A field's value, following a dotted name into nested objects. */
/** A field's value, where a dotted name is a path into nested objects (`providerOptions.gateway.models`). */
export function fieldValue(read: (name: string) => unknown, name: string): unknown {
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

/**
 * The table for a provider that publishes no service tiers: the
 * OpenAI-compatible `service_tier` is still read, so any other value is logged
 * as unknown, the sign that the provider started selling a tier under it.
 */
export const NO_SERVICE_TIERS: readonly ServiceModeField[] = [
  { names: ["service_tier"], axis: "tier", values: { default: "standard", standard: "standard" } },
];
