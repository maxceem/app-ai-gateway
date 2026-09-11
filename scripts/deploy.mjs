// Deploys the gateway Worker.
//
//   pnpm run deploy                    # the tracked wrangler.jsonc, as one-click deploy uses it
//   pnpm run deploy --profile <name>   # wrangler.jsonc merged with wrangler.<name>.overlay.jsonc
//
// See scripts/wrangler-config.mjs for how profiles are resolved.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  createMissingGeneratedSecrets,
  missingRequiredSecrets,
  parseSecretList,
  requiredUserSecrets,
} from "./deploy-lib.mjs";
import {
  projectRoot,
  resolveWranglerConfig,
  takeProfileArgument,
  wranglerBin,
} from "./wrangler-config.mjs";

function parseArguments(argv) {
  const { profile, rest } = takeProfileArgument(argv);
  if (rest.length > 0) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}\nUsage: pnpm run deploy [--profile <name>]`);
  }
  return { profile };
}

let profile;
let config;
let configArgs = [];
let localSecretsFile = ".dev.vars";
let localSecretsPath = join(projectRoot, localSecretsFile);

function prepare(argv) {
  ({ profile } = parseArguments(argv));
  ({ config, configArgs } = resolveWranglerConfig(profile));
  localSecretsFile = profile ? `.dev.vars.${profile}` : ".dev.vars";
  localSecretsPath = join(projectRoot, localSecretsFile);
}

function wrangler(args, options = {}) {
  const result = spawnSync(wranglerBin, [...args, ...configArgs], {
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

function uploadLocalSecretsFile() {
  console.log(`Uploading the values from ${localSecretsFile}.`);
  wrangler(["secret", "bulk", localSecretsFile]);
}

function listSecrets() {
  let result = wrangler(["secret", "list", "--format", "json"], {
    allowFailure: true,
    capture: true,
  });

  if (result.status !== 0 && workerDoesNotExist(result) && existsSync(localSecretsPath)) {
    console.log("No deployed Worker found.");
    uploadLocalSecretsFile();
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
  const required = requiredUserSecrets(config);
  let existingNames = listSecrets();
  let missing = missingRequiredSecrets(existingNames, required);
  if (missing.length > 0 && existsSync(localSecretsPath)) {
    uploadLocalSecretsFile();
    existingNames = listSecrets();
    missing = missingRequiredSecrets(existingNames, required);
  }
  if (missing.length > 0) {
    throw new Error(
      [
        `Missing required deployment values: ${missing.join(", ")}`,
        `Use the Deploy to Cloudflare form, or put the values in ${localSecretsFile}`,
        "and run the deployment again from this checkout.",
      ].join("\n"),
    );
  }

  const generated = createMissingGeneratedSecrets(existingNames);
  uploadSecrets(generated);
  if ("JWT_SECRET" in generated || "BETTER_AUTH_SECRET" in generated) {
    console.log("Generated and securely uploaded missing internal signing secrets.");
  } else {
    console.log("The internal signing secrets already exist; keeping them unchanged.");
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
  if (profile) console.log(`Deploying with the "${profile}" profile.`);
  ensureDeploymentSecrets();
  const deployedWhileProvisioning = applyMigrations();
  if (!deployedWhileProvisioning) wrangler(["deploy"]);
}

try {
  prepare(process.argv.slice(2));
  deploy();
} catch (error) {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
