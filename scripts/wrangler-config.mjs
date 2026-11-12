// Deployment profiles.
//
// `wrangler.jsonc` is the complete, ready-to-deploy configuration and the only
// one the repository tracks. A profile is a gitignored
// `wrangler.<profile>.overlay.jsonc` next to it that holds just the keys a
// particular deployment changes: a custom domain, a fixed D1 database, another
// vault mode, an extra service binding. The overlay is merged over the tracked
// file on every run, so shared sections such as Durable Object migrations are
// never copied and cannot drift.
//
// The merged result is written to `wrangler.<profile>.generated.jsonc` beside
// the sources (Wrangler resolves `main` and asset paths relative to the config
// file) and passed to Wrangler with `--config`.
//
// A prebuilt deployment (`--prebuilt <dir>`) deploys a Worker and console that
// were built earlier, by `scripts/build-prebuilt.mjs`, from the tracked file
// alone. The release builds them in a job without deploy secrets, so no
// package code runs where the secrets are; see `prebuiltWranglerConfig`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse, printParseErrorCode } from "jsonc-parser";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));
export const wranglerBin =
  process.env.APP_AI_GATEWAY_WRANGLER_BIN ?? join(projectRoot, "node_modules", ".bin", "wrangler");

const BASE_FILE = "wrangler.jsonc";
const OVERLAY_SUFFIX = ".overlay.jsonc";
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]*$/iu;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Objects merge recursively, arrays in the overlay replace the base array
 * wholesale, and `null` deletes a key. Small enough to reason about by eye.
 */
export function mergeWranglerConfig(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) {
      delete result[key];
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeWranglerConfig(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function readJsonc(path) {
  const errors = [];
  const value = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const [first] = errors;
    throw new Error(`${path}: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  return value;
}

export function overlayFileName(profile) {
  return `wrangler.${profile}${OVERLAY_SUFFIX}`;
}

export function listProfiles(dir = projectRoot) {
  return readdirSync(dir)
    .filter((name) => name.startsWith("wrangler.") && name.endsWith(OVERLAY_SUFFIX))
    .map((name) => name.slice("wrangler.".length, -OVERLAY_SUFFIX.length))
    .sort();
}

/**
 * Keys that decide how Wrangler builds the Worker rather than how it runs it.
 * A prebuilt Worker was built from the tracked file, so a profile that changes
 * one would deploy code built for other settings; `build` would even run a
 * command at deploy time.
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
];

/**
 * The configuration that deploys a prebuilt Worker: `config` (the tracked file,
 * with a profile merged over it) pointed at `<prebuilt>/worker/index.js`
 * without bundling, and at `<prebuilt>/console` for the static assets. Only
 * those built files come from `prebuilt`; everything else, such as the D1
 * migrations the deploy applies, still comes from this checkout.
 */
export function prebuiltWranglerConfig(base, config, prebuilt, dir = projectRoot) {
  for (const key of BUILD_KEYS) {
    if (!isDeepStrictEqual(config[key], base[key])) {
      throw new Error(
        `The deployment profile changes "${key}", which decides how the Worker is built, ` +
          `but a prebuilt Worker is built from ${BASE_FILE} alone. Set it in ${BASE_FILE} instead.`,
      );
    }
  }
  const worker = resolve(dir, prebuilt, "worker", "index.js");
  const assets = resolve(dir, prebuilt, "console");
  if (!existsSync(worker) || !existsSync(join(assets, "index.html"))) {
    throw new Error(`${prebuilt} is not a prebuilt gateway; build one with \`node scripts/build-prebuilt.mjs\``);
  }
  return {
    ...config,
    main: relative(dir, worker),
    no_bundle: true,
    assets: { ...config.assets, directory: relative(dir, assets) },
  };
}

/**
 * Resolves the Wrangler configuration for a profile. Without a profile (or a
 * prebuilt Worker) the tracked file is used as is and no extra CLI arguments
 * are needed.
 */
export function resolveWranglerConfig(profile, dir = projectRoot, { prebuilt } = {}) {
  const basePath = join(dir, BASE_FILE);
  const base = readJsonc(basePath);
  if (!profile && !prebuilt) return { config: base, configPath: basePath, configArgs: [] };
  if (!profile) return writeGenerated(dir, "prebuilt", prebuiltWranglerConfig(base, base, prebuilt, dir), [BASE_FILE]);

  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error(`Invalid deployment profile name "${profile}"`);
  }
  const overlayPath = join(dir, overlayFileName(profile));
  if (!existsSync(overlayPath)) {
    const available = listProfiles(dir);
    throw new Error(
      [
        `Deployment profile "${profile}" not found: expected ${overlayPath}`,
        available.length > 0
          ? `Available profiles: ${available.join(", ")}`
          : "No profiles exist yet; see the Deployment profiles section of the documentation.",
      ].join("\n"),
    );
  }

  const merged = mergeWranglerConfig(base, readJsonc(overlayPath));
  const sources = [BASE_FILE, basename(overlayPath)];
  return prebuilt
    ? writeGenerated(dir, `${profile}.prebuilt`, prebuiltWranglerConfig(base, merged, prebuilt, dir), sources)
    : writeGenerated(dir, profile, merged, sources);
}

function writeGenerated(dir, name, config, sources) {
  const configPath = join(dir, `wrangler.${name}.generated.jsonc`);
  writeFileSync(
    configPath,
    [
      `// Generated from ${sources.join(" and ")}. Do not edit;`,
      "// change the overlay instead. This file is ignored by git.",
      JSON.stringify(config, null, 2),
      "",
    ].join("\n"),
  );
  return { config, configPath, configArgs: ["--config", configPath] };
}

/**
 * Removes `--profile <name>` (or `--profile=<name>`) from an argument list.
 */
export function takeProfileArgument(args) {
  const rest = [];
  let profile;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile") {
      profile = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else {
      rest.push(arg);
    }
  }
  if (profile === "" || profile === undefined && args.includes("--profile")) {
    throw new Error("--profile requires a name");
  }
  return { profile, rest };
}
