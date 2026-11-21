/**
 * Reading and changing named fields of a request (plan section 4.1): the one
 * place a request field is found by an operation's `FieldRef`.
 *
 * - Request measures: what a meter takes from the request itself, for an
 *   operation whose provider reports no usage (`request_measure`), an
 *   estimate before a header reports the billed amount (`response_header`),
 *   or an answer with no usage at all (`response_json`'s `requestMeasure`).
 * - Price keys: the request values a rate depends on, such as an image size.
 * - Outbound fields: webhook fields, and fetch fields the operation does not
 *   need, removed before the request is sent, so the provider never calls or
 *   fetches a URL whose cost the budget never sees.
 *
 * A JSON body is read by dot path. A form is read from the fields the scanner
 * took from it (`requestFormFields` names them). A query from the URL.
 */
import { requestMeasuresOf, type FieldRef, type OperationDescription, type RequestMeasure, type SwitchKind, type Unit } from "../providers/operation.ts";
import { log } from "../core/log.ts";
import type { ModelPrice } from "../pricing/prices.ts";
import { scaledCount } from "../pricing/units.ts";
import type { UsageObservation } from "../usage/observation.ts";

/** A request's fields: its body (a JSON object, or a form's text fields) and its query. */
export interface RequestFields {
  readonly body: Record<string, unknown>;
  readonly query: URLSearchParams;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The value at a dot path of a JSON body, or undefined. */
export function fieldAt(body: Record<string, unknown>, path: string): unknown {
  let value: unknown = body;
  for (const key of path.split(".")) {
    const record = asRecord(value);
    if (record === null || !Object.hasOwn(record, key)) return undefined;
    value = record[key];
  }
  return value;
}

/** A field's value: a body dot path, a form field (flat), or a query parameter. */
export function fieldValue(fields: RequestFields, ref: FieldRef): unknown {
  if (ref.in === "query") return fields.query.get(ref.field) ?? undefined;
  if (ref.in === "form") return Object.hasOwn(fields.body, ref.field) ? fields.body[ref.field] : undefined;
  return fieldAt(fields.body, ref.field);
}

/** The form fields an operation reads, besides its model and service mode: measures, price keys and outbound fields. */
export function requestFormFields(operation: OperationDescription): string[] {
  const refs: FieldRef[] = (operation.priceKeys ?? []).flatMap((key) => (key.answeredWhen === undefined ? [key.from] : [key.from, key.answeredWhen]));
  for (const ref of operation.unpricedOptions ?? []) refs.push(ref);
  for (const measure of requestMeasuresOf(operation.meter)) {
    if (measure.measure === "one") continue;
    refs.push({ in: "form", field: measure.field });
    if (measure.measure === "image_megapixels") refs.push({ in: "form", field: measure.size });
    if (measure.measure === "frames_seconds") refs.push({ in: "form", field: measure.fps });
  }
  for (const ref of outboundRemoved(operation)) refs.push(ref);
  return refs.filter((ref) => ref.in !== "query").map((ref) => ref.field);
}

/** A measure's raw amount from the request, before scaling, or null when the request does not give it. */
function measuredAmount(measure: RequestMeasure, fields: RequestFields, priceKind: string | undefined): number | null {
  if (measure.measure === "one") return 1;
  const value = fieldValue(fields, { in: "body", field: measure.field });
  switch (measure.measure) {
    case "characters":
      // Characters as a person counts them: code points, not UTF-16 units.
      return typeof value === "string" ? [...value].length : null;
    case "requested_seconds": {
      const seconds = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : (measure.default ?? null);
      return seconds !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
    }
    case "image_count":
      return imageCount(value, measure.default);
    case "image_megapixels": {
      const count = imageCount(value, measure.default);
      if (count === null) return null;
      return count * (megapixelsOf(fieldValue(fields, { in: "body", field: measure.size }), measure.sizes) ?? 1);
    }
    case "frames_seconds": {
      // Only a model priced as the measure's kind gets a length, and only when its request names its frame count.
      if (measure.forKind !== undefined && priceKind !== measure.forKind) return null;
      const frames = positiveNumber(value);
      if (frames === null) return null;
      const fps = positiveNumber(fieldValue(fields, { in: "body", field: measure.fps })) ?? measure.defaultFps;
      return fps > 0 ? frames / fps : null;
    }
  }
}

/** A positive finite number as the request writes it, a numeric string included, or null. */
function positiveNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : null;
  return number !== null && Number.isFinite(number) && number > 0 ? number : null;
}

