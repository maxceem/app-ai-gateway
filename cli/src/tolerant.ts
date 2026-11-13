/**
 * Reading what a newer gateway writes.
 *
 * A deployment is updated underneath the `agw` that manages it, and every
 * release may add an optional field to an application's configuration or a
 * value to one of its enums. The schemas this CLI was built with are strict, so
 * a plain parse refuses the whole answer for one setting it has never heard
 * of. `tolerant` is the second reading an answer gets after that refusal: it
 * accepts the document when everything wrong with it is something a newer
 * release could have added, and keeps those additions exactly as they were
 * sent, so a command that writes the configuration back resends them intact.
 *
 * What counts as an addition:
 *
 * - a key a strict object does not declare. Strict objects are the
 *   configuration grammar, which a client reads and writes back whole, so the
 *   key is kept. A non-strict object drops it, as a plain parse always has:
 *   those are read-only views, and dropping undeclared fields there is what
 *   keeps an unexpected server field off stdout;
 * - a string where an enum or a string literal is expected;
 * - a discriminator value no option of a discriminated union names, when every
 *   option is a strict object. The whole variant is then kept as sent.
 *
 * Anything else — a missing required field, a wrong type, a failed check on a
 * part with no addition in it — is a broken document and is refused as before.
 * A check on an object that holds an addition is not run, as zod does not run
 * it either: a newer field may be exactly what relaxes an older rule, and the
 * gateway, which knows the field, checks every write in full. Every subtree
 * that does parse is the plain parse's own output, defaults and normalization
 * included; only the spine above each addition is copied as it was sent.
 */

import type { z } from "zod";

/** A location in a JSON document, as zod reports one. */
export type Path = readonly PropertyKey[];

/** One setting this CLI does not know, and the value the document holds there. */
export interface Unknown {
  path: Path;
  value: unknown;
}

/** A tolerated document, and every addition it carried. */
export interface Tolerated<T> {
  data: T;
  unknown: Unknown[];
}

/** Thrown inside the walk at the first problem that is not an addition. */
class Broken extends Error {}

/**
 * The structural parts of a zod schema's definition this walk reads. Declared
 * here rather than reached through zod's internal types, which name every
 * schema kind and change between minor releases; `def` itself is public.
 */
interface Def {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  getter?: () => z.ZodType;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  keyType?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
  discriminator?: string;
  entries?: Record<string, unknown>;
  values?: unknown[];
}

const defOf = (schema: z.ZodType): Def => schema.def as unknown as Def;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrict = (schema: z.ZodType): boolean => {
  const def = defOf(schema);
  return def.type === "object" && def.catchall !== undefined && defOf(def.catchall).type === "never";
};

/**
 * The document, read as a newer gateway may have written it; `undefined` when
 * something in it is broken rather than new. A document that parses outright
 * comes back with no unknowns.
 */
export function tolerant<T>(schema: z.ZodType<T>, value: unknown): Tolerated<T> | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { data: parsed.data, unknown: [] };
  const unknown: Unknown[] = [];
  try {
    const data = walk(schema, value, [], unknown) as T;
    return unknown.length ? { data, unknown } : undefined;
  } catch (error) {
    if (error instanceof Broken) return undefined;
    throw error;
  }
}

function walk(schema: z.ZodType, value: unknown, path: Path, unknown: Unknown[]): unknown {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const before = unknown.length;
  const result = descend(schema, value, path, unknown);
  // The parse failed, so something below this node must account for it. When
  // nothing did, it was this node's own check — a refinement, a length — and
  // that is a broken document, not a newer one.
  if (unknown.length === before) throw new Broken();
  return result;
}

function descend(schema: z.ZodType, value: unknown, path: Path, unknown: Unknown[]): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "nonoptional":
      return walk(def.innerType!, value, path, unknown);
    case "pipe":
      // A transform cannot run on a value its input refused, so the input side
      // is what is kept.
      return walk(def.in!, value, path, unknown);
    case "lazy":
      return walk(def.getter!(), value, path, unknown);
    case "enum":
    case "literal": {
      const known = def.type === "enum" ? Object.values(def.entries ?? {}) : (def.values ?? []);
      if (typeof value !== "string" || !known.every((entry) => typeof entry === "string"))
        throw new Broken();
      unknown.push({ path, value });
      return value;
    }
    case "array": {
      if (!Array.isArray(value)) throw new Broken();
      return value.map((entry, index) => walk(def.element!, entry, [...path, index], unknown));
    }
    case "record": {
      if (!isRecord(value)) throw new Broken();
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (!def.keyType!.safeParse(key).success) throw new Broken();
        out[key] = walk(def.valueType!, entry, [...path, key], unknown);
      }
      return out;
    }
    case "object": {
      if (!isRecord(value)) throw new Broken();
      const shape = def.shape ?? {};
      const strict = isStrict(schema);
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) {
        const result = walk(field, value[key], [...path, key], unknown);
        if (result !== undefined || key in value) out[key] = result;
      }
      for (const [key, entry] of Object.entries(value)) {
        if (Object.hasOwn(shape, key)) continue;
        if (strict) {
          unknown.push({ path: [...path, key], value: entry });
          out[key] = structuredClone(entry);
        } else if (def.catchall !== undefined) {
          out[key] = walk(def.catchall, entry, [...path, key], unknown);
        }
        // A non-strict object drops what it does not declare, as a parse does.
      }
      return out;
    }
    case "union": {
      const options = def.options ?? [];
      if (def.discriminator !== undefined) {
        const tag = def.discriminator;
        if (!isRecord(value)) throw new Broken();
        const option = options.find((candidate) =>
          defOf(candidate).shape?.[tag]?.safeParse(value[tag]).success);
        if (option) return walk(option, value, path, unknown);
        if (typeof value[tag] !== "string" || !options.every(isStrict)) throw new Broken();
        // The whole variant is the addition: none of it can be read here, so a
        // change anywhere in it is a change to something this release does not know.
        unknown.push({ path, value });
        return structuredClone(value);
      }
      // The first option the document fits once its additions are set aside.
      for (const option of options) {
        const found: Unknown[] = [];
        try {
          const result = walk(option, value, path, found);
          unknown.push(...found);
          return result;
        } catch (error) {
          if (!(error instanceof Broken)) throw error;
        }
      }
      throw new Broken();
    }
    default:
      throw new Broken();
  }
}

/** A path as a person reads it: `config.routing.providers.selected.openai.allowed_paths[1].methods`. */
export function formatPath(path: Path): string {
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index ? "." : ""}${String(segment)}`)
    .join("");
}

/** The value a document holds at a path, or `undefined` when nothing is there. */
export function valueAt(document: unknown, path: Path): unknown {
  let current = document;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/** Whether two JSON values say the same thing, whatever order their keys came in. */
export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left))
    return Array.isArray(right) && left.length === right.length &&
      left.every((entry, index) => sameJson(entry, right[index]));
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
  }
  return false;
}
