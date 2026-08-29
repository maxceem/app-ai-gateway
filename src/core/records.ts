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