/** A count of images as the request writes it, or the default. */
function imageCount(value: unknown, fallback: number | undefined): number | null {
  const count = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : (fallback ?? null);
  return count !== null && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** Pixels in one megapixel, as fal counts it. */
const MEGAPIXEL = 1024 * 1024;

/** The side fal uses for a width or height a size object leaves out (its `ImageSize` default). */
const DEFAULT_SIDE = 512;

/** One image's megapixels, rounded up: from `{ width, height }` or a listed size name. Null when the size is not known. */
function megapixelsOf(size: unknown, named: Readonly<Record<string, readonly [number, number]>> | undefined): number | null {
  let width: unknown;
  let height: unknown;
  if (typeof size === "string" && named !== undefined && Object.hasOwn(named, size)) [width, height] = named[size]!;
  else if (typeof size === "object" && size !== null && !Array.isArray(size)) {
    ({ width = DEFAULT_SIDE, height = DEFAULT_SIDE } = size as { width?: unknown; height?: unknown });
  }
  if (typeof width !== "number" || typeof height !== "number" || !(width > 0) || !(height > 0)) return null;
  const megapixels = Math.ceil((width * height) / MEGAPIXEL);
  return Number.isSafeInteger(megapixels) ? megapixels : null;
}

/**
 * A usage taken from the request alone: one count in one unit, no tokens. A
 * measure (characters, a requested length) is an estimate of what the
 * provider bills; a request count is exact.
 */
function requestUsageOf(counts: Readonly<Partial<Record<Unit, number>>>, estimated: boolean): UsageObservation {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    noTokens: true,
    units: counts,
    ...(estimated ? { estimatedUnits: Object.keys(counts) as Unit[] } : {}),
  };
}

/**
 * What an operation's meter measures from the request, or null when its
 * meter takes nothing from it, or the request does not give the measure.
 * A request count is always one request.
 */
export function requestUsage(operation: OperationDescription, fields: RequestFields, priceKind?: string): UsageObservation | null {
  if (operation.meter.kind === "request_count") return requestUsageOf({ requests: 1 }, false);
  // Every measure the request gives, each in its own unit; one it does not give is left out.
  const counts: Partial<Record<Unit, number>> = {};
  for (const measure of requestMeasuresOf(operation.meter)) {
    const amount = measuredAmount(measure, fields, priceKind);
    if (amount === null) continue;
    const count = scaledCount(measure.unit, amount);
    if (Number.isSafeInteger(count)) counts[measure.unit] = count;
  }
  return Object.keys(counts).length === 0 ? null : requestUsageOf(counts, true);
}

/** A price key value longer than this is treated as unknown, and never stored. */
const MAX_PRICE_KEY_VALUE = 100;

/**
 * Whether a switch field is on (`SwitchKind`): a `text` field when present
 * with any value, a `flag` when present with a value that is not false. A
 * repeated query field is on when any of its values is.
 */
export function switchedOn(fields: RequestFields, ref: FieldRef, kind: SwitchKind): boolean {
  const values = ref.in === "query" ? fields.query.getAll(ref.field) : [fieldValue(fields, ref)].filter((value) => value !== undefined);
  if (kind === "text") return values.length > 0;
  if (kind === "list") return values.some((value) => Array.isArray(value) && value.length > 0);
  return values.some((value) => !(value === null || value === false || value === "false" || value === ""));
}

/**
 * The values of an operation's price keys in the request, as text (a boolean
 * as `true` or `false`, as fal's `generate_audio`), with each key's default
 * where the request names none. A switch key (`kind`) is `true` or `false`,
 * never the request's own text. Any other value, or one longer than 100
 * characters, is left out: the price bills it as an unknown value. So is a
 * key the provider chooses for this request (`answeredWhen`): the answer's
 * value fills it (`answeredPriceKeys`).
 */
