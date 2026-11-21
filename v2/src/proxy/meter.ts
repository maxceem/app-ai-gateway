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
import { knownHostOwner } from "../providers/destination.ts";
import { builtInProvider } from "../providers/index.ts";
import { listedIn } from "../providers/listing.ts";
import { readingRules, type ApiStyle, type OperationDescription, type ProviderDescription, type ReadingRules } from "../providers/operation.ts";
import { errorFacts } from "../core/error-facts.ts";
import { fromDollars } from "../money.ts";
import { log } from "../core/log.ts";
import { hasMeasure, type UsageObservation } from "../usage/observation.ts";
import type { Unit } from "../providers/operation.ts";
import { scaledCount, unitScale } from "../pricing/units.ts";
import { bodyReader, withHeaderVariants, type BodyReader } from "../usage/readers.ts";
import {
  readServiceMode,
  type ServiceMode,
  type ServiceModeField,
  type ServiceModeValue,
  type ServiceRegion,
} from "../usage/service-modes.ts";

/**
 * The region a connection's base URL pins its requests to, or `global`. It is
 * read from the regional hosts of the provider that owns the base URL's host
 * (`knownHostOwner`), not the connection's type: a request goes where its
 * base URL points, so it is priced at that host's region, as its refused and
 * token paths are judged there (`../providers/destination.ts`). A built-in
 * connection on its own regional host is its own owner, so nothing changes
 * for it. A host no built-in provider declares has no region.
 */
function baseUrlRegion(baseUrl: string | null): ServiceRegion {
  if (baseUrl === null) return "global";
  const regions = knownHostOwner(baseUrl)?.regionalOrigins;
  if (regions === undefined) return "global";
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
  rules: ReadingRules,
  fields: readonly ServiceModeField[],
  model: string | undefined,
  native: boolean,
): readonly ServiceModeField[] {
  if (rules.modelNamespaces === undefined) return fields;
  const listed = model === undefined ? null : listedIn(rules.modelNamespaces, description.type, model);
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
  operation: OperationDescription | undefined,
  baseUrl: string | null,
  body: Record<string, unknown>,
  model?: string,
): { mode: ServiceMode; unknown?: ServiceModeValue } {
  const rules = readingRules(description, operation);
  const reading = readServiceMode(fieldsFor(description, rules, rules.serviceModes, model, true), (name) =>
    Object.hasOwn(body, name) ? body[name] : undefined,
  );
  const region = baseUrlRegion(baseUrl);
  const mode: ServiceMode =
    reading.mode.region === "global" && region !== "global" ? { tier: reading.mode.tier, region } : reading.mode;
  return reading.unknown ? { mode, unknown: reading.unknown } : { mode };
}

/**
 * Every service mode a call of `operation` on a connection at `baseUrl` can
 * be billed in: each tier and region its request and answer can name, read
 * with the same tables and the base URL's region as `requestedServiceMode`
 * and `servedServiceMode`. A request that names no region is in the base
 * URL's. Saving judges a mode rate against these (`unusedModeRate`).
 */
export function selectableModes(
  description: ProviderDescription,
  operation: OperationDescription | undefined,
  baseUrl: string | null,
  model?: string,
): ServiceMode[] {
  const rules = readingRules(description, operation);
  const base = baseUrlRegion(baseUrl);
  const tiers = new Set<ServiceMode["tier"]>(["standard"]);
  const regions = new Set<ServiceRegion>([base]);
  const add = (fields: readonly ServiceModeField[], asked: boolean) => {
    for (const field of fields) {
      for (const value of Object.values(field.values)) {
        if (field.axis === "tier") tiers.add(value as ServiceMode["tier"]);
        // As `requestedServiceMode`: a request read as global is in the base URL's region.
        else regions.add(asked && value === "global" ? base : (value as ServiceRegion));
      }
    }
  };
  add(fieldsFor(description, rules, rules.serviceModes, model, true), true);
  add(fieldsFor(description, rules, rules.servedModes ?? rules.serviceModes, model, false), false);
  return [...tiers].flatMap((tier) => [...regions].map((region) => ({ tier, region })));
}

/**
 * The service mode that served a call: each axis the response names, else
 * the one the request asked for. A provider may serve a cheaper tier than
 * asked (OpenAI sheds fast traffic to standard), or a dearer one the request
 * never showed, from an account default; it bills what it served.
 */
