/**
 * Measuring a call (plan section 4.1, "Meter"): what the request asks for,
 * and what the response says it used and cost. Pricing is in
 * `./call-charge.ts`.
 *
 * - The service mode a request asks for is read, never judged: a mode is
 *   never refused, since an app may already rely on it (`AGENTS.md`). It is
 *   priced once, against the mode that served the request.
 * - The response's usage is read by the operation's API style reader, and the
 *   provider's own cost report, where the operation has one, from the same
 *   values.
 */
import type { ApiStyle, OperationDescription, ProviderDescription } from "../providers/operation.ts";
import { readProviderCost } from "../usage/cost-reports.ts";
import type { UsageObservation } from "../usage/observation.ts";
import { readUsage, responseValues, withHeaderVariants } from "../usage/readers.ts";
import {
  readServiceMode,
  SERVICE_TIERS,
  type ServiceMode,
  type ServiceModeField,
  type ServiceModeValue,
  type ServiceRegion,
} from "../usage/service-modes.ts";
import type { ObservedText } from "./observe.ts";

/** The region a connection's base URL pins its requests to, or `global`. */
function baseUrlRegion(description: ProviderDescription, baseUrl: string | null): ServiceRegion {
  const regions = description.regionalOrigins;
  if (baseUrl === null || regions === undefined) return "global";
  const origin = URL.canParse(baseUrl) ? `${new URL(baseUrl).origin}/` : baseUrl;
  return (Object.hasOwn(regions, origin) ? regions[origin] : undefined) ?? "global";
}

/**
 * The service mode a request asks for: its body read with the provider's
 * table, and the region its connection's base URL serves. `unknown` is the
 * first value the table does not know, which leaves its axis at the default.
 */
export function requestedServiceMode(
  description: ProviderDescription,
  baseUrl: string | null,
  body: Record<string, unknown>,
): { mode: ServiceMode; unknown?: ServiceModeValue } {
  const reading = readServiceMode(description.serviceModes, (name) => (Object.hasOwn(body, name) ? body[name] : undefined));
  const region = baseUrlRegion(description, baseUrl);
  const mode: ServiceMode =
    reading.mode.region === "global" && region !== "global" ? { tier: reading.mode.tier, region } : reading.mode;
  return reading.unknown ? { mode, unknown: reading.unknown } : { mode };
}

/**
 * The service mode that served a call: each axis the response names, else
 * the one the request asked for. A provider may serve a cheaper tier than
 * asked (OpenAI sheds fast traffic to standard), or a dearer one the request
 * never showed, from an account default; it bills what it served.
 */
export function servedServiceMode(
  description: ProviderDescription,
  requested: ServiceMode,
  usage: UsageObservation | null,
  headers: Headers,
): { mode: ServiceMode; unknown?: ServiceModeValue } {
  const fields = description.servedModes ?? description.serviceModes;
  const header = (name: string) => (name.startsWith("header:") ? (headers.get(name.slice("header:".length)) ?? undefined) : undefined);
  const reported = usage?.reportedModes;
  const read = (name: string) => header(name) ?? (reported && Object.hasOwn(reported, name) ? reported[name] : undefined);
  const { named, unknown } = readServiceMode(fields, read);
  let tier = named.tier ?? requested.tier;
  // A tier found by scanning text the client can have a hand in (its own
  // metadata, echoed back) may say a dearer tier served the request, never a
  // cheaper one than asked. A header, or a value parsed whole, is believed.
  if (
    usage?.modesScanned === true &&
    SERVICE_TIERS[tier].rank < SERVICE_TIERS[requested.tier].rank &&
    readServiceMode(fields, (name) => header(name)).named.tier === undefined
  ) {
    tier = requested.tier;
  }
  // A tier the response names in a value the table does not know, or in two
  // sources that disagree, says nothing the gateway can price: it may be
  // dearer than asked. It is billed at least at standard, never at a cheaper
  // tier, and marked as an estimate.
  const doubt = doubtfulTier(fields, read);
  if (doubt !== undefined && SERVICE_TIERS[tier].rank < SERVICE_TIERS.standard.rank) tier = "standard";
  const region = named.region ?? requested.region;
  const mode = tier === requested.tier && region === requested.region ? requested : { tier, region };
  const flagged = unknown ?? doubt;
  return flagged ? { mode, unknown: flagged } : { mode };
}

/**
 * The first tier value a response gives that the gateway cannot price
 * exactly: one its table does not know, or one that disagrees with another
 * source of the same answer (a header and the body, say).
 */
function doubtfulTier(fields: readonly ServiceModeField[], read: (name: string) => unknown): ServiceModeValue | undefined {
  const known = new Set<string>();
  for (const field of fields) {
    if (field.axis !== "tier") continue;
    for (const name of field.names) {
      const value = read(name);
      if (value === undefined || value === null) continue;
      const key = typeof value === "string" ? value.toLowerCase() : undefined;
      const meaning = key !== undefined && Object.hasOwn(field.values, key) ? field.values[key] : undefined;
      const described: ServiceModeValue = { field: name, value: typeof value === "string" && /^[A-Za-z0-9_.-]{1,40}$/u.test(value) ? value : "(other)" };
      if (meaning === undefined) return described;
      known.add(meaning);
      if (known.size > 1) return described;
    }
  }
  return undefined;
}

/** What a response says about itself: its usage, and the provider's own cost in dollars. */
export interface ResponseReading {
  readonly usage: UsageObservation | null;
  readonly providerCostUsd: number | null;
}

/** Reads a response with the operation's meter. A body no reader can make sense of reads as nothing. */
export function readResponse(
  body: ObservedText,
  contentType: string,
  headers: Headers,
  description: ProviderDescription,
  operation: OperationDescription,
): ResponseReading {
  const { meter } = operation;
  if (meter.kind !== "response_json") return { usage: null, providerCostUsd: null };
  const style: ApiStyle = meter.style;
  const values = responseValues(body, contentType);
  const read = readUsage(values, style, description.countedInputModalities);
  const usage = read === null ? null : withHeaderVariants(read, headers, contentType, description.type, style);
  const providerCostUsd = meter.providerCost === undefined ? null : readProviderCost(values.backwards(), meter.providerCost);
  return { usage, providerCostUsd };
}
