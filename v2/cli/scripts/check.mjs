import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// `tsgo` rather than `node --check`: the CLI is TypeScript now, and syntax was
// never what these files needed checking for. The same compiler the rest of the
// repository uses, over `cli/tsconfig.json`, which covers `src` and `test`.
const result = spawnSync(
  fileURLToPath(new URL("../node_modules/.bin/tsgo", import.meta.url)),
  ["--noEmit", "--project", fileURLToPath(new URL("../", import.meta.url))],
  { stdio: "inherit" },
);
if (result.status) process.exit(result.status);
await import("./build.mjs");
