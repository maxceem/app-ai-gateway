/**
 * JSON Patch operations (RFC 6902) for what a form changed, and nothing
 * else. A form edits a deep copy of the stored value; comparing the copy with
 * what was stored gives one operation per field the person changed, so
 * fields they never touched, and fields a newer gateway wrote that this
 * console does not know, are never sent back rebuilt.
 */
import { APP_PATCH_MAX_OPERATIONS, type AppPatchOperation } from "@contracts/admin";
import { sameJson } from "@contracts/canonical-json";

export type PatchOperation = AppPatchOperation;

/** Keys the gateway refuses in a patch path; a change under one replaces the object holding it instead. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** One JSON Pointer segment, escaped. */
export function pointerSegment(key: string): string {
  return key.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Equal as the gateway compares them: key order aside, array order kept. */
const same = sameJson;

/**
 * The operations that turn `before` into `after` at `path`, descending at
 * most `depth` objects. Objects are compared key by key; anything else,
 * arrays included, is replaced whole when it differs, and so is an object
 * that changed below `depth` or holds a key a patch path cannot name.
 * `undefined` means absent: a key that appears is added, one that goes is removed.
 */
function diff(path: string, before: unknown, after: unknown, depth: number): PatchOperation[] {
  if (after === undefined) return before === undefined ? [] : [{ op: "remove", path }];
  if (before === undefined) return [{ op: "add", path, value: after }];
  if (same(before, after)) return [];
  if (!isObject(before) || !isObject(after) || depth === 0) return [{ op: "replace", path, value: after }];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  if ([...keys].some((key) => RESERVED_KEYS.has(key))) return [{ op: "replace", path, value: after }];
  const operations: PatchOperation[] = [];
  for (const key of keys) {
    const child = `${path}/${pointerSegment(key)}`;
    operations.push(
      ...diff(child, Object.hasOwn(before, key) ? before[key] : undefined, Object.hasOwn(after, key) ? after[key] : undefined, depth - 1),
    );
  }
  return operations;
}

/**
 * The operations for a form's change, as few as the gateway takes in one
 * request: the finest that fit within its limit, coarser (whole objects
 * replaced) when a change touches more fields than that.
 */
export function diffOperations(path: string, before: unknown, after: unknown, max = APP_PATCH_MAX_OPERATIONS): PatchOperation[] {
  for (let depth = 64; depth >= 0; depth -= 1) {
    const operations = diff(path, before, after, depth);
    if (operations.length <= max) return operations;
  }
  return diff(path, before, after, 0);
}
