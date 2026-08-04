import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outputPath = fileURLToPath(new URL("../openapi/openapi.json", import.meta.url));
const before = readFileSync(outputPath, "utf8");
const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/generate-openapi.ts"], {
  cwd: projectRoot,
  encoding: "utf8",
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const after = readFileSync(outputPath, "utf8");
if (before !== after) {
  console.error("openapi/openapi.json is stale. Run `pnpm openapi:generate` and commit the result.");
  process.exit(1);
}

console.log("OpenAPI document is up to date.");
