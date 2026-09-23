import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CliCapabilitiesResponse } from "../../src/contracts/cli.ts";
import type { ReleaseArtifact } from "./release.ts";
import { CliError, fail } from "./common.ts";
import type { Context } from "./context.ts";
import { protectedDirectory, type InstallationJournal } from "./state.ts";
import { confirm, prompt } from "./input.ts";
import type { Flags } from "./parser.ts";
import {
  resultOf,
  type CloudflareClient,
  type CloudflareZone,
  type WorkerDomain,
  type WorkerScript,
  type WorkerSettings,
} from "./cloudflare.ts";

/**
 * Moves one installation to a phase and persists it.
 *
 * The only writer of `journal.phase`, and of the fields that change with one.
 * An install is resumable because its journal says where it stopped, so a
 * phase written in one place and saved somewhere else is a journal that can
 * claim a step it never finished; here the patch, the phase and the write are
 * one call. A field whose patch value is `undefined` is dropped from the
 * journal — how a `pendingDomain` that has been attached, or a secret the
 * Worker now holds, leaves the state file.
 *
 * The phase names are the ones on disk (`prepared`, `deployed`, `ready`) and
 * cannot be renamed: journals written by earlier releases are still read.
 */
export async function advance(
  ctx: Context,
  journal: InstallationJournal,
  phase: InstallationJournal["phase"],
  patch: Partial<InstallationJournal> = {},
): Promise<void> {
  // One cast, because dropping a field is part of what a patch says and the
  // journal's own required names cannot be deleted through its type.
  const fields = journal as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete fields[field];
    else fields[field] = value;
  }
  journal.phase = phase;
  await ctx.save();
}

/** Records a new installation at its first phase, which is where setup starts. */
export async function prepare(
  ctx: Context,
  installations: Record<string, InstallationJournal>,
  draft: Omit<InstallationJournal, "phase">,
): Promise<InstallationJournal> {
  const journal: InstallationJournal = { ...draft, phase: "prepared" };
  installations[draft.id] = journal;
  await ctx.save();
  return journal;
}

/**
 * Which installation an inventory is matched against.
 *
 * Named rather than read off the context, because two callers ask the same
 * question about two different deployments: `deployment update` and
 * `deployment domain` mean the selected connection, while a setup resuming a
 * `pendingDomain` means the journal it is resuming — which is not the
 * connection this command is on, and may be at a URL the connection is not.
 */
export interface InstallationTarget {
  url: string;
  deploymentId: string;
  installations: Record<string, InstallationJournal>;
}

/** The selected connection as an inventory target, refused unless self-hosted. */
export function selectedInstallation(ctx: Context): InstallationTarget {
  if (ctx.active?.deployment?.mode !== "self_hosted")
    fail("not_self_hosted", "This command requires a selected self-hosted deployment.");
  return {
    url: ctx.url,
    deploymentId: ctx.active.deployment.id,
    installations: (ctx.state.installations ??= {}),
  };
}

interface DeploymentFile {
  path: string;
  directory: string;
  config: Record<string, unknown>;
}

export async function configFile(
  ctx: Context,
  journal: InstallationJournal,
  artifact: ReleaseArtifact,
): Promise<DeploymentFile> {
  const directory = join(ctx.store.directory, "deployments", journal.id);
  await protectedDirectory(directory);
  await cp(artifact.directory, join(directory, "release"), { recursive: true });
  const config = {
    ...artifact.config,
    name: journal.name,
    account_id: journal.accountId,
    main: "./release/worker/index.js",
    assets: { ...artifact.config.assets, directory: "./release/console" },
    d1_databases: [
      {
        binding: "DB",
        database_id: journal.databaseId,
        database_name: journal.databaseName,
        migrations_dir: "./release/migrations",
      },
    ],
    vars: {
      ...artifact.config.vars,
      ALLOW_ADDITIONAL_REGISTRATIONS: "false",
      ...journal.vars,
      DEPLOYMENT_ID: journal.id,
    },
    ...(journal.domains?.length
      ? {
          routes: journal.domains.map((pattern) => ({
            pattern,
            custom_domain: true,
          })),
        }
      : {}),
  };
  const path = join(directory, "wrangler.json");
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { path, directory, config };
}

export async function verifyDeployment(
  ctx: Context,
  url: string,
  id: string,
): Promise<CliCapabilitiesResponse> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const { data } = await ctx.publicCall("getCliCapabilities", { url });
      if (data.deployment.id !== id)
        fail(
          "deployment_identity_mismatch",
          "The endpoint does not identify the expected deployment.",
        );
      return data;
    } catch (error) {
      if (error instanceof CliError && error.code === "deployment_identity_mismatch") throw error;
      if (attempt === 19) throw error;
      await delay(1500);
    }
  }
  fail("deployment_identity_mismatch", "The endpoint never identified the expected deployment.");
}

