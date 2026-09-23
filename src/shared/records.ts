/**
 * Safe indexed access for maps keyed by names a caller chooses.
 *
 * Provider slugs, model names, and endpoint slugs all reach these maps from a
 * request or from tenant configuration, and several of them are legal keys on
 * `Object.prototype`: `map["constructor"]` on a plain object answers with a
 * function nobody configured, and `map["__proto__"] = value` mutates the
 * prototype instead of storing anything. Both turn "not configured" into
 * something that looks configured. Every dynamic read goes through `lookup`,
 * and every map this codebase builds from such keys starts as `emptyRecord`.
 */

/** Reads `key` only if it was actually written; never answers from a prototype. */
export function lookup<T>(
  map: Record<string, T> | null | undefined,
  key: string,
): T | undefined {
  if (!map) return undefined;
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** A prototype-less map, so a key nobody wrote can never be found. */
export function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** `Object.fromEntries` without the inherited keys. */
export function recordFromEntries<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const result = emptyRecord<T>();
  for (const [key, value] of entries) result[key] = value;
  return result;
}

/**
 * A plain object, or `null` for anything else. The one test every reader of an
 * untrusted JSON document needs: arrays and primitives are not records, and
 * reading a named field off one would answer with an index or a character.
 *
 * `null` rather than a boolean guard because almost every caller wants the
 * narrowed value; {@link recordOr} is the same test where an absent object and
 * an empty one mean the same thing. `plainObject` in `endpointrules.ts` stays a
 * type *predicate* on purpose — the deep merge narrows two values at once, which
 * a returned value cannot express.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** {@link asRecord} with an empty record standing in for "not one". */
export function recordOr(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}
