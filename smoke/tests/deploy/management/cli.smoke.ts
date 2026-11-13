import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { need } from "../../../src/env.ts";
import { APP_NAMES, ENDPOINT_SLUG, PROVIDERS, TEMPORARY_PREFIX } from "../../../src/fixtures.ts";
import { admin } from "../../../src/gateway.ts";
import { MODEL } from "../../../src/mock/formats.ts";
import { env } from "../../support.ts";

const run = promisify(execFile);
const SMOKE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** Names the smoke checks after the CLI's own `user-agent`, whichever version runs. */
const CLI_AGENT = pathToFileURL(resolve(SMOKE_ROOT, "src/cli-agent.ts")).href;

/**
 * Where the CLI connects. The CLI accepts only HTTPS, or plain HTTP on a
 * loopback address, so a local gateway behind an `http://….localhost` name
 * needs SMOKE_CLI_URL set to its loopback address.
 */
const cliUrl = process.env.SMOKE_CLI_URL?.trim() || env.gatewayUrl;
const reachable = (() => {
  const { protocol, hostname } = new URL(cliUrl);
  return protocol === "https:" || hostname === "localhost" || hostname === "[::1]" || /^127\./u.test(hostname);
})();

/**
 * The CLI versions to run: `current` is the CLI built from this checkout, and
 * the others are published versions, such as the oldest one still supported.
 * That promise is kept by whoever monitors the deployment, not here, so a
 * change in this repository cannot quietly drop an old version.
 */
const versions = (process.env.SMOKE_CLI_VERSIONS?.trim() || "current")
  .split(",")
  .map((version) => version.trim())
  .filter(Boolean);

/** The `agw` entry point for a version: this checkout's build, or the published package, installed once. */
async function cliFor(version: string): Promise<string> {
  if (version === "current") {
    const built = resolve(SMOKE_ROOT, "../cli/dist/agw.mjs");
    if (!existsSync(built)) throw new Error("Build this checkout's CLI first: pnpm cli:build");
    return built;
  }
  const prefix = resolve(SMOKE_ROOT, ".state/cli", version);
  const entry = join(prefix, "node_modules/@maxceem/agw/dist/agw.mjs");
  if (!existsSync(entry)) {
    await run("npm", ["install", "--prefix", prefix, "--no-save", "--no-audit", "--no-fund", `@maxceem/agw@${version}`], {
      timeout: 120_000,
    });
  }
  return entry;
}

/**
 * Whether a version keeps configuration settings it does not know when it
 * saves. Releases up to 0.17.1 refuse to read an app that has one, so a newer
 * gateway's field in the fixture below would fail them for a reason that is
 * already known; every later release, and this checkout's, is held to it.
 */
function keepsUnknownSettings(version: string): boolean {
  if (version === "current") return true;
  const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/u).map(Number);
  return major > 0 || minor > 17 || (minor === 17 && patch > 1);
}

/**
 * An application that sets the optional configuration fields, each away from
 * its default. A release that adds an optional field adds it here too: this is
 * the configuration published CLIs are asked to read and write back intact.
 */
const EVERY_OPTION = {
  authentication: { type: "api_key", end_user: { source: "header", header: "x-smoke-user" } },
  routing: {
    providers: {
      mode: "selected",
      selected: {
        [PROVIDERS[0]!.slug]: {
          allowed_paths: [
            "v1/responses",
            { path: "v1/chat/completions", fixed_model: MODEL, clamp: "chat_completions" },
            // A passthrough path, opened for a method beyond the default POST.
            { path: "v1/files", methods: ["GET", "POST"] },
          ],
          allowed_models: [MODEL],
          max_output_tokens: 512,
        },
      },
    },
    model_rewrites: { "smoke-alias": MODEL },
  },
  limits: {
    per_user: { requests: { per_minute: 30, per_day: 1000 }, spending: { monthly_usd: 5, scope: "user" } },
    per_app: { requests: { per_minute: 600, per_day: null }, spending: { monthly_usd: 50 } },
  },
  endpoints: {
    [ENDPOINT_SLUG]: {
      provider: PROVIDERS[0]!.slug,
      model: MODEL,
      api_style: "responses",
      kind: "text",
      params: { temperature: 0 },
      max_output_tokens: 256,
    },
  },
  conversations: { store: false, keep: { images: false, audio: true, files: false }, retention_days: 30 },
};

const homes: string[] = [];
afterAll(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

for (const version of versions) {
  describe.skipIf(!reachable)(`agw ${version}`, () => {
    // A home of its own per version: no stored login, nothing shared with the
    // person running the tests, and only the management key in the environment.
    const home = mkdtempSync(join(tmpdir(), "agw-smoke-"));
    homes.push(home);
    const cli = cliFor(version);
    const agw = async (...args: string[]) => {
      try {
        const { stdout } = await run(process.execPath, ["--import", CLI_AGENT, await cli, ...args], {
          timeout: 60_000,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            XDG_STATE_HOME: join(home, "state"),
            XDG_CACHE_HOME: join(home, "cache"),
            XDG_CONFIG_HOME: join(home, "config"),
            NO_COLOR: "1",
            AGW_MANAGEMENT_KEY: need(env, "managementKey", "SMOKE_MANAGEMENT_KEY"),
          },
        });
        return stdout;
      } catch (error) {
        // With --json the CLI reports its refusal on stdout, as one JSON object.
        const { code, signal, stdout, stderr } = error as { code?: number; signal?: string; stdout?: string; stderr?: string };
        if (code === undefined && signal === undefined) throw error;
        const output = `${String(stdout ?? "")}${String(stderr ?? "")}`.trim().slice(0, 500);
        throw new Error(`agw ${version} ${args.join(" ")} ${signal ? `was stopped by ${signal}` : `exited ${code}`}: ${output}`);
      }
    };

    test("connects to the gateway and lists apps and providers", { timeout: 180_000 }, async () => {
      await agw("deployment", "connect", "--url", cliUrl, "--json");
      expect(await agw("app", "list", "--json")).toContain(APP_NAMES.server);
      expect(await agw("provider", "list", "--json")).toContain(PROVIDERS[0]!.slug);
    });

    test.skipIf(!keepsUnknownSettings(version))(
      "shows and renames an app that sets every optional field, writing its configuration back unchanged",
      { timeout: 180_000 },
      async () => {
        const name = `${TEMPORARY_PREFIX}${randomBytes(4).toString("hex")}`;
        const { app } = await admin<{ app: { id: string } }>(env, "POST", "/v1/admin/apps", { name, config: EVERY_OPTION });
        const path = `/v1/admin/apps/${encodeURIComponent(app.id)}`;
        try {
          const { app: before } = await admin<{ app: { config: unknown } }>(env, "GET", path);
          await agw("deployment", "connect", "--url", cliUrl, "--json");
          const shown = JSON.parse(await agw("app", "show", app.id, "--json")) as { ok: boolean };
          expect(shown.ok).toBe(true);
          await agw("app", "update", app.id, "--name", `${name}-renamed`, "--json", "--no-input");
          const { app: after } = await admin<{ app: { name: string; config: unknown } }>(env, "GET", path);
          expect(after.name).toBe(`${name}-renamed`);
          expect(after.config).toEqual(before.config);
        } finally {
          await admin(env, "DELETE", `${path}?confirm=${encodeURIComponent(app.id)}`);
        }
      },
    );
  });
}
