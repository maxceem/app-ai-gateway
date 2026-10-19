import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seamlessRelease, type ReleaseInput } from "../../scripts/seamless.ts";
import { CliError } from "./common.ts";
import { resultOf, type CloudflareClient, type WorkerSettings } from "./cloudflare.ts";
import type { ReleaseArtifact } from "./release.ts";
import type { InstallationJournal } from "./state.ts";

export async function deployRelease(
  cf: CloudflareClient,
  journal: InstallationJournal,
  artifact: ReleaseArtifact,
  file: { path: string; directory: string; config: Record<string, unknown> },
  prepare: () => Promise<void>,
  deployMain: (buildId: string, signal: AbortSignal) => Promise<void>,
  action: ReleaseInput["action"] = "deploy",
  rollbackId?: string,
) {
  const vars = (file.config.vars ??= {}) as Record<string, unknown>;
  const seamless = vars.REALTIME_RELEASES === "seamless";
  // Deployed as resolved, so the gateway routes sessions the way this release
  // records them, whatever an earlier dashboard edit left behind.
  vars.REALTIME_RELEASES = seamless ? "seamless" : "simple";
  const subdomain = (
    await resultOf<{ subdomain?: string }>(cf, `/accounts/${journal.accountId}/workers/subdomain`)
  ).subdomain;
  if (seamless && !subdomain) {
    throw new Error(
      "Seamless realtime releases are served on workers.dev: enable your workers.dev subdomain, " +
        "or deploy with --realtime-releases simple",
    );
  }
  const realtimeConfig = JSON.parse(
    await readFile(join(artifact.directory, "wrangler.realtime.json"), "utf8"),
  ) as ReleaseInput["realtimeConfig"];
  const fallback = subdomain ? `https://${journal.name}.${subdomain}.workers.dev` : undefined;
  const configuredOrigin = vars.PUBLIC_API_URL || vars.CLI_CONSOLE_ORIGIN || journal.url || fallback || "";
  return seamlessRelease(
    {
      config: { ...file.config, name: journal.name },
      configPath: file.path,
      realtimeConfig,
      realtimeBundle: join(file.directory, "release", "realtime", "worker.js"),
      mainBundle: join(file.directory, "release", "worker", "index.js"),
      version: artifact.manifest.version,
      gatewayOrigin: String(configuredOrigin) || undefined,
      subdomain,
      seamless,
      prepare,
      deployMain,
      action,
      rollbackId,
    },
    {
      run: async (args, options) => ({
        stdout: await cf.run(args, {
          cwd: file.directory,
          companion: options?.companion,
          signal: options?.signal,
        }),
      }),
      settings: async (name) => {
        const path = `/accounts/${journal.accountId}/workers/scripts/${name}/settings`;
        try {
          return await resultOf<WorkerSettings>(cf, path);
        } catch (error) {
          if (error instanceof CliError && /\[code: (?:10007|10090)\]/u.test(error.message)) return null;
          throw error;
        }
      },
      health: async (base) => {
        const response = await fetch(new URL("/v1/healthz", base), {
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`Health check returned ${response.status}`);
        return response.json() as Promise<Record<string, unknown>>;
      },
      log: (message) => process.stderr.write(message + "\n"),
    },
  );
}

export async function setBuild(file: { path: string; config: Record<string, unknown> }, buildId: string) {
  const vars = file.config.vars as Record<string, unknown>;
  vars.GATEWAY_BUILD_ID = buildId;
  await writeFile(file.path, JSON.stringify(file.config, null, 2), { mode: 0o600 });
}
