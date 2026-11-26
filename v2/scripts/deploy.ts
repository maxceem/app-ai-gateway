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
 * - `--prebuilt <dir>` (relative to the folder it runs in, `v2/` through
 *   `pnpm run`) deploys the gateway that `build-prebuilt.ts` built. The vault
 *   and the relay have no build: they are uploaded straight from this checkout.
 *   The release's deploy job checks out the tag fresh, so the vault and relay
 *   files it uploads are the tag's, by construction.
 * - `--dry-run` checks the configs and runs `wrangler deploy --dry-run` for
 *   each Worker. It changes nothing and needs no account.
 *
 * Before anything is deployed it refuses configs that don't fit together: a
 * binding that names the wrong Worker, a relay without its code-update setting
 * (without it a deploy cuts open sessions after 300 s), a kms vault with local
 * settings, a vault setting on the gateway or the relay, a vault or relay that
 * would be bundled, two Workers with one name, or a relay with no address to
 * give the gateway. A prebuilt deploy also refuses a config with a build
 * command or `base_dir`. Every Wrangler call passes `--env ""`, so a
 * `CLOUDFLARE_ENV` in the shell or a `.env` file never picks another
 * environment: the profiles are files, not Wrangler environments.
 *
 * `RELAY_URL` tells the gateway where apps reach the relay. It comes from the
 * gateway config's own `RELAY_URL` if set, else the relay's custom domain, else
 * what the gateway has now, read before anything is deployed. If that can't be
 * read for a gateway that exists, nothing is deployed. When the relay's actual
 * workers.dev address differs (on a first install), the gateway is deployed once
 * more with it.
 *
 * Secrets are not handled here: `secrets:upload` puts them on each Worker.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  deployedVar,
  deployProblems,
  latestVersionIds,
  prebuiltProblems,
  relayUrlFromConfig,
  sourceProblems,
  relayUrlFromDeployOutput,
  type WorkerConfig,
} from "./deploy-lib.ts";

const USAGE = "usage: deploy.ts [--profile <name>] [--prebuilt <dir>] [--dry-run]";
const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_DIR = dirname(V2_DIR);
/** Where relative paths start: the folder the command runs in (`v2/` through `pnpm run`). */
const CALLER_DIR = process.cwd();
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]*$/iu;

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
const problems = [
  ...deployProblems(configs.main, configs.vault, configs.relay),
  ...sourceProblems(V2_DIR, { vault: { path: paths.vault, config: configs.vault }, relay: { path: paths.relay, config: configs.relay } }),
];
if (problems.length > 0) refuse(["Nothing was deployed:", ...problems.map((p) => `- ${p}`)].join("\n"));

/**
 * The config, pinned to its top level. Wrangler reads `CLOUDFLARE_ENV` from the
 * shell or a `.env` file in each run and would then act on that environment;
 * `--env ""` makes it use the top-level config either way.
 */
function pinned(config: string): string[] {
  return ["--config", config, "--env", ""];
}

/** A failed Wrangler run, with what it printed. */
class WranglerError extends Error {
  readonly output: string;
  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}

/**
 * Runs Wrangler with `config`. `output: "show"` prints as it goes; "echo" also
 * returns what was printed; "quiet" returns standard output and prints nothing,
 * not even an error (the caller decides; the error carries the output).
 */
function wrangler(args: string[], config: string, output: "show" | "echo" | "quiet" = "show"): string {
  const result = spawnSync(wranglerBin!, [...args, ...pinned(config)], {
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
    throw new WranglerError(`wrangler ${args.join(" ")} failed (${result.status})`, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
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

/**
 * The configs to deploy: the profile's, with the gateway pointed at the
 * prebuilt bundle for a prebuilt deploy. The vault and the relay are always
 * the checked-out files, unbundled.
 */
function deployConfigs(): typeof paths {
  if (prebuilt === undefined) return paths;
  const worker = join(prebuilt, "worker", "index.js");
  const assets = join(prebuilt, "console");
  if (!existsSync(worker) || !existsSync(assets)) refuse(`${prebuilt} is not a prebuilt v2; build one with scripts/build-prebuilt.ts`);
  const buildProblems = prebuiltProblems(
    { gateway: configs.main, vault: configs.vault, relay: configs.relay },
    { profile: configs.main, tracked: readConfig(join(V2_DIR, "wrangler.jsonc")) },
  );
  if (buildProblems.length > 0) refuse(["Nothing was deployed:", ...buildProblems.map((p) => `- ${p}`)].join("\n"));
  return {
    main: generated(paths.main, (config) => ({
      ...config,
      main: relative(dirname(paths.main), worker),
      no_bundle: true,
      assets: { ...(config.assets as object), directory: relative(dirname(paths.main), assets) },
    })),
    vault: paths.vault,
    relay: paths.relay,
  };
}

/**
 * The `RELAY_URL` the gateway has now, or `undefined` when it has none: a first
 * install, or a gateway only `secrets:upload` has made so far. Any other
 * failure to read it is thrown, so a deploy never drops the gateway's address.
 */
function currentRelayUrl(mainConfig: string): string | undefined {
  try {
    const id = latestVersionIds(wrangler(["deployments", "list", "--json"], mainConfig, "quiet"))[0];
    return id === undefined ? undefined : deployedVar(wrangler(["versions", "view", id, "--json"], mainConfig, "quiet"), "RELAY_URL");
  } catch (error) {
    // Cloudflare's "this Worker does not exist" code: a first install.
    if (error instanceof WranglerError && /\[code: 10007\]/u.test(error.output)) return undefined;
    // Wrangler's own words name the real cause (a sign-in, the network, a changed format).
    if (error instanceof WranglerError) process.stderr.write(`${error.output.trim()}\n`);
    throw new Error("Could not read the gateway's current relay address; nothing was deployed. Check Wrangler's sign-in and try again.");
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
    // Read before anything changes: a failure here stops the deploy with nothing deployed.
    const configured = typeof configs.main.vars?.RELAY_URL === "string" && configs.main.vars.RELAY_URL !== "" ? configs.main.vars.RELAY_URL : undefined;
    const known = configured ?? relayUrlFromConfig(configs.relay) ?? currentRelayUrl(paths.main) ?? "";
    if (prebuilt === undefined) {
      const build = spawnSync("pnpm", ["--filter", "@app-ai-gateway/console-v2", "build"], { cwd: REPO_DIR, stdio: "inherit" });
      if (build.status !== 0) throw new Error("The console build failed");
    }
    wrangler(["deploy"], deploy.vault);
    wrangler(["d1", "migrations", "apply", "DB", "--remote"], paths.main);
    wrangler(["deploy", ...(known === "" ? [] : ["--var", `RELAY_URL:${known}`])], deploy.main);
    const relayOutput = wrangler(["deploy"], deploy.relay, "echo");
    const actual = configured ?? relayUrlFromConfig(configs.relay) ?? relayUrlFromDeployOutput(relayOutput, String(configs.relay.name));
    if (actual === undefined) {
      throw new Error("The relay's address was not found in Wrangler's output; set RELAY_URL in the gateway config and deploy again.");
    }
    if (actual !== known) {
      console.log(`The relay is at ${actual}; deploying the gateway again with it.`);
      wrangler(["deploy", "--var", `RELAY_URL:${actual}`], deploy.main);
    }
    console.log(`Deployed the vault, the gateway and the relay (${actual}).`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