export function priceKeyValues(operation: OperationDescription, fields: RequestFields): Record<string, string> | undefined {
  const keys = operation.priceKeys;
  if (keys === undefined || keys.length === 0) return undefined;
  const values: Record<string, string> = {};
  for (const key of keys) {
    if (key.answeredWhen !== undefined && switchedOn(fields, key.answeredWhen, "flag")) continue;
    if (key.kind !== undefined) {
      values[key.name] = String(switchedOn(fields, key.from, key.kind));
      continue;
    }
    // A plain key named twice in the query is unknown: its dearest value bills, as an estimate.
    if (key.from.in === "query" && fields.query.getAll(key.from.field).length > 1) continue;
    const value = fieldValue(fields, key.from);
    const text =
      typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? String(value) : undefined;
    if (text !== undefined) {
      if (text.length <= MAX_PRICE_KEY_VALUE) values[key.name] = text;
    } else if (value === undefined && key.default !== undefined) values[key.name] = key.default;
  }
  return values;
}

/** The price keys the provider chooses for this request (`answeredWhen` on): the answer reports their values. */
export function answeredPriceKeys(operation: OperationDescription, fields: RequestFields): string[] {
  return (operation.priceKeys ?? []).filter((key) => key.answeredWhen !== undefined && switchedOn(fields, key.answeredWhen, "flag")).map((key) => key.name);
}

/**
 * When the provider may serve this request with another model than the one
 * asked for (`answeredWhen` on the model): the priced models each name its
 * answer may report stands for (`servedAs`). Null otherwise.
 */
function servedModels(operation: OperationDescription, fields: RequestFields): Readonly<Record<string, readonly string[]>> | null {
  const location = operation.model;
  if (location.in !== "query" || location.answeredWhen === undefined || !switchedOn(fields, location.answeredWhen, "flag")) return null;
  return location.servedAs ?? {};
}

/** What a request says about how it is billed, kept on its attempt (`CallAttempt`). */
export interface RequestFacts {
  /** What the meter measured from the request (`requestUsage`). */
  readonly requestUsage?: UsageObservation;
  /** The price key values (`priceKeyValues`). */
  readonly priceKeys?: Readonly<Record<string, string>>;
  /** Options billed on top at a price the gateway does not have: the charge is an estimate. */
  readonly unpricedOptions?: readonly string[];
  /** Price keys the provider chooses for this request: the answer's values are billed. */
  readonly answeredKeys?: readonly string[];
  /** The provider may serve another model: the priced models each reported name stands for. */
  readonly servedModels?: Readonly<Record<string, readonly string[]>>;
  /** The audio is billed once per channel (`perChannelWhen`). */
  readonly perChannel?: true;
  /** The provider may bill more than the request's measure (`inDoubtWhen`). */
  readonly measureInDoubt?: true;
}

/**
 * The one place a request's billing facts are worked out from its operation,
 * its fields (body and query) and its price, for the proxy and presets alike.
 * An option billed on top at a price the gateway lacks is logged here.
 */
export function requestFacts(
  operation: OperationDescription,
  fields: RequestFields,
  price: ModelPrice | null,
  logFacts: Readonly<Record<string, unknown>>,
): RequestFacts {
  const measured = requestUsage(operation, fields, price?.kind);
  const priceKeys = priceKeyValues(operation, fields);
  const unpriced = unpricedOptionsNamed(operation, fields, price);
  if (unpriced.length > 0) log("warn", "request_option_unpriced", { ...logFacts, options: unpriced.join(",") });
  const answered = answeredPriceKeys(operation, fields);
  const served = servedModels(operation, fields);
  const { meter } = operation;
  const perChannel = meter.kind === "response_json" && meter.perChannelWhen !== undefined && switchedOn(fields, meter.perChannelWhen, "flag");
  const doubtWhen = meter.kind === "response_header" ? meter.inDoubtWhen : undefined;
  const inDoubt = doubtWhen !== undefined && switchedOn(fields, doubtWhen, doubtWhen.kind);
  return {
    ...(measured !== null ? { requestUsage: measured } : {}),
    ...(priceKeys !== undefined ? { priceKeys } : {}),
    ...(unpriced.length > 0 ? { unpricedOptions: unpriced } : {}),
    ...(answered.length > 0 ? { answeredKeys: answered } : {}),
    ...(served !== null ? { servedModels: served } : {}),
    ...(perChannel ? { perChannel: true as const } : {}),
    ...(inDoubt ? { measureInDoubt: true as const } : {}),
  };
}