async function zoneFor(
  cf: CloudflareClient,
  accountId: string,
  domain: string,
): Promise<CloudflareZone> {
  const zones = await cf.all<CloudflareZone>(
    "/zones?status=active&account.id=" + encodeURIComponent(accountId),
  );
  const matches = zones
    .filter((z) => domain === z.name || domain.endsWith("." + z.name))
    .sort((a, b) => b.name.length - a.name.length);
  const best = matches[0];
  if (!best)
    fail("domain_zone_missing", "No accessible active Cloudflare zone covers this hostname.");
  return best;
}

export async function checkDomain(
  cf: CloudflareClient,
  journal: { name: string; accountId: string },
  domain: string,
): Promise<CloudflareZone> {
  const zone = await zoneFor(cf, journal.accountId, domain);
  const domains = await cf.all<WorkerDomain>(
    "/accounts/" + journal.accountId + "/workers/domains",
  );
  const current = domains.find((d) => d.hostname === domain);
  if (current && current.service !== journal.name)
    fail("domain_in_use", "The hostname is attached to a different Worker.");
  if (!current) {
    const records = await cf.all<unknown>(
      "/zones/" + zone.id + "/dns_records?name=" + encodeURIComponent(domain),
    );
    if (records.length)
      fail("domain_in_use", "The hostname has existing DNS records; no records were changed.");
  }
  return zone;
}

export interface DomainPlan {
  hostname: string;
  zoneId: string;
  worker: string;
  accountId: string;
  previousUrl: string;
  dryRun?: true;
  url?: string;
  note?: string;
}

export async function attachDomain(
  ctx: Context,
  cf: CloudflareClient,
  journal: InstallationJournal,
  domain: string,
  artifact: ReleaseArtifact,
  dryRun: boolean,
): Promise<DomainPlan> {
  if (journal.version !== artifact.manifest.version)
    fail(
      "domain_release_mismatch",
      "Domain configuration requires the CLI release matching the deployed gateway version.",
      "Update the gateway explicitly, or install its matching CLI version first.",
    );
  const zone = await checkDomain(cf, journal, domain);
  const plan: DomainPlan = {
    hostname: domain,
    zoneId: zone.id,
    worker: journal.name,
    accountId: journal.accountId,
    previousUrl: ctx.url,
  };
  if (dryRun) return { dryRun: true, ...plan };
  await cf.request("/accounts/" + journal.accountId + "/workers/domains", {
    method: "PUT",
    body: {
      hostname: domain,
      service: journal.name,
      environment: "production",
      zone_id: zone.id,
    },
  });
  // Recorded before the deploy that publishes them, so a run interrupted in
  // between resumes with the domain this journal already owns.
  await advance(ctx, journal, journal.phase, {
    domains: [...new Set([...(journal.domains ?? []), domain])],
    vars: { ...journal.vars, CLI_CONSOLE_ORIGIN: "https://" + domain },
  });
  const file = await configFile(ctx, journal, artifact);
  await cf.run(["deploy", "--config", file.path, "--keep-vars"], {
    cwd: file.directory,
  });
  await verifyDeployment(ctx, "https://" + domain, journal.id);
  if (ctx.active?.deployment?.id === journal.id) {
    ctx.active.url = "https://" + domain;
    ctx.active.deployment.apiUrl = ctx.active.url;
    await ctx.save();
  }
  return {
    ...plan,
    url: "https://" + domain,
    note: "Existing mobile clients keep their embedded URL. The workers.dev endpoint and existing custom domains remain enabled.",
  };
}

interface CurrentInventory {
  databaseId: string;
  vars: Record<string, string>;
  domains: string[];
}

async function currentInventory(
  cf: CloudflareClient,
  accountId: string,
  name: string,
  settings: WorkerSettings,
  expectedDatabaseId?: string,
): Promise<CurrentInventory> {
  const bindings = settings.bindings ?? [];
  const db = bindings.find((b) => b.name === "DB" && b.type === "d1");
  if (!db?.id) fail("deployment_binding_missing", "The selected Worker has no D1 DB binding.");
  if (expectedDatabaseId && db.id !== expectedDatabaseId)
    fail(
      "deployment_database_mismatch",
      "The Worker D1 binding differs from the saved installation journal.",
      "Reconcile the deployment configuration and protected journal before updating; no database was migrated.",
    );
  const resourceTypes: Record<string, string> = {
    DB: "d1",
    USER_LIMITER: "durable_object_namespace",
    ORG_QUOTA: "durable_object_namespace",
    ENDPOINT_RATE_LIMITER: "durable_object_namespace",
  };
  if (
    bindings.some(
      (b) => !["plain_text", "secret_text"].includes(b.type) && resourceTypes[b.name] !== b.type,
    )
  )
    fail(
      "deployment_binding_unsupported",
      "The existing Worker has resource bindings the bundled release cannot preserve safely.",
      "Manage this customized deployment through its existing configuration.",
    );
  const localClasses: Record<string, string> = {
    USER_LIMITER: "UserLimiter",
    ORG_QUOTA: "OrgQuota",
    ENDPOINT_RATE_LIMITER: "EndpointRateLimiter",
  };
  if (
    bindings.some(
      (binding) =>
        binding.type === "durable_object_namespace" &&
        (binding.class_name !== localClasses[binding.name] ||
          (binding.script_name && binding.script_name !== name) ||
          (binding.environment && binding.environment !== "production")),
    )
  ) {
    fail(
      "deployment_binding_unsupported",
      "The existing Durable Object binding points to a different class, Worker, or environment.",
      "Preserve this customized namespace through its existing deployment configuration.",
    );
  }
  return {
    databaseId: db.id,
    vars: Object.fromEntries(
      bindings
        .filter((b) => b.type === "plain_text")
        .map((b) => [b.name, b.text ?? ""]),
    ),
    domains: (await cf.all<WorkerDomain>("/accounts/" + accountId + "/workers/domains"))
      .filter((d) => d.service === name)
      .map((d) => d.hostname),
  };
}

