import { deployCheckout } from './seamless-root.mjs';
// Deploys the gateway Worker.
//
//   pnpm run deploy                    # the tracked wrangler.jsonc, as one-click deploy uses it
//   pnpm run deploy --profile <name>   # wrangler.jsonc merged with wrangler.<name>.overlay.jsonc
//
// See scripts/wrangler-config.mjs for how profiles are resolved.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  createMissingGeneratedSecrets,
  deploymentIdFromVersion,
  deploymentVersionIds,
  missingRequiredSecrets,
  parseSecretList,
  requiredUserSecrets,
  resolveDeploymentId,
} from "./deploy-lib.mjs";
import {
  projectRoot,
  resolveWranglerConfig,
  takeProfileArgument,
  wranglerBin,
} from "./wrangler-config.mjs";

function parseArguments(argv) {
  const { profile, rest } = takeProfileArgument(argv);
  const action = rest[0] === "cleanup" ? "cleanup" : rest[0] === "rollback" ? "rollback" : "deploy";
  const rollbackId = action === "rollback" ? rest[1] : undefined;
  if (rest.length > (action === "deploy" ? 0 : action === "rollback" ? 2 : 1) || action === "rollback" && !rollbackId) {
    throw new Error(`Unexpected arguments: ${rest.join(" ")}\nUsage: pnpm run deploy [--profile <name>]`);
  }
  return { profile, action, rollbackId };
}

let profile;
let config;
let configPath;
let action;
let rollbackId;
let configArgs = [];
let deploymentId;
let localSecretsFile = ".dev.vars";
let localSecretsPath = join(projectRoot, localSecretsFile);

async function prepare(argv) {
  ({ profile, action, rollbackId } = parseArguments(argv));
  ({ config, configArgs, configPath } = resolveWranglerConfig(profile));
  localSecretsFile = profile ? `.dev.vars.${profile}` : ".dev.vars";
  localSecretsPath = join(projectRoot, localSecretsFile);
  const local = existsSync(localSecretsPath) ? parseEnv(readFileSync(localSecretsPath, "utf8")) : {};
  deploymentId = resolveDeploymentId(
    await readDeployedIds(),
    process.env.DEPLOYMENT_ID || config.vars?.DEPLOYMENT_ID,
    local.DEPLOYMENT_ID,
  );
}

async function readDeployedIds() {
  const result = await wrangler(["deployments", "list", "--json"], { capture: true, allowFailure: true });
  if (result.status !== 0) {
    // Cloudflare's specific Worker-not-found code. Authentication, network and
    // other lookup failures must never be interpreted as a fresh installation.
    if (/\[code: (?:10007|10090)\]/u.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) return [];
    throw new Error("Unable to inspect the deployed identity; check Wrangler authentication and retry");
  }
  const ids = [];
  for (const id of deploymentVersionIds(result.stdout)) {
    const version = await wrangler(["versions", "view", id, "--json"], { capture: true });
    ids.push(deploymentIdFromVersion(version.stdout));
  }
  return ids;
}

/**
 * Runs Wrangler without blocking the event loop, so the release lease's
 * heartbeat keeps renewing while preparation, migrations and deploys run.
 */
async function wrangler(args, options = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(wranglerBin, [...args, ...(args.includes("--config") ? [] : configArgs), ...(args[0] === "deploy" ? ["--var", `DEPLOYMENT_ID:${deploymentId}`] : [])], {
      cwd: projectRoot,
      env: process.env,
      stdio: options.capture
        ? ["ignore", "pipe", "pipe"]
        : options.input
          ? ["pipe", "inherit", "inherit"]
          : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
  });

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Wrangler exited with status ${result.status ?? "unknown"}`);
  }
  return result;
}

function workerDoesNotExist(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.includes("not found") && output.includes("wrangler deploy");
}

async function uploadLocalSecretsFile(allowedNames) {
  console.log(`Uploading the values from ${localSecretsFile}.`);
  const values = parseEnv(readFileSync(localSecretsPath, "utf8"));
  delete values.DEPLOYMENT_ID;
  await uploadSecrets(allowedNames ? Object.fromEntries(Object.entries(values).filter(([name]) => allowedNames.has(name))) : values);
}

async function listSecrets() {
  let result = await wrangler(["secret", "list", "--format", "json"], {
    allowFailure: true,
    capture: true,
  });

  if (result.status !== 0 && workerDoesNotExist(result) && existsSync(localSecretsPath)) {
    console.log("No deployed Worker found.");
    await uploadLocalSecretsFile();
    result = await wrangler(["secret", "list", "--format", "json"], {
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

async function uploadSecrets(secrets) {
  if (Object.keys(secrets).length === 0) return;
  await wrangler(["secret", "bulk"], { input: JSON.stringify(secrets) });
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

async function ensureDeploymentSecrets() {
  const required = requiredUserSecrets(config);
  let existingNames = await listSecrets();
  let missing = missingRequiredSecrets(existingNames, required);
  if (missing.length > 0 && existsSync(localSecretsPath)) {
    await uploadLocalSecretsFile(new Set(missing));
    existingNames = await listSecrets();
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
  await uploadSecrets(generated);
  if ("JWT_SECRET" in generated || "BETTER_AUTH_SECRET" in generated) {
    console.log("Generated and securely uploaded missing internal signing secrets.");
  } else {
    console.log("The internal signing secrets already exist; keeping them unchanged.");
  }
}

async function applyMigrations() {
  const args = ["d1", "migrations", "apply", "DB", "--remote"];
  const result = await wrangler(args, { allowFailure: true, capture: true });
  printCaptured(result);

  if (result.status === 0) return false;
  if (!databaseNeedsProvisioning(result)) {
    throw new Error("D1 migrations failed");
  }

  console.log("");
  console.log("The D1 database has not been provisioned yet; creating its binding first.");
  await wrangler(["deploy"]);
  await wrangler(args);
  return true;
}

async function deploy() {
  if (profile) console.log(`Deploying with the "${profile}" profile.`);
  await deployCheckout({ config, configPath, deploymentId, action, rollbackId,
    prepare: async (path, options) => { if (path) configArgs = ['--config', path]; if (action === 'deploy') { if (options?.initial) await wrangler(['deploy', '--config', path]); await ensureDeploymentSecrets(); return applyMigrations(); } },
    bootstrap: async path => {
      configArgs = ['--config', path];
      const probe = await wrangler(['d1', 'execute', 'DB', '--remote', '--command', 'SELECT 1', '--json'], { capture: true, allowFailure: true });
      if (probe.status === 0) return;
      if (!databaseNeedsProvisioning(probe)) throw new Error('Unable to inspect D1 before acquiring deployment lease');
      console.log('First installation: provisioning the primary Worker and D1 before acquiring the release lease. Retry this command if interrupted.');
      await wrangler(['deploy', '--config', path]);
    },
  });
}

try {
  await prepare(process.argv.slice(2));
  await deploy();
} catch (error) {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
