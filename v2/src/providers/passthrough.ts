/**
 * Passthrough paths (plan section 4.5): paths of a built-in provider that the
 * gateway does not declare, which a customer lists on a provider connection.
 *
 * - The connection lists each method and path, and optionally a flat price
 *   per request. Stored in `provider_connection.passthrough_json` as
 *   `{ "paths": [{ "method", "path", "price_nano"?, "style"?, "set_fields"? }], "auth"? }`.
 *   A custom provider (`./custom.ts`) stores how its key is sent in `auth`
 *   (`{ "header", "format" }`), and may name an API style per path.
 * - An app reaches them only when its route for that connection enables the
 *   `passthrough` operation. A path a connection lists later is never added
 *   to an app that did not ask for passthrough.
 * - A request is forwarded as it is, with the provider's key in its header,
 *   and charged as one call of the `passthrough` operation: the flat price
 *   for each answer the provider accepts, or `not_priced` without a price.
 * - A listing may set request fields over what the app sends
 *   (`set_fields`, plan section 4.5, "Safe defaults"). For a path the
 *   provider suggests values for (`suggestedPaths`), saving writes them in
 *   when the path is first listed; the customer may change or remove them.
 * - A path that mints a secret for a live session (a suggested path marked
 *   `liveToken`, plan D4) is charged as a `live_token` call, so it can be
 *   shown as not metered and not capped. Its request and answer are never
 *   cached (`../proxy/serve.ts`).
 *
 * Migration (plan section 9.1): a v1 listing of a suggested path gets its
 * suggested fields, as a new listing would.
 */
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { compilePassthrough, type CompiledPassthrough, type PassthroughPath } from "./matcher.ts";
import { deleteAt, writeAt } from "../proxy/request-fields.ts";
import type { FieldSetting, HttpMethod, OperationDescription, ProviderAuth } from "./operation.ts";

/** The operation name an app's route enables passthrough with, and the one its charges carry. */
export const PASSTHROUGH = "passthrough";

/**
 * The operation every passthrough request is charged as: one request, with
 * no model. Its price comes from the listed path (`resolvePassthrough`,
 * `../pricing/billability.ts`), never from a price list.
 */
export const PASSTHROUGH_OPERATION: OperationDescription = {
  name: PASSTHROUGH,
  // Never matched by this: each listed path is matched on its own.
  match: { method: "POST", path: PASSTHROUGH },
  lifecycle: "call",
  transport: "http",
  model: { in: "fixed", model: "" },
  meter: { kind: "request_count" },
};

/** The operation name a live-session token mint's charges carry (plan D4). */
export const LIVE_TOKEN = "live_token";

/** The operation a mint through a live-session token path is charged as: a passthrough call by another name. */
export const LIVE_TOKEN_OPERATION: OperationDescription = { ...PASSTHROUGH_OPERATION, name: LIVE_TOKEN };

export function isPassthrough(operation: OperationDescription): boolean {
  return operation === PASSTHROUGH_OPERATION || operation === LIVE_TOKEN_OPERATION;
}

export const PASSTHROUGH_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** A connection's listed paths, and a custom provider's key header, as stored. Null for neither. */
export function storedPassthrough(paths: readonly PassthroughPath[], auth: ProviderAuth | null = null): string | null {
  if (paths.length === 0 && auth === null) return null;
  return JSON.stringify({
    paths: paths.map((listed) => ({
      method: listed.method,
      path: listed.path,
      ...(listed.priceNano !== undefined ? { price_nano: listed.priceNano } : {}),
      ...(listed.style !== undefined ? { style: listed.style } : {}),
      ...(listed.setFields !== undefined && listed.setFields.length > 0 ? { set_fields: listed.setFields.map(storedField) } : {}),
    })),
    ...(auth === null ? {} : { auth: { header: auth.header, format: auth.format } }),
  });
}

/** A field setting as stored: the API's spelling. */
function storedField(field: FieldSetting): Record<string, unknown> {
  return {
    in: field.in,
    name: field.name,
    value: field.value,
    ...(field.as !== undefined ? { as: field.as } : {}),
    ...(field.aliases !== undefined && field.aliases.length > 0 ? { aliases: field.aliases } : {}),
  };
}

/** A stored field setting, read loosely, or null when it does not read. */
function readField(entry: unknown): FieldSetting | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { in: where, name, value, as, aliases } = entry as Record<string, unknown>;
  if ((where !== "body" && where !== "query") || typeof name !== "string" || !Object.hasOwn(entry, "value")) return null;
  return {
    in: where,
    name,
    value,
    ...(as === "time_from_now" ? { as } : {}),
    ...(Array.isArray(aliases) ? { aliases: aliases.filter((alias): alias is string => typeof alias === "string") } : {}),
  };
}