/**
 * Moves a finished installation's leftover secrets out of the state file.
 *
 * Earlier releases kept the auth secrets and the vault key in the journal for
 * the life of the installation, beside the management credential. The Worker
 * holds the auth secrets, so once the install is ready the vault key is the
 * only one worth keeping — in its own file, where `vaultKey` adopts it.
 */
export async function retireInstallationSecrets(
  ctx: Context,
  journal: InstallationJournal,
  flags: Flags,
): Promise<void> {
  if (flags["dry-run"] || journal.phase !== "ready" || !journal.secrets) return;
  const kek = journal.secrets["SECRET_VAULT_LOCAL_KEK_V1"];
  if (kek) await ctx.store.vaultKey(journal.id, kek);
  await advance(ctx, journal, journal.phase, { secrets: undefined });
}

/**
 * The journal for one deployment, checked against the Worker that serves it.
 *
 * The target is passed rather than read from the context: the journal being
 * matched is not always the selected connection's — a setup resuming a
 * `pendingDomain` matches the installation it is finishing, at that
 * installation's own URL.
 */
export async function matchExisting(
  ctx: Context,
  cf: CloudflareClient,
  flags: Flags,
  target: InstallationTarget,
): Promise<InstallationJournal> {
  const { installations } = target;
  let journal = installations[target.deploymentId];
  if (journal) {
    const settings = await resultOf<WorkerSettings>(cf, 
      `/accounts/${journal.accountId}/workers/scripts/${encodeURIComponent(journal.name)}/settings`,
    );
    if (
      settings.bindings?.find((b) => b.name === "DEPLOYMENT_ID" && b.type === "plain_text")
        ?.text !== journal.id
    )
      fail(
        "deployment_identity_mismatch",
        "The Cloudflare Worker no longer matches this installation journal.",
      );
    const capabilities = await verifyDeployment(ctx, target.url, journal.id);
    const inventory = await currentInventory(
      cf,
      journal.accountId,
      journal.name,
      settings,
      journal.databaseId,
    );
    const checked: InstallationJournal = {
      ...journal,
      ...inventory,
      version: capabilities.serverVersion,
    };
    if (!flags["dry-run"]) installations[journal.id] = checked;
    await retireInstallationSecrets(ctx, checked, flags);
    return checked;
  }
  const accountId = await cf.account(flags);
  const workers = await cf.all<WorkerScript>("/accounts/" + accountId + "/workers/scripts");
  process.stderr.write(workers.map((w) => w.id).join("\n") + "\n");
  const name = await prompt("Exact Worker name to bind to this deployment", flags);
  if (!workers.some((w) => w.id === name))
    fail("worker_not_found", "The named Worker is not accessible.");
  const settings = await resultOf<WorkerSettings>(cf, 
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/settings`,
  );
  const deploymentId = settings.bindings?.find(
    (b) => b.name === "DEPLOYMENT_ID" && b.type === "plain_text",
  )?.text;
  if (deploymentId !== target.deploymentId)
    fail(
      "deployment_identity_mismatch",
      "Cloudflare Worker identity does not match the selected deployment.",
    );
  const db = settings.bindings?.find((b) => b.name === "DB" && b.type === "d1");
  if (!db?.id) fail("deployment_binding_missing", "The selected Worker has no D1 DB binding.");
  if (!flags["dry-run"])
    await confirm(
      `Bind deployment ${deploymentId} to Cloudflare account ${accountId}, Worker ${name} and D1 ${db.id}?`,
      flags,
    );
  const { data: capabilities } = await ctx.publicCall("getCliCapabilities", {
    url: target.url,
  });
  const inventory = await currentInventory(cf, accountId, name, settings);
  journal = {
    id: deploymentId,
    name,
    accountId,
    version: capabilities.serverVersion,
    // Carries `databaseId`, read back from the Worker's own D1 binding.
    ...inventory,
    phase: "ready",
  };
  if (!flags["dry-run"]) {
    installations[deploymentId] = journal;
    await ctx.save();
  }
  return journal;
}

