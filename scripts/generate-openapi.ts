import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createOpenAPIDocument } from "../src/contracts/openapi.ts";

const outputDirectory = fileURLToPath(new URL("../openapi", import.meta.url));
const outputPath = fileURLToPath(new URL("../openapi/openapi.json", import.meta.url));
const document = createOpenAPIDocument();

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Generated ${outputPath}`);
