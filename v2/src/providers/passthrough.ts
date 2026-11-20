/**
 * Passthrough paths (plan section 4.5): paths of a built-in provider that the
 * gateway does not declare, which a customer lists on a provider connection.
 *
 * - The connection lists each method and path, and optionally a flat price
 *   per request. Stored in `provider_connection.passthrough_json` as
 *   `{ "paths": [{ "method", "path", "price_nano"? }] }`.
 * - An app reaches them only when its route for that connection enables the
 *   `passthrough` operation. A path a connection lists later is never added
 *   to an app that did not ask for passthrough.
 * - A request is forwarded as it is, with the provider's key in its header,
 *   and charged as one call of the `passthrough` operation: the flat price
 *   for each answer the provider accepts, or `not_priced` without a price.
 */
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { compilePassthrough, type CompiledPassthrough, type PassthroughPath } from "./matcher.ts";
import type { HttpMethod, OperationDescription } from "./operation.ts";

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

export function isPassthrough(operation: OperationDescription): boolean {
  return operation === PASSTHROUGH_OPERATION;
}

export const PASSTHROUGH_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** A connection's listed paths, as stored. Null for none. */
export function storedPassthrough(paths: readonly PassthroughPath[]): string | null {
  if (paths.length === 0) return null;
  return JSON.stringify({
    paths: paths.map((listed) => ({
      method: listed.method,
      path: listed.path,
      ...(listed.priceNano !== undefined ? { price_nano: listed.priceNano } : {}),
    })),
  });
}

/**
 * A stored `passthrough_json`, read loosely: it was checked when saved. An
 * entry that does not read is left out and logged, so the rest still work.
 */
export function readPassthrough(stored: unknown): readonly PassthroughPath[] {
  if (stored === null || stored === undefined) return [];
  let value: unknown = stored;
  if (typeof stored === "string") {
    try {
      value = JSON.parse(stored) as unknown;
    } catch (error) {
      log("error", "passthrough_unreadable", { error: errorFacts(error) });
      return [];
    }
  }
  const paths = typeof value === "object" && value !== null ? (value as { paths?: unknown }).paths : undefined;
  if (!Array.isArray(paths)) return [];
  const read: PassthroughPath[] = [];
  for (const entry of paths as unknown[]) {
    const { method, path, price_nano: priceNano } = (entry ?? {}) as Record<string, unknown>;
    if (typeof method !== "string" || !(PASSTHROUGH_METHODS as readonly string[]).includes(method) || typeof path !== "string") {
      log("error", "passthrough_unreadable", { reason: "entry" });
      continue;
    }
    read.push({ method: method as HttpMethod, path, ...(typeof priceNano === "number" ? { priceNano } : {}) });
  }
  return read;
}

const COMPILED = new WeakMap<readonly PassthroughPath[], readonly CompiledPassthrough[]>();

/**
 * A connection's listed paths, compiled once per loaded list. A path that no
 * longer compiles is left out and logged: it was checked when saved, so only
 * a stricter rule in a later release could do this.
 */
export function compiledPassthrough(paths: readonly PassthroughPath[]): readonly CompiledPassthrough[] {
  const cached = COMPILED.get(paths);
  if (cached !== undefined) return cached;
  const compiled = paths.flatMap((listed) => {
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
