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
import { log } from "../core/log.ts";
import type { UsageObservation } from "../usage/observation.ts";
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
 * How much reading for usage one answer may cost. Reading costs CPU for every
 * byte and every event (`scripts/bench-usage-reading.ts`): about 4 GB/s over a
 * large body (a base64 image, a number array), and about 3 µs per SSE event.
 * Past either limit, reading stops: the call is recorded unresolved and the
 * stop is logged, and the answer itself is never touched. Events are counted
 * by the framer, every one, before it is read.
 *
 * - 32 MiB of body: about 8 ms of CPU, more than any answer the gateway
 *   meters today.
 * - 25,000 events: about 70 ms of CPU, a streamed answer of some 25,000
 *   tokens. A Worker on the Free plan has 10 ms of CPU per request, which a
 *   stream reaches at about 3,500 events.
 */
export const READ_BUDGET = { bytes: 32 * 1024 * 1024, documents: 25_000 } as const;

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
      if (stopped !== null) return;
      read += chunk.byteLength;
      if (read > budget.bytes) return stop("budget");
      try {
        body.push(decoder.decode(chunk, { stream: true }));
      } catch (error) {
        stop("failed", error);
      }
    },
    finish(headers, clean) {
      const unread = { usage: null, providerCostUsd: null, closed: null, ...(description.alternativeModels ? { servedModel: null } : {}) };
      if (stopped !== null) return unread;
      let reading;
      try {
        body.push(decoder.decode());
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
