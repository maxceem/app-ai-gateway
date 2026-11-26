/**
 * The pure parts of the v2 deploy (`deploy.ts`), kept apart so they can be
 * tested without Wrangler or an account.
 */
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * The keys that decide how Wrangler builds a Worker, not how it runs it. The
 * same list as v1's `BUILD_KEYS` in `scripts/wrangler-config.mjs`, copied
 * because that module needs a package the release's deploy job doesn't install.
 */
export const BUILD_KEYS = [
  "main",
  "compatibility_date",
  "compatibility_flags",
  "build",
  "alias",
  "define",
  "rules",
  "no_bundle",
  "minify",
  "find_additional_modules",
  "base_dir",
  "preserve_file_names",
  "tsconfig",
  "jsx_factory",
  "jsx_fragment",
] as const;

/** The setting the relay must always be deployed with (plan section 5.1). */
export const RELAY_CODE_UPDATE = { mode: "deferred", max_delay: 2400 } as const;

/** What the deploy reads from a Wrangler config. */
export interface WorkerConfig {
  name?: unknown;
  main?: unknown;
  vars?: Record<string, unknown>;
  services?: { binding?: unknown; service?: unknown; entrypoint?: unknown }[];
  routes?: unknown[];
  workers_dev?: unknown;
  build?: unknown;
  base_dir?: unknown;
  no_bundle?: unknown;
  durable_objects?: { code_update_strategy?: { mode?: unknown; max_delay?: unknown } };
}

function serviceFor(config: WorkerConfig, binding: string): string | undefined {
  const found = config.services?.find((service) => service.binding === binding)?.service;
  return typeof found === "string" ? found : undefined;
}

function entrypointFor(config: WorkerConfig, binding: string): unknown {
  return config.services?.find((service) => service.binding === binding)?.entrypoint;
}

/** The relay's and the vault's ticket key: the public half of the gateway's `RELAY_TICKET_PRIVATE_KEY`, 32 bytes of base64url. */
const TICKET_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Why these three configs can't be deployed together, or an empty list. Each
 * reason names the setting and what to change.
 */
export function deployProblems(main: WorkerConfig, vault: WorkerConfig, relay: WorkerConfig): string[] {
  const problems: string[] = [];
  for (const [label, config] of [["gateway", main], ["vault", vault], ["relay", relay]] as const) {
    if (typeof config.name !== "string" || config.name === "") problems.push(`The ${label} config names no Worker.`);
  }
  const names = [main.name, vault.name, relay.name].filter((name) => typeof name === "string" && name !== "");
  if (new Set(names).size !== names.length) problems.push("The gateway, the vault and the relay must each have their own Worker name.");
  if (serviceFor(main, "VAULT") !== vault.name) {
    problems.push(`The gateway's VAULT binding must name the vault Worker (${String(vault.name)}).`);
  }
  // The vault's key-opening entrypoint is the relay's alone (plan step 9a).
  if (entrypointFor(main, "VAULT") !== undefined) problems.push("The gateway's VAULT binding must use the vault's default entrypoint, never RelayKeys.");
  // Whatever its name: no gateway binding may reach the entrypoint that hands out keys.
  if ((main.services ?? []).some((service) => service.entrypoint === "RelayKeys")) {
    problems.push("The gateway must have no binding to the vault's RelayKeys entrypoint, under any name: only the relay may use it.");
  }
  if (serviceFor(relay, "MAIN") !== main.name || entrypointFor(relay, "MAIN") !== "RelayContract") {
    problems.push(`The relay's MAIN binding must name the gateway Worker (${String(main.name)}) with the entrypoint RelayContract.`);
  }
  if (serviceFor(relay, "VAULT") !== vault.name || entrypointFor(relay, "VAULT") !== "RelayKeys") {
    problems.push(`The relay's VAULT binding must name the vault Worker (${String(vault.name)}) with the entrypoint RelayKeys.`);
  }
  const relayKey = relay.vars?.RELAY_TICKET_PUBLIC_KEY;
  const vaultKey = vault.vars?.RELAY_TICKET_PUBLIC_KEY;
  if (typeof relayKey !== "string" || !TICKET_PUBLIC_KEY.test(relayKey) || relayKey !== vaultKey) {
    problems.push(
      "The relay and the vault must both set RELAY_TICKET_PUBLIC_KEY in their vars, to the same value: the public half of the gateway's " +
        "RELAY_TICKET_PRIVATE_KEY, which setup-local-secrets.ts prints.",
    );
  }
  const strategy = relay.durable_objects?.code_update_strategy;
  if (strategy?.mode !== RELAY_CODE_UPDATE.mode || strategy.max_delay !== RELAY_CODE_UPDATE.max_delay) {
    problems.push(
      `The relay config must set durable_objects.code_update_strategy to ${JSON.stringify(RELAY_CODE_UPDATE)}: ` +
        "without it a deploy cuts open sessions after 300 s.",
    );
  }
  for (const [label, config] of [["vault", vault], ["relay", relay]] as const) {
    if (config.no_bundle !== true) problems.push(`The ${label} config must set no_bundle: its plain files are uploaded as they are.`);
  }
  const vars = vault.vars ?? {};
  if (vars.SECRET_VAULT_MODE === "kms") {
    const local = Object.keys(vars).filter((name) => name.startsWith("SECRET_VAULT_LOCAL_"));
    if (local.length > 0) {
      problems.push(`A vault in kms mode must hold no local setting; remove ${local.join(", ")} from its vars.`);
    }
  }
  const configuredUrl = typeof main.vars?.RELAY_URL === "string" && main.vars.RELAY_URL !== "";
  if (!configuredUrl && relayUrlFromConfig(relay) === undefined && !hasWorkersDev(relay)) {
    problems.push("The relay has no custom domain and no workers.dev address; set RELAY_URL in the gateway config.");
  }
  for (const [label, config] of [["gateway", main], ["relay", relay]] as const) {
    const leaked = Object.keys(config.vars ?? {}).filter((name) => name.startsWith("SECRET_VAULT_"));
    if (leaked.length > 0) problems.push(`Only the vault holds the vault's settings; remove ${leaked.join(", ")} from the ${label} config.`);
  }
  return problems;
}