export function servedServiceMode(
  description: ProviderDescription,
  operation: OperationDescription | undefined,
  requested: ServiceMode,
  usage: UsageObservation | null,
  headers: Headers,
  model?: string,
): { mode: ServiceMode; unknown?: ServiceModeValue } {
  const rules = readingRules(description, operation);
  const fields = fieldsFor(description, rules, rules.servedModes ?? rules.serviceModes, model, false);
  const header = (name: string) => (name.startsWith("header:") ? (headers.get(name.slice("header:".length)) ?? undefined) : undefined);
  const reported = usage?.reportedModes;
  const read = (name: string) => header(name) ?? (reported && Object.hasOwn(reported, name) ? reported[name] : undefined);
  const { named, unknown, unstated } = readServiceMode(fields, read);
  let tier = named.tier ?? requested.tier;
  // A tier the response names in a value the table does not know, or in two
  // sources that disagree, says nothing the gateway can price: it may be
  // dearer than asked. It is flagged; pricing bills any doubt at least at
  // standard, as an estimate (`priceInServedMode`).
  const doubt = doubtfulTier(fields, read);
  const region = named.region ?? requested.region;
  const mode = tier === requested.tier && region === requested.region ? requested : { tier, region };
  // An answer that names no region where the request asked for one: billed
  // at the asked region's rate, as an estimate, since it may have been served
  // elsewhere. With no region asked, global is what it was served at.
  const unsure = unstated !== undefined && named.region === undefined && requested.region !== "global" ? unstated : undefined;
  const flagged = unknown ?? doubt ?? unsure;
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
  // The style whose usage the meter reads from the body: a JSON meter's, or a header meter's body reader.
  const usageStyle: ApiStyle | undefined = meter.kind === "response_json" ? meter.style : meter.kind === "response_header" ? meter.body?.style : undefined;
  const metered = usageStyle !== undefined;
  const style: ApiStyle | undefined = usageStyle ?? operation.style;
  if (style === undefined) return null;
  const body: BodyReader = bodyReader(contentType, style, {
    counted: readingRules(description, operation).countedInputModalities,
    maxEvents: budget.documents,
    ...(meter.kind === "response_json" && meter.providerCost !== undefined ? { providerCost: meter.providerCost } : {}),
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
      const unread = { usage: null, providerCostUsd: null, closed: null, ...(readingRules(description, operation).alternativeModels ? { servedModel: null } : {}) };
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
      const usage = !metered || reading.usage === null ? null : withHeaderVariants(reading.usage, headers, contentType, meter.kind === "response_json" ? (meter.usageHeaders ?? []) : []);
      const base = { usage, providerCostUsd: metered ? reading.providerCostUsd : null, closed: reading.closed };
      return readingRules(description, operation).alternativeModels === undefined ? base : { ...base, servedModel: reading.servedModel };
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
  const value = reportedCostUsd(operation, reading, headers);
  if (value === null) return null;
  // A figure too large to store as a charge is no report, from the body or a
  // header alike: the meter's own measure prices the call instead.
  try {
    fromDollars(value);
  } catch {
    log("warn", "provider_cost_unusable", { operation: operation.name });
    return null;
  }
  return value;
}

/** The provider's own figure as sent: a JSON report read with the body, or a header report. */
function reportedCostUsd(operation: OperationDescription, reading: ResponseReading | null, headers: Headers): number | null {
  const { meter } = operation;
  if (meter.kind === "response_json") return reading?.providerCostUsd ?? null;
  if (meter.kind !== "response_header" || meter.providerCost === undefined) return null;
  const { header, currency } = meter.providerCost;
  if (currency !== undefined && headers.get(currency.header)?.trim().toLowerCase() !== currency.value.toLowerCase()) return null;
  const value = headerNumber(headers.get(header));
  // $0 beside any positive reported measure, the header's amount or the
  // body's (ElevenLabs before overages, on a plan's included credits), is no
  // report: the measure bills instead, never as free.
  if (value === 0 && ((headerNumber(headers.get(meter.header)) ?? 0) > 0 || (reading?.usage != null && hasMeasure(reading.usage)))) return null;
  return value;
}

/** A header's usage with the body's beside it: both are the provider's reports. Either alone stands for both. */
function withBodyUsage(header: UsageObservation | null, body: UsageObservation | null, bodyUnits: readonly Unit[] = []): UsageObservation | null {
  if (body === null) return header;
  // What the body reports is a usage measure beside the header's billing unit, as the meter declares.
  const measured = bodyUnits.length > 0 ? { ...body, secondaryUnits: bodyUnits } : body;
  if (header === null) return measured;
  return { ...measured, units: { ...body.units, ...header.units } };
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

/** What one whole unit costs at the model's list price, in nano-dollars, or null (`listedUnitRate`). */
export type ListedRate = (unit: Unit) => number | null;

/**
 * The request's measure as the billed usage, exact, with the header's amount
 * kept beside it as a secondary measure (`headerRole: "cross_check"`). With
 * no header, the request's measure bills alone, still exact. With only the
 * header, it bills as an estimate.
 */
function crossChecked(
  operation: OperationDescription,
  header: UsageObservation | null,
  fromRequest: UsageObservation | null,
  headerUnit: Unit,
  listedRate: ListedRate | null,
): UsageObservation | null {
  const measured = fromRequest === null ? null : (({ estimatedUnits: _estimated, ...exact }) => exact)(fromRequest);
  if (header === null) return measured;
  if (measured === null) return { ...header, estimatedUnits: [headerUnit] };
  checkHeader(operation, header, measured, headerUnit, listedRate);
  return { ...measured, units: { ...header.units, ...measured.units }, secondaryUnits: [headerUnit] };
}

/**
 * A cross-checked usage whose request measure may be less than the provider
 * bills (`inDoubtWhen`): every unit becomes an estimate, so the price bills
 * the dearest of them, the header's amount included.
 */
function inDoubt(usage: UsageObservation | null): UsageObservation | null {
  if (usage === null) return null;
  const { secondaryUnits: _secondary, ...rest } = usage;
  return { ...rest, estimatedUnits: Object.keys(usage.units ?? {}) as Unit[] };
}

/**
 * Logs a cross-check header at `info` when it looks wrong: zero, or far from
 * what the model's list price implies. The list price states both rates, so
 * their ratio is the header's expected amount per unit of the request's
 * measure (ElevenLabs: about 0.2 credits per character on Flash, 0.4 on
 * Multilingual v2, T27). A small text may round up a little, so a gap of 2
 * whole units, or half the expected amount, is allowed.
 */
function checkHeader(operation: OperationDescription, header: UsageObservation, measured: UsageObservation, headerUnit: Unit, listedRate: ListedRate | null): void {
  const headerAmount = (header.units?.[headerUnit] ?? 0) / unitScale(headerUnit);
  const headerRate = listedRate?.(headerUnit) ?? null;
  for (const [unit, count] of Object.entries(measured.units ?? {}) as [Unit, number][]) {
    if (unit === headerUnit) continue;
    const amount = count / unitScale(unit);
    const unitRate = listedRate?.(unit) ?? null;
    const expected = headerRate === null || unitRate === null ? null : (amount * unitRate) / headerRate;
    const far = expected !== null && Math.abs(headerAmount - expected) > Math.max(2, expected / 2);
    if ((headerAmount === 0 && amount > 0) || far) {
      log("info", "header_cross_check_differs", {
        operation: operation.name,
        header_unit: headerUnit,
        header_amount: headerAmount,
        unit,
        amount,
        expected_amount: expected === null ? null : Math.round(expected * 1000) / 1000,
      });
    }
  }
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
  attempt: {
    readonly requestUsage?: UsageObservation | null;
    readonly priceKeys?: Readonly<Record<string, string>>;
    readonly answeredKeys?: readonly string[];
    readonly perChannel?: true;
    /** The provider may bill more than the request's measure (`inDoubtWhen`). */
    readonly measureInDoubt?: true;
    /** The model's list rates, which say what a cross-check header should report. */
    readonly listedRate?: ListedRate;
  },
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
      if (meter.headerRole === "cross_check") {
        const checked = crossChecked(operation, headerUsage(headers, meter.header, meter.unit), fromRequest, meter.unit, attempt.listedRate ?? null);
        usage = attempt.measureInDoubt === true ? inDoubt(checked) : checked;
        break;
      }
      // Every measure is kept: the amount the header reports, what the body
      // reports where the meter reads it, and the request's estimate. The
      // price bills a reported one where it can, else the estimate
      // (`priceInServedMode`).
      const reported = withBodyUsage(headerUsage(headers, meter.header, meter.unit), meter.body !== undefined ? reading : null, meter.body?.units);
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
  if (usage === null) return null;
  // Audio billed once per channel only when the request asks for it (`perChannelWhen`).
  if (attempt.perChannel === true && usage.audioSeconds !== undefined && (usage.audioChannels ?? 1) > 1) {
    usage = { ...usage, audioSeconds: usage.audioSeconds * usage.audioChannels! };
  }
  // A key the provider chose for this request takes the values its answer
  // reports (`answeredWhen`): one value, or several to bill the dearest of.
  // One the answer did not name leaves it unknown: a null, no report, or
  // fewer values than the channels it answers for (one per channel with
  // `perChannel`, else one), since an element naming nothing is not kept.
  const answered: Record<string, string> = {};
  const choices: Record<string, readonly string[]> = {};
  const answers = attempt.perChannel === true ? (usage.audioChannels ?? 1) : 1;
  for (const key of attempt.answeredKeys ?? []) {
    const values = usage.reportedPriceKeys?.[key];
    if (values === undefined || values.length < answers || values.includes(null)) continue;
    const distinct = [...new Set(values as readonly string[])];
    if (distinct.length === 1) answered[key] = distinct[0]!;
    else choices[key] = distinct;
  }
  const priceKeys = attempt.priceKeys === undefined && Object.keys(answered).length === 0 ? undefined : { ...attempt.priceKeys, ...answered };
  return {
    ...usage,
    ...(priceKeys !== undefined ? { priceKeys } : {}),
    ...(Object.keys(choices).length > 0 ? { priceKeyChoices: choices } : {}),
  };
}
