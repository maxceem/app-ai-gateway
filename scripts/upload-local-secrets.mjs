// DEPLOYMENT_ID is a public binding, never a masked secret.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { projectRoot, wranglerBin } from "./wrangler-config.mjs";
const values = parseEnv(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"));
delete values.DEPLOYMENT_ID;
const result = spawnSync(wranglerBin, ["secret", "bulk"], {
  cwd: projectRoot, input: JSON.stringify(values), stdio: ["pipe", "inherit", "inherit"],
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
