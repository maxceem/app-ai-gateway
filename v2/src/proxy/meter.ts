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
import { builtInProvider } from "../providers/index.ts";
import { listedAs } from "../providers/listing.ts";
import type { ApiStyle, OperationDescription, ProviderDescription } from "../providers/operation.ts";
import { errorFacts } from "../core/error-facts.ts";
import { fromDollars } from "../money.ts";
import { log } from "../core/log.ts";
import type { UsageObservation } from "../usage/observation.ts";
import type { Unit } from "../providers/operation.ts";
import { scaledCount } from "../pricing/units.ts";
import { bodyReader, withHeaderVariants, type BodyReader } from "../usage/readers.ts";
import {
  readServiceMode,
  type ServiceMode,
  type ServiceModeField,
  type ServiceModeValue,
  type ServiceRegion,
} from "../usage/service-modes.ts";

/** The region a connection's base URL pins its requests to, or `global`. */
function baseUrlRegion(description: ProviderDescription, baseUrl: string | null): ServiceRegion {
  const regions = description.regionalOrigins;
  if (baseUrl === null || regions === undefined) return "global";
  const origin = URL.canParse(baseUrl) ? `${new URL(baseUrl).origin}/` : baseUrl;
  return (Object.hasOwn(regions, origin) ? regions[origin] : undefined) ?? "global";
}

/**
 * A provider's service-mode fields as they read for one model. For a gateway
 * serving other providers' models (Vercel), the model's provider is the one
 * it is listed under (`src/providers/listing.ts`), and, as v1:
 * - a gateway's field that it hands on as the provider's own (`as`) is read
 *   with that provider's table only, so a value means what it means there:
 *   Vercel's `priority` is fast on OpenAI's models and priority on Gemini's;
 * - a field that is one provider's own option (`forProvider`) is read only for
 *   that provider's models, never carried to another's;
 * - with `native`, the request's own fields in that provider's spelling are
 *   read too (a top-level `service_tier`), since the gateway passes them on.
 * Any other field reads as declared.
 */
function fieldsFor(
  description: ProviderDescription,
  fields: readonly ServiceModeField[],
  model: string | undefined,
  native: boolean,
): readonly ServiceModeField[] {
  if (description.modelNamespaces === undefined) return fields;
  const listed = model === undefined ? null : listedAs(description.type, model);
  // A provider's own options are read for that provider's models only.
  const own = fields.filter((field) => field.forProvider === undefined || field.forProvider === listed?.type);
  const target = listed === null || listed.type === description.type ? null : builtInProvider(listed.type);
  if (target === null) return own;
  const mapped = own.map((field) => {
    if (field.as === undefined) return field;
    const table = target.serviceModes.find((candidate) => candidate.axis === field.axis && candidate.names.includes(field.as!));
    // Only the provider's own table, as v1: a value it does not list is unknown
    // there, and billed at the standard floor, whatever the gateway calls it.
    return table === undefined ? field : ({ ...field, values: table.values } as ServiceModeField);
  });
  return native ? [...mapped, ...target.serviceModes] : mapped;
}

/**
 * The service mode a request asks for: its body read with the provider's
 * table, and the region its connection's base URL serves. `unknown` is the
 * first value the table does not know, which leaves its axis at the default.
 * `model` picks the table of a gateway's field handed on as the provider's.
 */
export function requestedServiceMode(
  description: ProviderDescription,
  baseUrl: string | null,
  body: Record<string, unknown>,
  model?: string,
): { mode: ServiceMode; unknown?: ServiceModeValue } {
  const reading = readServiceMode(fieldsFor(description, description.serviceModes, model, true), (name) =>
    Object.hasOwn(body, name) ? body[name] : undefined,
  );
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
  model?: string,
): { mode: ServiceMode; unknown?: ServiceModeValue } {
  const fields = fieldsFor(description, description.servedModes ?? description.serviceModes, model, false);
  const header = (name: string) => (name.startsWith("header:") ? (headers.get(name.slice("header:".length)) ?? undefined) : undefined);
  const reported = usage?.reportedModes;
  const read = (name: string) => header(name) ?? (reported && Object.hasOwn(reported, name) ? reported[name] : undefined);
  const { named, unknown } = readServiceMode(fields, read);
  let tier = named.tier ?? requested.tier;
  // A tier the response names in a value the table does not know, or in two
  // sources that disagree, says nothing the gateway can price: it may be
  // dearer than asked. It is flagged; pricing bills any doubt at least at
  // standard, as an estimate (`priceInServedMode`).
  const doubt = doubtfulTier(fields, read);
  const region = named.region ?? requested.region;
  const mode = tier === requested.tier && region === requested.region ? requested : { tier, region };
  const flagged = unknown ?? doubt;
  return flagged ? { mode, unknown: flagged } : { mode };
}

/**
 * The first tier value a response gives that the gateway cannot price
 * exactly: one its table does not know, or one that disagrees with another
 * name of the same field (a header and the body, say).
 */
