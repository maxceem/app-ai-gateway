/**
 * Writes `test/fixtures/elevenlabs-operations.json` from ElevenLabs' OpenAPI
 * document: the method, path and tags of every operation, sorted. The
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
const document = JSON.parse(await readFile(source, "utf8")) as { paths: Record<string, Record<string, { tags?: string[] }>> };
const operations = Object.entries(document.paths)
  .flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => METHODS.includes(method))
      .map(([method, operation]) => [method.toUpperCase(), path, [...new Set(operation.tags ?? [])].sort()] as const),
  )
  .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1].localeCompare(b[1])));
const file = fileURLToPath(new URL("../test/fixtures/elevenlabs-operations.json", import.meta.url));
await writeFile(file, `[\n${operations.map((operation) => `  ${JSON.stringify(operation)}`).join(",\n")}\n]\n`);
console.log(`${operations.length} operations written to ${file}`);