/** A stored `passthrough_json` as a value, or null when there is none or it does not read (logged). */
function storedValue(stored: unknown): Record<string, unknown> | null {
  if (stored === null || stored === undefined) return null;
  let value: unknown = stored;
  if (typeof stored === "string") {
    try {
      value = JSON.parse(stored) as unknown;
    } catch (error) {
      log("error", "passthrough_unreadable", { error: errorFacts(error) });
      return null;
    }
  }
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** A custom provider's stored key header and format, or null when there is none or it does not read. */
export function readCustomAuth(stored: unknown): ProviderAuth | null {
  const auth = storedValue(stored)?.auth;
  if (typeof auth !== "object" || auth === null) return null;
  const { header, format } = auth as Record<string, unknown>;
  return typeof header === "string" && typeof format === "string" ? { header, format } : null;
}

/**
 * A stored `passthrough_json`, read loosely: it was checked when saved. An
 * entry that does not read is left out and logged, so the rest still work.
 */
export function readPassthrough(stored: unknown): readonly PassthroughPath[] {
  const paths = storedValue(stored)?.paths;
  if (!Array.isArray(paths)) return [];
  const read: PassthroughPath[] = [];
  for (const entry of paths as unknown[]) {
    const { method, path, price_nano: priceNano, style, set_fields: setFields } = (entry ?? {}) as Record<string, unknown>;
    if (typeof method !== "string" || !(PASSTHROUGH_METHODS as readonly string[]).includes(method) || typeof path !== "string") {
      log("error", "passthrough_unreadable", { reason: "entry" });
      continue;
    }
    read.push({
      method: method as HttpMethod,
      path,
      ...(typeof priceNano === "number" ? { priceNano } : {}),
      ...(typeof style === "string" ? { style } : {}),
      ...(Array.isArray(setFields) ? { setFields: setFields.flatMap((field) => readField(field) ?? []) } : {}),
    });
  }
  return read;
}

const COMPILED = new WeakMap<readonly PassthroughPath[], readonly CompiledPassthrough[]>();

/**
 * A connection's listed passthrough paths, compiled once per loaded list. A
 * path that names an API style is an operation of a custom provider
 * (`./custom.ts`), not one of these. A path that no longer compiles is left
 * out and logged: it was checked when saved, so only a stricter rule in a
 * later release could do this.
 */
export function compiledPassthrough(paths: readonly PassthroughPath[]): readonly CompiledPassthrough[] {
  const cached = COMPILED.get(paths);
  if (cached !== undefined) return cached;
  const compiled = paths.flatMap((listed) => {
    if (listed.style !== undefined) return [];
    try {
      return compilePassthrough([listed]);
    } catch (error) {
      log("error", "passthrough_path_unusable", { error: errorFacts(error) });
      return [];
    }
  });
  COMPILED.set(paths, compiled);
  return compiled;
}

/**
 * A request with a listing's field settings applied (`set_fields`), over
 * whatever the app sent:
 *
 * - each body field's every spelling (`aliases`) is removed and its `name`
 *   written, nested parents created as needed, so the provider reads one
 *   value. An empty body, or JSON `null`, becomes an object of the settings
 *   alone. A body that is not a JSON object cannot carry them: `unreadable`,
 *   and the gateway refuses to send it rather than send it without them.
 * - each query parameter, and its aliases, holds only the setting's value.
 *
 * `same` when the listing sets no body field.
 */
export function applyFieldSettings(
  settings: readonly FieldSetting[],
  bytes: Uint8Array,
  search: string,
  now: number,
): { readonly body: { readonly kind: "same" } | { readonly kind: "set"; readonly bytes: Uint8Array } | { readonly kind: "unreadable" }; readonly search: string } {
  const query = settings.filter((setting) => setting.in === "query");
  let nextSearch = search;
  if (query.length > 0) {
    const params = new URLSearchParams(search);
    for (const setting of query) {
      for (const alias of setting.aliases ?? []) params.delete(alias);
      params.set(setting.name, String(settingValue(setting, now)));
    }
    const text = params.toString();
    nextSearch = text === "" ? "" : `?${text}`;
  }
  const fields = settings.filter((setting) => setting.in === "body");
  if (fields.length === 0) return { body: { kind: "same" }, search: nextSearch };
  let body: unknown = {};
  if (bytes.byteLength > 0) {
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      return { body: { kind: "unreadable" }, search: nextSearch };
    }
  }
  // JSON `null` carries nothing, like an empty body (ElevenLabs' schema allows it).
  if (body === null) body = {};
  if (typeof body !== "object" || Array.isArray(body)) return { body: { kind: "unreadable" }, search: nextSearch };
  const set = structuredClone(body) as Record<string, unknown>;
  for (const setting of fields) {
    for (const name of [setting.name, ...(setting.aliases ?? [])]) deleteAt(set, name);
    writeAt(set, setting.name, settingValue(setting, now));
  }
  return { body: { kind: "set", bytes: new TextEncoder().encode(JSON.stringify(set)) }, search: nextSearch };
}

/** The value a setting writes: as it is, or for `time_from_now`, the time that many seconds after `now`. */
function settingValue(setting: FieldSetting, now: number): unknown {
  if (setting.as === "time_from_now") return new Date(now + Number(setting.value) * 1000).toISOString();
  return setting.value;
}