function doubtfulTier(fields: readonly ServiceModeField[], read: (name: string) => unknown): ServiceModeValue | undefined {
  for (const field of fields) {
    if (field.axis !== "tier") continue;
    // Only two names of one field can disagree, such as Gemini's header and
    // its body: two fields (Anthropic's `speed` and `service_tier`) answer
    // different questions.
    const known = new Set<string>();
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
  /**
   * The model the answer says served the request, read only for a provider
   * that may serve it with another model the request names (`alternativeModels`).
   */
  readonly servedModel?: string | null;
  /** For a stream: whether it ended with its style's closing event. Null when its style has none, or it is no stream. */
  readonly closed: boolean | null;
}

/**
 * A safety stop against a runaway body, never a limit a real answer meets:
 * past either figure, reading stops, the call is recorded unresolved and the
 * stop is logged, and the answer itself is never touched. Events are counted
 * by the framer, every one, before it is read.
 *
 * What reading costs (`scripts/bench-usage-reading.ts`): about 4–5 GB/s over a
 * large opaque value (a base64 image, a number array), about 120 MB/s over
 * dense JSON (log probabilities, word timestamps), and about 2.7 µs per SSE
 * event (3.8 µs when each event comes in a piece of its own).
 *
 * - 256 MiB of body: about 2 s of CPU at the dense-JSON rate.
 * - 250,000 events: about 1 s of CPU. OpenAI sends about one event per token,
 *   so the dearest answers are the longest streams: they are read whole.
 *
 * This does not keep a Worker on the Free plan (10 ms of CPU per request)
 * within its limit: a stream reaches it at about 3,000 events, as it did
 * before reading was streamed.
 */
export const READ_BUDGET = { bytes: 256 * 1024 * 1024, documents: 250_000 } as const;

/** Reads a response as it streams past (`./observe.ts` hands it each piece), then gives its reading. */
export interface ResponseReader {
  push(chunk: Uint8Array): void;
  /** The answer ended; `clean` when it was read to its real end, neither the app nor the provider cutting it. */
  finish(headers: Headers, clean: boolean): ResponseReading;
}

/**
 * The reader of a response with the operation's meter, or null when there is
 * nothing to read: no usage meter, and no API style whose stream has a
 * closing event. Any failure while reading turns it off and is logged: the
 * call is then recorded unresolved, never as free, and the answer is never
 * touched.
 */
export function responseReader(
  contentType: string,
  description: ProviderDescription,
  operation: OperationDescription,
  facts: Readonly<Record<string, unknown>>,
  budget: { readonly bytes: number; readonly documents: number } = READ_BUDGET,
): ResponseReader | null {
  const { meter } = operation;
  const metered = meter.kind === "response_json";
  const style: ApiStyle | undefined = metered ? meter.style : operation.style;
  if (style === undefined) return null;
  const body: BodyReader = bodyReader(contentType, style, {
    counted: description.countedInputModalities,
    maxEvents: budget.documents,
    ...(metered && meter.providerCost !== undefined ? { providerCost: meter.providerCost } : {}),
  });
  const decoder = new TextDecoder();
  let read = 0;
  let stopped: "budget" | "failed" | null = null;
  const stop = (why: "budget" | "failed", error?: unknown) => {
    stopped = why;
    if (why === "budget") log("warn", "usage_read_budget_exceeded", { ...facts, budgetBytes: budget.bytes, budgetEvents: budget.documents });
    else log("error", "usage_read_failed", { ...facts, error: errorFacts(error) });
  };
  return {
    push(chunk) {
      // A body that is not JSON (speech audio, say) is not decoded any further.
      if (stopped !== null || body.failed) return;
      read += chunk.byteLength;
      if (read > budget.bytes) return stop("budget");
      try {
        body.push(decoder.decode(chunk, { stream: true }));
      } catch (error) {
        return stop("failed", error);
      }
      // Past the event limit: stop now, so nothing more is decoded.
      if (body.stopped) stop("budget");
    },
    finish(headers, clean) {
      const unread = { usage: null, providerCostUsd: null, closed: null, ...(description.alternativeModels ? { servedModel: null } : {}) };
      if (stopped !== null) return unread;
      let reading;
      try {
        if (!body.failed) body.push(decoder.decode());
        reading = body.end(clean);
      } catch (error) {
        stop("failed", error);
        return unread;
      }
      // The framer counts every event, and stops before reading one past the limit.
      if (reading.stopped) {
        stop("budget");
        return unread;
      }
      if (reading.overflow) log("warn", "usage_value_too_large", facts);
      const usage = !metered || reading.usage === null ? null : withHeaderVariants(reading.usage, headers, contentType, description.type, style);
      const base = { usage, providerCostUsd: metered ? reading.providerCostUsd : null, closed: reading.closed };
      return description.alternativeModels === undefined ? base : { ...base, servedModel: reading.servedModel };
    },
  };
}

/** A plain decimal, with an optional exponent: no sign, no hex, no `Infinity`. */
const DECIMAL = /^\s*(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/u;

/**
 * A number a provider sends in a header, or null when it is not one. The one
 * parser for every header meter and header cost report: a plain decimal 0 or
 * more. A figure that is not finite, or a positive one so small it reads as
 * 0, is no number.
 */
export function headerNumber(text: string | null): number | null {
  if (text === null || !DECIMAL.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  // `1e-400` reads as 0: a positive figure lost to underflow is not a zero.
  if (value === 0 && /[1-9]/u.test(text.replace(/[eE].*$/u, ""))) return null;
  return value;
}

/**
 * The billed amount a response header reports (ElevenLabs' `character-cost`,
 * fal's `x-fal-billable-units`), as a usage in the meter's unit, or null when
 * the header is missing or not a number 0 or more.
 */
export function headerUsage(headers: Headers, header: string, unit: Unit): UsageObservation | null {
  const value = headerNumber(headers.get(header));
  if (value === null) return null;
  // A figure too large to count exactly is no report: the estimate bills instead.
  const count = scaledCount(unit, value);
  if (!Number.isSafeInteger(count)) return null;
  return { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true, units: { [unit]: count } };
}

/**
 * What the provider says an attempt cost, in dollars, or null when it says
 * nothing usable. One place for both kinds of report: a JSON cost report is
 * read with the body (`reading`), a header cost report from the headers. A
 * figure that is not a number 0 or more, or in another currency than the
 * report names, is no report: the call is priced at our rate instead.
 */
export function attemptCostUsd(operation: OperationDescription, reading: ResponseReading | null, headers: Headers): number | null {
  const { meter } = operation;
  if (meter.kind === "response_json") return reading?.providerCostUsd ?? null;
  if (meter.kind !== "response_header" || meter.providerCost === undefined) return null;
  const { header, currency } = meter.providerCost;
  if (currency !== undefined && headers.get(currency.header)?.trim().toLowerCase() !== currency.value.toLowerCase()) return null;
  const value = headerNumber(headers.get(header));
  if (value === null) return null;
  // A figure too large to store as a charge is no report: the meter's own measure prices the call instead.
  try {
    fromDollars(value);
  } catch {
    log("warn", "provider_cost_unusable", { operation: operation.name, header });
    return null;
  }
  return value;
}

/**
 * A reported usage with the request's measure kept beside it, for every meter
 * that takes one: the request's units are added as estimates, never over a
 * unit the provider reported. With no report, the request's measure alone.
 */
function withRequestMeasure(reported: UsageObservation | null, fromRequest: UsageObservation | null): UsageObservation | null {
  if (fromRequest === null) return reported;
  if (reported === null) return fromRequest;
  const reportedUnits = reported.units ?? {};
  const estimatedUnits = (fromRequest.estimatedUnits ?? []).filter((unit) => reportedUnits[unit] === undefined);
  const added = Object.fromEntries(Object.entries(fromRequest.units ?? {}).filter(([unit]) => reportedUnits[unit as Unit] === undefined));
  return {
    ...reported,
    units: { ...added, ...reportedUnits },
    ...(estimatedUnits.length > 0 ? { estimatedUnits: [...(reported.estimatedUnits ?? []), ...estimatedUnits] } : {}),
  };
}

/**
 * The usage a successful attempt is billed by, by its meter kind (plan
 * section 4.1, "Meter"), with the request's price key values on it:
 *
 * - usage in the response: what the reader read; an answer that reported
 *   none is billed by the request measure, where the meter has one;
 * - a response header: the amount it reports; a header that is missing falls
 *   back to the request's estimate, priced as an estimate;
 * - a request measure or count: what was measured from the request.
 */
export function attemptUsage(
  operation: OperationDescription,
  attempt: { readonly requestUsage?: UsageObservation | null; readonly priceKeys?: Readonly<Record<string, string>> },
  reading: UsageObservation | null,
  headers: Headers,
): UsageObservation | null {
  const { meter } = operation;
  const fromRequest = attempt.requestUsage ?? null;
  let usage: UsageObservation | null;
  switch (meter.kind) {
    case "response_json":
      // What the request measured is kept next to what the answer reported,
      // so a price in the request's unit can still bill (streamed speech that
      // reports tokens, at a per-character price).
      usage = withRequestMeasure(reading, meter.requestMeasure !== undefined ? fromRequest : null);
      break;
    case "response_header": {
      // Both measures are kept: the amount the header reports, and the
      // request's estimate. The price bills the reported one where it can,
      // else the estimate (`priceInServedMode`).
      const reported = headerUsage(headers, meter.header, meter.unit);
      usage = reported === null ? (fromRequest === null ? null : { ...fromRequest, reportMissing: true }) : withRequestMeasure(reported, fromRequest);
      break;
    }
    case "request_measure":
    case "request_count":
      usage = fromRequest;
      break;
    default:
      usage = reading;
  }
  return usage !== null && attempt.priceKeys !== undefined ? { ...usage, priceKeys: attempt.priceKeys } : usage;
}
