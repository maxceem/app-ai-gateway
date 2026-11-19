/**
 * Writes `openapi/openapi.json` from the catalog. With `--check`, fails
 * instead if the file on disk is not what the catalog makes. Never edit the
 * file by hand.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createOpenAPIDocument } from "../src/contracts/openapi.ts";

const directory = fileURLToPath(new URL("../openapi", import.meta.url));
const file = fileURLToPath(new URL("../openapi/openapi.json", import.meta.url));
const expected = `${JSON.stringify(createOpenAPIDocument(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const actual = await readFile(file, "utf8").catch(() => "");
  if (actual !== expected) {
    console.error("v2/openapi/openapi.json is out of date. Run: pnpm --filter @app-ai-gateway/gateway-v2 openapi:generate");
    process.exit(1);
  }
} else {
  await mkdir(directory, { recursive: true });
  await writeFile(file, expected);
  console.log(`Generated ${file}`);
}
