import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createMissingGeneratedSecrets,
  missingRequiredSecrets,
  parseSecretList,
} from "./deploy-lib.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const localSecretsPath = fileURLToPath(new URL("../.dev.vars", import.meta.url));
const wranglerBin =
  process.env.AI_GATEWAY_WRANGLER_BIN ??
  fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));

function wrangler(args, options = {}) {
  const result = spawnSync(wranglerBin, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
    input: options.input,
    stdio: options.capture
      ? ["ignore", "pipe", "pipe"]
      : options.input
        ? ["pipe", "inherit", "inherit"]
        : "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Wrangler exited with status ${result.status ?? "unknown"}`);
  }
  return result;
}

function workerDoesNotExist(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.includes("not found") && output.includes("wrangler deploy");
}

function listSecrets() {
  let result = wrangler(["secret", "list", "--format", "json"], {
    allowFailure: true,
    capture: true,
  });

  if (result.status !== 0 && workerDoesNotExist(result) && existsSync(localSecretsPath)) {
    console.log("No deployed Worker found; uploading the values from .dev.vars first.");
    wrangler(["secret", "bulk", ".dev.vars"]);
    result = wrangler(["secret", "list", "--format", "json"], {
      allowFailure: true,
      capture: true,
    });
  }

  if (result.status !== 0) {
    if (workerDoesNotExist(result)) return new Set();
    process.stderr.write(result.stderr ?? "");
    throw new Error("Unable to inspect the Worker's configured secrets");
  }

  return parseSecretList(result.stdout);
}

function uploadSecrets(secrets) {
  if (Object.keys(secrets).length === 0) return;
  wrangler(["secret", "bulk"], { input: JSON.stringify(secrets) });
}

function printCaptured(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function databaseNeedsProvisioning(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.includes("Couldn't find")
    && output.includes("D1 DB")
    && (output.includes("wrangler d1 create") || output.includes("wrangler deploy"));
}

function ensureDeploymentSecrets() {
  const existingNames = listSecrets();
  const missing = missingRequiredSecrets(existingNames);
  if (missing.length > 0) {
    throw new Error(
      [
        `Missing required deployment values: ${missing.join(", ")}`,
        "Use the Deploy to Cloudflare form, or put the values in .dev.vars and run",
        "`pnpm run secrets:upload` before deploying from a local checkout.",
      ].join("\n"),
    );
  }

  const generated = createMissingGeneratedSecrets(existingNames);
  uploadSecrets(generated);
  if ("JWT_SECRET" in generated) {
    console.log("Generated and securely uploaded the internal JWT signing secret.");
  } else {
    console.log("The internal JWT signing secret already exists; keeping it unchanged.");
  }
}

function applyMigrations() {
  const args = ["d1", "migrations", "apply", "DB", "--remote"];
  const result = wrangler(args, { allowFailure: true, capture: true });
  printCaptured(result);

  if (result.status === 0) return false;
  if (!databaseNeedsProvisioning(result)) {
    throw new Error("D1 migrations failed");
  }

  console.log("");
  console.log("The D1 database has not been provisioned yet; creating its binding first.");
  wrangler(["deploy"]);
  wrangler(args);
  return true;
}

function deploy() {
  ensureDeploymentSecrets();
  const deployedWhileProvisioning = applyMigrations();
  if (!deployedWhileProvisioning) wrangler(["deploy"]);
}

try {
  deploy();
} catch (error) {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
