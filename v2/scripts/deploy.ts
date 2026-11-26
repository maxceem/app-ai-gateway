/**
 * Deploys v2's three Workers, in the order their bindings need (plan 9a):
 *
 *   1. the vault (`vault/`), which the gateway's `VAULT` binding names;
 *   2. the D1 migrations, then the gateway (this folder), with `RELAY_URL`;
 *   3. the relay (`relay/`), whose `MAIN` binding names the gateway.
 *
 *   node --experimental-strip-types scripts/deploy.ts [--profile <name>] [--prebuilt <dir>] [--dry-run]
 *
 * - `--profile <name>` uses each Worker's gitignored `wrangler.<name>.jsonc`
 *   (a full copy of its `wrangler.jsonc`); without it, the tracked files.
 * - `--prebuilt <dir>` deploys what `build-prebuilt.ts` built, and first checks
 *   that the vault's and the relay's files there are exactly the ones in git at
 *   `HEAD`: the release runs this from the tag, so they match the tag.
 * - `--dry-run` checks the configs and runs `wrangler deploy --dry-run` for
 *   each Worker. It changes nothing and needs no account.
 *
 * Before anything is deployed it refuses configs that don't fit together: a
 * binding that names the wrong Worker, a relay without its code-update setting
 * (without it a deploy cuts open sessions after 300 s), a kms vault with local
 * settings, or a vault setting on the gateway or the relay.
 *
 * `RELAY_URL` tells the gateway where apps reach the relay. It comes from the
 * gateway config's own `RELAY_URL` if set, else the relay's custom domain, else
 * what the gateway has now. When the relay's actual workers.dev address differs
 * (on a first install), the gateway is deployed once more with it.
 *
 * Secrets are not handled here: `secrets:upload` puts them on each Worker.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  deployedVar,
  deployProblems,
  fileHashes,
  hashDifferences,
  latestVersionIds,
  relayUrlFromConfig,
  relayUrlFromDeployOutput,
  type WorkerConfig,
} from "./deploy-lib.ts";

const USAGE = "usage: deploy.ts [--profile <name>] [--prebuilt <dir>] [--dry-run]";
const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_DIR = dirname(V2_DIR);
const CALLER_DIR = process.env.INIT_CWD ?? process.cwd();
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]*$/iu;
/** The plain-file Workers the prebuilt deploy uploads as they are. */
const PLAIN_WORKERS = ["vault", "relay"] as const;

function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}

let options: { profile?: string; prebuilt?: string; "dry-run"?: boolean };
try {
  options = parseArgs({
    args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
    strict: true,
    allowPositionals: false,
    options: { profile: { type: "string" }, prebuilt: { type: "string" }, "dry-run": { type: "boolean" } },
  }).values;
} catch (error) {
  refuse(`${(error as Error).message}\n${USAGE}`);
}
const profile = options.profile;
if (profile !== undefined && !PROFILE_PATTERN.test(profile)) refuse(`Invalid profile name "${profile}"`);
const prebuilt = options.prebuilt === undefined ? undefined : resolve(CALLER_DIR, options.prebuilt);
const dryRun = options["dry-run"] === true;

const wranglerBin = [process.env.APP_AI_GATEWAY_WRANGLER_BIN, join(V2_DIR, "node_modules/.bin/wrangler"), join(REPO_DIR, "node_modules/.bin/wrangler")]
  .find((path): path is string => path !== undefined && path !== "" && existsSync(path));
if (wranglerBin === undefined) refuse("Wrangler is not installed; run pnpm install first.");

const { experimental_readRawConfig } = await import("wrangler");
function readConfig(path: string): WorkerConfig {
  return (experimental_readRawConfig({ config: path }) as { rawConfig: WorkerConfig }).rawConfig;
}

function configPath(dir: string): string {
  const path = join(dir, profile === undefined ? "wrangler.jsonc" : `wrangler.${profile}.jsonc`);
  if (!existsSync(path)) refuse(`${relative(CALLER_DIR, path)} is missing. Each Worker needs its own copy for this profile.`);
  return path;
}

const paths = { main: configPath(V2_DIR), vault: configPath(join(V2_DIR, "vault")), relay: configPath(join(V2_DIR, "relay")) };
const configs = { main: readConfig(paths.main), vault: readConfig(paths.vault), relay: readConfig(paths.relay) };
const problems = deployProblems(configs.main, configs.vault, configs.relay);
if (problems.length > 0) refuse(["Nothing was deployed:", ...problems.map((p) => `- ${p}`)].join("\n"));

/**
 * Runs Wrangler with `config`. `output: "show"` prints as it goes; "echo" also
 * returns what was printed; "quiet" returns standard output without printing.
 */
