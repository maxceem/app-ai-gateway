/**
 * Writes `test/fixtures/elevenlabs-operations.json` from ElevenLabs' OpenAPI
 * document: the method, path and tags of every operation, sorted, and the
 * allowed values of each path parameter the spec lists them for. The
 * refused-path test walks it (`test/elevenlabs-refused.test.ts`), so a new
 * ElevenLabs endpoint is judged once this is run again.
 *
 *   node --experimental-strip-types scripts/elevenlabs-operations.ts <openapi.json>
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const METHODS = ["get", "post", "put", "patch", "delete"];
const source = process.argv[2];
if (source === undefined) {
  console.error("Usage: elevenlabs-operations.ts <ElevenLabs openapi.json>");
  process.exit(1);
}
type Schema = { $ref?: string; enum?: unknown[]; anyOf?: Schema[] };
type Parameter = { $ref?: string; name?: string; in?: string; schema?: Schema };
type Operation = { tags?: string[]; parameters?: Parameter[] };
const document = JSON.parse(await readFile(source, "utf8")) as { paths: Record<string, Record<string, unknown>> };

/** A `$ref`, followed to what it names. */
function resolve<T extends { $ref?: string }>(value: T): T {
  let current: unknown = value;
  while (typeof current === "object" && current !== null && typeof (current as { $ref?: unknown }).$ref === "string") {
    current = (current as { $ref: string }).$ref
      .replace(/^#\//u, "")
      .split("/")
      .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], document);
  }
  return current as T;
}

/** A path parameter's allowed values, where the spec lists them. */
function enumOf(schema: Schema | undefined): string[] {
  if (schema === undefined) return [];
  const resolved = resolve(schema);
  return [...(resolved.enum ?? []), ...(resolved.anyOf ?? []).flatMap((option) => resolve(option).enum ?? [])].filter((value): value is string => typeof value === "string");
}

const operations = Object.entries(document.paths)
  .flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, raw]) => {
        const operation = raw as Operation;
        const shared = ((item as { parameters?: Parameter[] }).parameters ?? []).map(resolve);
        const enums: Record<string, string[]> = {};
        for (const parameter of [...shared, ...(operation.parameters ?? []).map(resolve)]) {
          if (parameter.in !== "path" || parameter.name === undefined) continue;
          const values = enumOf(parameter.schema);
          if (values.length > 0) enums[parameter.name] = values;
        }
        const entry: unknown[] = [method.toUpperCase(), path, [...new Set(operation.tags ?? [])].sort()];
        if (Object.keys(enums).length > 0) entry.push(enums);
        return entry as [string, string, string[], Record<string, string[]>?];
      }),
  )
  .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1].localeCompare(b[1])));
const file = fileURLToPath(new URL("../test/fixtures/elevenlabs-operations.json", import.meta.url));
await writeFile(file, `[\n${operations.map((operation) => `  ${JSON.stringify(operation)}`).join(",\n")}\n]\n`);
console.log(`${operations.length} operations written to ${file}`);
