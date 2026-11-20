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
import type { FieldRef, Meter, OperationDescription, RequestMeasure, Unit } from "../providers/operation.ts";
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
  const refs: FieldRef[] = [...(operation.priceKeys ?? []).map((key) => key.from)];
  const measure = requestMeasureOf(operation.meter);
  if (measure !== null) refs.push({ in: "form", field: measure.field });
  for (const ref of [...(operation.outbound?.webhooks ?? []), ...(operation.outbound?.fetches ?? [])]) refs.push(ref);
  return refs.filter((ref) => ref.in !== "query").map((ref) => ref.field);
}

/** The request measure a meter takes, if any. */
function requestMeasureOf(meter: Meter): (RequestMeasure & { readonly unit: Unit }) | null {
  if (meter.kind === "request_measure") return meter;
  if (meter.kind === "response_header") return meter.estimate ?? null;
  if (meter.kind === "response_json") return meter.requestMeasure ?? null;
  return null;
}

/** A measure's raw amount from the request, before scaling, or null when the request does not give it. */
function measuredAmount(measure: RequestMeasure, fields: RequestFields): number | null {
  const value = fieldValue(fields, { in: "body", field: measure.field });
  switch (measure.measure) {
    case "characters":
      // Characters as a person counts them: code points, not UTF-16 units.
      return typeof value === "string" ? [...value].length : null;
    case "requested_seconds": {
      const seconds = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : (measure.default ?? null);
      return seconds !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
    }
    case "image_count": {
      const count = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : (measure.default ?? null);
      return count !== null && Number.isSafeInteger(count) && count >= 0 ? count : null;
    }
  }
}

/** A usage worked out from the request alone: one count in one unit, no tokens. */
function requestUsageOf(unit: Unit, count: number): UsageObservation {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    noTokens: true,
    units: { [unit]: count },
    estimatedUnits: [unit],
  };
}

/**
 * What an operation's meter measures from the request, or null when its
 * meter takes nothing from it, or the request does not give the measure.
 * A request count is always one request.
 */
export function requestUsage(operation: OperationDescription, fields: RequestFields): UsageObservation | null {
  if (operation.meter.kind === "request_count") return requestUsageOf("requests", 1);
  const measure = requestMeasureOf(operation.meter);
  if (measure === null) return null;
  const amount = measuredAmount(measure, fields);
  return amount === null ? null : requestUsageOf(measure.unit, scaledCount(measure.unit, amount));
}

/**
 * The values of an operation's price keys in the request, as text, with each
 * key's default where the request names none. A value that is not a string
 * or a number is left out: the price bills it as an unknown value.
 */
export function priceKeyValues(operation: OperationDescription, fields: RequestFields): Record<string, string> | undefined {
  const keys = operation.priceKeys;
  if (keys === undefined || keys.length === 0) return undefined;
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = fieldValue(fields, key.from);
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) values[key.name] = String(value);
    else if (value === undefined && key.default !== undefined) values[key.name] = key.default;
  }
  return values;
}

/** Deletes a dot path from a JSON body. True if it was there. */
function deleteAt(body: Record<string, unknown>, path: string): boolean {
  const keys = path.split(".");
  const last = keys.pop()!;
  const parent = keys.length === 0 ? body : asRecord(fieldAt(body, keys.join(".")));
  if (parent === null || !Object.hasOwn(parent, last)) return false;
  delete parent[last];
  return true;
}

/**
 * Removes an operation's outbound form fields from a form about to be sent,
 * whatever path built it (the proxy rebuilding an upload, a preset copying
 * one). A no-op on a form without them.
 */
export function removeOutboundForm(operation: OperationDescription, form: FormData): void {
  for (const ref of outboundRemoved(operation)) if (ref.in === "form" || ref.in === "body") form.delete(ref.field);
}

/** Whether an operation removes any field of a form, so its uploads must be read and rebuilt. */
export function removesFormFields(operation: OperationDescription): boolean {
  return outboundRemoved(operation).some((ref) => ref.in !== "query");
}

/** Fields an operation removes before sending: every webhook field, and fetch fields it does not need. */
function outboundRemoved(operation: OperationDescription): FieldRef[] {
  return [...(operation.outbound?.webhooks ?? []), ...(operation.outbound?.fetches ?? [])];
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
    // A form names a body field the same way: both are dropped from a form.
    else if (ref.in === "form" || body === null) formFields.push(ref.field);
    else if (deleteAt(body, ref.field)) bodyChanged = true;
  }
  return { bodyChanged, query: queryChanged ? kept : null, formFields };
}
