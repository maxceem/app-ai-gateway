import type { AppPatchOperation } from "../contracts/schemas";
import { GatewayError } from "../core/errors";

/**
 * Keys a patch may never name. A configuration is plain JSON, so none of these
 * is ever a real setting, and writing `__proto__` through an assignment would
 * replace an object's prototype rather than add a key.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** An array position as RFC 6901 writes one: digits, with no leading zero. */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A pointer's keys, with `~1` and `~0` decoded in the order RFC 6901 requires. */
function tokens(path: string): string[] {
  return path.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * The document with `operations` applied in order, as RFC 6902 defines `add`,
 * `replace` and `remove`. The input is not changed. An operation that cannot
 * apply — a parent that is not there, a `replace` or `remove` of nothing, an
 * array position past the end — refuses the whole patch with the operation's
 * index, so nothing half-applied is ever judged, let alone written.
 */
export function applyAppPatch<T extends Record<string, unknown>>(
  document: T,
  operations: readonly AppPatchOperation[],
): Record<string, unknown> {
  const result = structuredClone(document) as Record<string, unknown>;
  operations.forEach((operation, index) => {
    const refuse = (reason: string): never => {
      throw new GatewayError(400, "invalid_request", `operations[${index}] (${operation.op} ${operation.path}): ${reason}`);
    };
    const keys = tokens(operation.path);
    if (keys.some((key) => RESERVED_KEYS.has(key))) refuse("names a reserved key");
    let parent: unknown = result;
    for (const key of keys.slice(0, -1)) {
      const next = Array.isArray(parent)
        ? ARRAY_INDEX.test(key) ? parent[Number(key)] : undefined
        : isObject(parent) && Object.hasOwn(parent, key) ? parent[key] : undefined;
      if (next === undefined) refuse("its parent does not exist");
      parent = next;
    }
    const last = keys.at(-1)!;
    const value = "value" in operation ? structuredClone(operation.value) : undefined;
    if (Array.isArray(parent)) {
      const append = operation.op === "add" && last === "-";
      if (!append && !ARRAY_INDEX.test(last)) refuse("an array position is a number, or - to append");
      const position = append ? parent.length : Number(last);
      const limit = operation.op === "add" ? parent.length : parent.length - 1;
      if (position > limit) refuse(`the array has ${parent.length} entries`);
      if (operation.op === "add") parent.splice(position, 0, value);
      else if (operation.op === "replace") parent[position] = value;
      else parent.splice(position, 1);
      return;
    }
    if (!isObject(parent)) refuse("its parent is not an object or an array");
    const object = parent as Record<string, unknown>;
    if (operation.op !== "add" && !Object.hasOwn(object, last)) refuse("nothing is there");
    if (operation.op === "remove") delete object[last];
    else object[last] = value;
  });
  return result;
}