/**
 * Why the vault or the relay would upload files other than this checkout's
 * `vault/src/index.js` and `relay/src/index.js`: each config's `main`, read from
 * where the config file is, must point there. So their upload is the checked-out
 * source by construction, and `upload-local-secrets.ts` still recognises the vault.
 */
export function sourceProblems(v2Dir: string, workers: Record<"vault" | "relay", { path: string; config: WorkerConfig }>): string[] {
  const problems: string[] = [];
  for (const [label, { path, config }] of Object.entries(workers)) {
    const expected = join(v2Dir, label, "src", "index.js");
    if (typeof config.main !== "string" || resolve(dirname(path), config.main) !== expected) {
      problems.push(`The ${label} config's main must be ${label}/src/index.js in this checkout.`);
    }
  }
  return problems;
}

/** Whether Wrangler gives the Worker a workers.dev address (its default when it has no routes). */
export function hasWorkersDev(config: WorkerConfig): boolean {
  return config.workers_dev === true || (config.workers_dev === undefined && (config.routes ?? []).length === 0);
}

/**
 * Why these configs can't take a prebuilt deploy: one that builds at deploy
 * time, or moves where modules are collected from, would upload something
 * other than the built gateway and the checked-out vault and relay files.
 */
export function prebuiltProblems(configs: Record<string, WorkerConfig>, gateway?: { profile: WorkerConfig; tracked: WorkerConfig }): string[] {
  const problems: string[] = [];
  // The gateway was bundled from the tracked wrangler.jsonc alone, so a profile that builds it
  // differently would deploy code built for other settings.
  if (gateway !== undefined) {
    const record = (config: WorkerConfig) => config as Record<string, unknown>;
    for (const key of BUILD_KEYS) {
      if (!isDeepStrictEqual(record(gateway.profile)[key], record(gateway.tracked)[key])) {
        problems.push(`The gateway config changes "${key}", but a prebuilt gateway is built from wrangler.jsonc alone; set it there or deploy without --prebuilt.`);
      }
    }
  }
  for (const [label, config] of Object.entries(configs)) {
    if (config.build !== undefined) problems.push(`The ${label} config has a build command; a prebuilt deploy runs no build.`);
    if (config.base_dir !== undefined) problems.push(`The ${label} config sets base_dir; a prebuilt deploy collects modules only from the checked files.`);
  }
  return problems;
}

/** The relay's address from its config, when it has a custom domain. */
export function relayUrlFromConfig(relay: WorkerConfig): string | undefined {
  for (const route of relay.routes ?? []) {
    if (typeof route === "object" && route !== null && (route as { custom_domain?: unknown }).custom_domain === true) {
      const pattern = (route as { pattern?: unknown }).pattern;
      if (typeof pattern === "string" && pattern !== "") return `https://${pattern}`;
    }
  }
  return undefined;
}

/** The relay's workers.dev address, from what `wrangler deploy` printed. */
export function relayUrlFromDeployOutput(output: string, relayName: string): string | undefined {
  const escaped = relayName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return output.match(new RegExp(`https://${escaped}\\.[a-z0-9-]+\\.workers\\.dev`, "u"))?.[0];
}

/** A plain-text variable of a deployed version (`wrangler versions view --json`). */
export function deployedVar(versionJson: string, name: string): string | undefined {
  const bindings = (JSON.parse(versionJson) as { resources?: { bindings?: unknown } })?.resources?.bindings;
  if (!Array.isArray(bindings)) throw new Error("Unexpected Wrangler version bindings");
  const binding = bindings.find((b: { name?: unknown }) => b.name === name) as { type?: unknown; text?: unknown } | undefined;
  return binding?.type === "plain_text" && typeof binding.text === "string" && binding.text !== "" ? binding.text : undefined;
}

/** The newest deployment's version ids (`wrangler deployments list --json`). */
export function latestVersionIds(listJson: string): string[] {
  const deployments = JSON.parse(listJson) as { created_on?: unknown; versions?: { version_id?: unknown }[] }[];
  if (!Array.isArray(deployments)) throw new Error("Unexpected Wrangler deployment list");
  if (deployments.length === 0) return [];
  const latest = deployments.reduce((a, b) => (Date.parse(String(a.created_on)) >= Date.parse(String(b.created_on)) ? a : b));
  return [...new Set((latest.versions ?? []).map((v) => v.version_id).filter((id): id is string => typeof id === "string" && id !== ""))];
}
