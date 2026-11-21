/**
 * Passthrough paths (plan section 4.5): paths of a built-in provider that the
 * gateway does not declare, which a customer lists on a provider connection.
 *
 * - The connection lists each method and path, and optionally a flat price
 *   per request. Stored in `provider_connection.passthrough_json` as
 *   `{ "paths": [{ "method", "path", "price_nano"?, "style"?, "live_token"? }], "auth"? }`.
 *   A custom provider (`./custom.ts`) stores how its key is sent in `auth`
 *   (`{ "header", "format" }`), and may name an API style per path.
 * - An app reaches them only when its route for that connection enables the
 *   `passthrough` operation. A path a connection lists later is never added
 *   to an app that did not ask for passthrough.
 * - A request is forwarded as it is, with the provider's key in its header,
 *   and charged as one call of the `passthrough` operation: the flat price
 *   for each answer the provider accepts, or `not_priced` without a price.
 * - A path that mints a secret for a live session (the provider's
 *   `liveTokens`, plan D4) is refused unless its listing opts in
 *   (`live_token: true`). It is charged as a `live_token` call instead, so
 *   it can be shown as not metered and not capped, and the window its secret
 *   may start a call in is locked where the provider lets the request set it.
 *
 * Migration (plan section 9.1): a v1 listing of a token path becomes a
 * listing with `live_token: true`, since v1 served it once listed.
 */
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { compilePassthrough, type CompiledPassthrough, type PassthroughPath } from "./matcher.ts";
import { LIVE_TOKEN_WINDOW_SECONDS, type HttpMethod, type LiveTokenForced, type LiveTokenValue, type OperationDescription, type ProviderAuth } from "./operation.ts";

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
      ...(listed.liveToken === true ? { live_token: true } : {}),
    })),
    ...(auth === null ? {} : { auth: { header: auth.header, format: auth.format } }),
  });
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
    const { method, path, price_nano: priceNano, style, live_token: liveToken } = (entry ?? {}) as Record<string, unknown>;
    if (typeof method !== "string" || !(PASSTHROUGH_METHODS as readonly string[]).includes(method) || typeof path !== "string") {
      log("error", "passthrough_unreadable", { reason: "entry" });
      continue;
    }
    read.push({
      method: method as HttpMethod,
      path,
      ...(typeof priceNano === "number" ? { priceNano } : {}),
      ...(typeof style === "string" ? { style } : {}),
      ...(liveToken === true ? { liveToken: true as const } : {}),
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
 * The body of a live-session mint, with every field `forced` names set as it
 * says, whatever the client sent. Every spelling of a field is removed and
 * only its first is written, so the provider reads one value; a nested
 * spelling gets its parent objects when the body has none. A mint that
 * forces no body field is sent as it is (`same`). An empty body, or JSON
 * `null`, becomes an object holding only the forced fields. A body that is not a JSON object
 * cannot carry them, so it is `unreadable`, and the gateway refuses to send
 * it rather than mint a secret it could not limit.
 */
export function lockedLiveTokenBody(
  forced: LiveTokenForced,
  bytes: Uint8Array,
  now: number,
): { readonly kind: "same" } | { readonly kind: "locked"; readonly bytes: Uint8Array } | { readonly kind: "unreadable" } {
  if (forced.fields === undefined) return { kind: "same" };
  let body: unknown = {};
  if (bytes.byteLength > 0) {
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      return { kind: "unreadable" };
    }
  }
  // JSON `null` carries nothing, like an empty body (ElevenLabs' schema allows it).
  if (body === null) body = {};
  if (!isObject(body)) return { kind: "unreadable" };
  const locked: Record<string, unknown> = { ...body };
  for (const field of forced.fields) {
    for (const name of field.names) removeField(locked, name.split("."));
    writeField(locked, field.names[0].split("."), forcedValue(field.value, now));
  }
  return { kind: "locked", bytes: new TextEncoder().encode(JSON.stringify(locked)) };
}

/** The query of a live-session mint, with every parameter `forced` names holding only the gateway's value. */
export function lockedLiveTokenQuery(forced: LiveTokenForced, search: string): string {
  if (forced.query === undefined) return search;
  const params = new URLSearchParams(search);
  for (const { name, value } of forced.query) params.set(name, value);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Removes a nested field, copying each parent object on the way so the client's own objects are never changed. */
function removeField(target: Record<string, unknown>, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (head === undefined || !Object.hasOwn(target, head)) return;
  if (rest.length === 0) {
    delete target[head];
    return;
  }
  const child = target[head];
  if (!isObject(child)) return;
  const copy = { ...child };
  target[head] = copy;
  removeField(copy, rest);
}

/** Writes a nested field, creating its parent objects, or replacing a parent that is not an object. */
function writeField(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const child = target[head];
  const copy: Record<string, unknown> = isObject(child) ? { ...child } : {};
  target[head] = copy;
  writeField(copy, rest, value);
}

function forcedValue(value: LiveTokenValue, now: number): unknown {
  if ("fixed" in value) return value.fixed;
  if (value.window === "expires_after") return { ...(value.anchor === true ? { anchor: "created_at" } : {}), seconds: LIVE_TOKEN_WINDOW_SECONDS };
  return new Date(now + LIVE_TOKEN_WINDOW_SECONDS * 1000).toISOString();
}