/**
 * The options a request turns on that the provider bills on top at a price
 * the gateway does not have (`unpricedOptions`), each read as its kind says
 * (`switchedOn`). An option a price key reads is priced when the price has
 * rates for that key (`by`), as our list has for Deepgram's redaction; a
 * customer's own rate without them leaves it unpriced.
 */
export function unpricedOptionsNamed(operation: OperationDescription, fields: RequestFields, price: ModelPrice | null): string[] {
  const named: string[] = [];
  for (const ref of operation.unpricedOptions ?? []) {
    if (!switchedOn(fields, ref, ref.kind)) continue;
    const key = operation.priceKeys?.find((one) => one.from.in === ref.in && one.from.field === ref.field);
    if (key !== undefined && price?.keyed?.[key.name] !== undefined) continue;
    named.push(ref.field);
  }
  return named;
}

/** Deletes a dot path from a JSON body. True if it was there. */
export function deleteAt(body: Record<string, unknown>, path: string): boolean {
  const keys = path.split(".");
  const last = keys.pop()!;
  const parent = keys.length === 0 ? body : asRecord(fieldAt(body, keys.join(".")));
  if (parent === null || !Object.hasOwn(parent, last)) return false;
  delete parent[last];
  return true;
}

/**
 * Writes a dot path into a JSON body, creating its parent objects, or
 * replacing a parent that is not an object. The one writer of a nested
 * field: serving providers pinned on a connection, and a listing's field
 * settings, both go through it.
 */
export function writeAt(body: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  let level = body;
  for (const key of keys) {
    const next = Object.hasOwn(level, key) ? level[key] : undefined;
    const object = typeof next === "object" && next !== null && !Array.isArray(next) ? (next as Record<string, unknown>) : {};
    setOwn(level, key, object);
    level = object;
  }
  setOwn(level, last, value);
}

/** Sets `key` as the object's own data property, so a name such as `__proto__` never reaches a prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Removes an operation's outbound form fields from a form about to be sent,
 * whatever path built it (the proxy rebuilding an upload, a preset copying
 * one). A no-op on a form without them.
 */
export function removeOutboundForm(operation: OperationDescription, form: FormData): void {
  for (const ref of outboundRemoved(operation)) if (ref.in === "form" || ref.in === "body") form.delete(ref.field);
}

/** Fields an operation removes before sending: every webhook field, fetch fields it does not need, and client credentials. */
function outboundRemoved(operation: OperationDescription): FieldRef[] {
  const outbound = operation.outbound;
  return [...(outbound?.webhooks ?? []), ...(outbound?.fetches ?? []), ...(outbound?.credentials ?? [])];
}

/**
 * Removes the operation's outbound fields from a request. A JSON body is
 * changed in place (pass null for a form); a query is returned without them, or null when it had
 * none of them, so it is sent as it came. A form's fields are
 * returned by name, for the caller to drop when it rebuilds the form.
 */
export function removeOutbound(
  operation: OperationDescription,
  body: Record<string, unknown> | null,
  query: URLSearchParams,
): { bodyChanged: boolean; query: URLSearchParams | null; formFields: string[] } {
  let bodyChanged = false;
  const kept = new URLSearchParams(query);
  let queryChanged = false;
  const formFields: string[] = [];
  for (const ref of outboundRemoved(operation)) {
    if (ref.in === "query") {
      queryChanged ||= kept.has(ref.field);
      kept.delete(ref.field);
    }
    // A form and a JSON body name a field the same way: each is dropped from either.
    else if (body === null) formFields.push(ref.field);
    else if (deleteAt(body, ref.field)) bodyChanged = true;
  }
  return { bodyChanged, query: queryChanged ? kept : null, formFields };
}