function wrangler(args: string[], config: string, output: "show" | "echo" | "quiet" = "show"): string {
  const result = spawnSync(wranglerBin!, [...args, "--config", config], {
    cwd: dirname(config),
    encoding: "utf8",
    stdio: output === "show" ? "inherit" : ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (result.error) throw result.error;
  if (output === "echo") {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  if (result.status !== 0) {
    if (output === "quiet") process.stderr.write(result.stderr ?? "");
    throw new Error(`wrangler ${args.join(" ")} failed (${result.status})`);
  }
  return output === "echo" ? `${result.stdout ?? ""}\n${result.stderr ?? ""}` : (result.stdout ?? "");
}

/** Writes a config beside `original` (Wrangler resolves paths from it), changed by `change`. */
function generated(original: string, change: (config: Record<string, unknown>) => Record<string, unknown>): string {
  const raw = readConfig(original) as Record<string, unknown>;
  const path = join(dirname(original), `wrangler.${profile ?? "tracked"}.prebuilt.generated.jsonc`);
  writeFileSync(path, `// Generated by scripts/deploy.ts for a prebuilt deploy. Do not edit.\n${JSON.stringify(change(raw), null, 2)}\n`);
  return path;
}

/** The SHA-256 of every file under `dir` as git has it at `HEAD`. */
function gitHashes(dir: string): Map<string, string> {
  const prefix = relative(REPO_DIR, dir);
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", prefix], { cwd: REPO_DIR, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");
  return new Map(
    files.map((file) => [
      relative(prefix, file),
      createHash("sha256").update(execFileSync("git", ["show", `HEAD:${file}`], { cwd: REPO_DIR, maxBuffer: 64 * 1024 * 1024 })).digest("hex"),
    ]),
  );
}

/** The configs to deploy: the profile's, or ones pointed at the prebuilt files. */
function deployConfigs(): typeof paths {
  if (prebuilt === undefined) return paths;
  const worker = join(prebuilt, "worker", "index.js");
  const assets = join(prebuilt, "console");
  if (!existsSync(worker) || !existsSync(assets)) refuse(`${prebuilt} is not a prebuilt v2; build one with scripts/build-prebuilt.ts`);
  for (const name of PLAIN_WORKERS) {
    const differences = hashDifferences(gitHashes(join(V2_DIR, name, "src")), fileHashes(join(prebuilt, name, "src")));
    if (differences.length > 0) refuse([`The prebuilt ${name} files are not the ones in git at HEAD:`, ...differences.map((d) => `- ${d}`)].join("\n"));
  }
  console.log("The prebuilt vault and relay files match git at HEAD.");
  return {
    main: generated(paths.main, (config) => ({
      ...config,
      main: relative(dirname(paths.main), worker),
      no_bundle: true,
      assets: { ...(config.assets as object), directory: relative(dirname(paths.main), assets) },
    })),
    vault: generated(paths.vault, (config) => ({ ...config, main: relative(dirname(paths.vault), join(prebuilt, "vault", "src", "index.js")) })),
    relay: generated(paths.relay, (config) => ({ ...config, main: relative(dirname(paths.relay), join(prebuilt, "relay", "src", "index.js")) })),
  };
}

/** The `RELAY_URL` the gateway has now, if it is deployed. */
function currentRelayUrl(mainConfig: string): string | undefined {
  try {
    const id = latestVersionIds(wrangler(["deployments", "list", "--json"], mainConfig, "quiet"))[0];
    return id === undefined ? undefined : deployedVar(wrangler(["versions", "view", id, "--json"], mainConfig, "quiet"), "RELAY_URL");
  } catch {
    // A first install has no deployment yet; the relay's address is learned below.
    return undefined;
  }
}

try {
  const deploy = deployConfigs();
  if (dryRun) {
    mkdirSync(join(V2_DIR, "console", "dist"), { recursive: true });
    for (const name of ["vault", "main", "relay"] as const) wrangler(["deploy", "--dry-run"], deploy[name]);
    console.log("Dry run passed: vault, gateway and relay.");
  } else {
    if (profile !== undefined) console.log(`Deploying v2 with the "${profile}" profile.`);
    if (prebuilt === undefined) {
      const build = spawnSync("pnpm", ["--filter", "@app-ai-gateway/console-v2", "build"], { cwd: REPO_DIR, stdio: "inherit" });
      if (build.status !== 0) throw new Error("The console build failed");
    }
    wrangler(["deploy"], deploy.vault);
    wrangler(["d1", "migrations", "apply", "DB", "--remote"], paths.main);
    const configured = typeof configs.main.vars?.RELAY_URL === "string" && configs.main.vars.RELAY_URL !== "" ? configs.main.vars.RELAY_URL : undefined;
    const known = configured ?? relayUrlFromConfig(configs.relay) ?? currentRelayUrl(paths.main) ?? "";
    wrangler(["deploy", ...(known === "" ? [] : ["--var", `RELAY_URL:${known}`])], deploy.main);
    const relayOutput = wrangler(["deploy"], deploy.relay, "echo");
    const actual = configured ?? relayUrlFromConfig(configs.relay) ?? relayUrlFromDeployOutput(relayOutput, String(configs.relay.name));
    if (actual === undefined) {
      console.warn("The relay's address was not found in Wrangler's output; set RELAY_URL in the gateway config.");
    } else if (actual !== known) {
      console.log(`The relay is at ${actual}; deploying the gateway again with it.`);
      wrangler(["deploy", "--var", `RELAY_URL:${actual}`], deploy.main);
    }
    console.log(`Deployed the vault, the gateway and the relay${actual === undefined ? "" : ` (${actual})`}.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
