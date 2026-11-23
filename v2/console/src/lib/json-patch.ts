/**
 * JSON Patch operations (RFC 6902) for what a form changed, and nothing
 * else. A form edits a deep copy of the stored value; comparing the copy with
 * what was stored gives one operation per field the person changed, so
 * fields they never touched, and fields a newer gateway wrote that this
 * console does not know, are never sent back rebuilt.
 */
import type { AppPatchOperation } from "@contracts/admin";

export type PatchOperation = AppPatchOperation;

/** One JSON Pointer segment, escaped. */
export function pointerSegment(key: string): string {
  return key.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The operations that turn `before` into `after` at `path`. Objects are
 * compared key by key; anything else, arrays included, is replaced whole when
 * it differs. `undefined` means absent: a key that appears is added, one that
 * goes is removed.
 */
export function diffOperations(path: string, before: unknown, after: unknown): PatchOperation[] {
  if (after === undefined) return before === undefined ? [] : [{ op: "remove", path }];
  if (before === undefined) return [{ op: "add", path, value: after }];
  if (isObject(before) && isObject(after)) {
    const operations: PatchOperation[] = [];
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) operations.push({ op: "remove", path: `${path}/${pointerSegment(key)}` });
    }
    for (const [key, value] of Object.entries(after)) {
      operations.push(...diffOperations(`${path}/${pointerSegment(key)}`, Object.hasOwn(before, key) ? before[key] : undefined, value));
    }
    return operations;
  }
  return same(before, after) ? [] : [{ op: "replace", path, value: after }];
}
