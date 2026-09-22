import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { release, type ReleaseArtifact } from "./release.ts";
import { CliError, fail, origin, randomToken } from "./common.ts";
import type { Context } from "./context.ts";
import type { InstallationJournal } from "./state.ts";
import { confirm, prompt } from "./input.ts";
import type { Flags } from "./parser.ts";
import {
  Cloudflare,
  resultOf,
  whileWarming,
  type CloudflareClient,
  type D1Database,
  type WorkerScript,
  type WorkerSettings,
} from "./cloudflare.ts";
import {
  advance,
  attachDomain,
  checkDomain,
  configFile,
  matchExisting,
  prepare,
  retireInstallationSecrets,
  selectedInstallation,
  verifyDeployment,
  type DomainPlan,
} from "./installation.ts";

function hostname(value: string): string {
  const u = origin("https://" + value);
  if (new URL(u).hostname !== value || !value.includes(".") || value.includes(":"))
    fail("invalid_input", "Supply a hostname without protocol, path or port.");
  return value;
}

export interface DeploymentUpdatePlan {
  worker: string;
  accountId: string;
  databaseId: string | undefined;
  fromVersion: string;
  toVersion: string;
  dryRun?: true;
  updated?: true;
}

/**
 * What a setup run reports. Every field is optional because the three answers
 * it can give — a dry run's plan, an installation that was already complete,
 * and a finished install — each report their own subset, exactly as before.
 */
export interface DeploymentSetupPlan {
  name?: string;
  accountId?: string;
  url?: string;
  version?: string;
  domain?: string | null;
  resources?: string[];
  dryRun?: true;
  installed?: true;
  deploymentId?: string;
  backup?: string;
  note?: string;
  pendingDomain?: string;
}

export type DeploymentResult = DomainPlan | DeploymentUpdatePlan | DeploymentSetupPlan;

/**
 * What all three commands need before they touch anything: the release they
 * are about to install, and an authorized Cloudflare.
 */
async function authorized(
  flags: Flags,
  cf: CloudflareClient,
  loadRelease: typeof release,
): Promise<ReleaseArtifact> {
  // The release is downloaded once and cached; `--release-archive` names a copy
  // obtained some other way, which is the whole story for an install with no
  // route to github.com.
  const artifact = await loadRelease(flags.version, undefined, {
    archive: flags["release-archive"],
  });
  await cf.authenticate(flags);
  return artifact;
}

export async function deploymentDomain(
  ctx: Context,
  flags: Flags,
  cf: CloudflareClient = new Cloudflare(),
  loadRelease: typeof release = release,
): Promise<DomainPlan> {
  const artifact = await authorized(flags, cf, loadRelease);
  const journal = await matchExisting(ctx, cf, flags, selectedInstallation(ctx));
  const domain = hostname(flags.hostname ?? (await prompt("Custom hostname", flags)));
  if (!flags["dry-run"])
    await confirm(
      `Attach ${domain} to ${journal.name} in Cloudflare account ${journal.accountId}?`,
      flags,
    );
  return attachDomain(ctx, cf, journal, domain, artifact, Boolean(flags["dry-run"]));
}

export async function deploymentUpdate(
  ctx: Context,
  flags: Flags,
  cf: CloudflareClient = new Cloudflare(),
  loadRelease: typeof release = release,
): Promise<DeploymentUpdatePlan> {
  const artifact = await authorized(flags, cf, loadRelease);
  const journal = await matchExisting(ctx, cf, flags, selectedInstallation(ctx));
  if (!artifact.manifest.upgradeFrom.includes(journal.version))
    fail(
      "unsupported_upgrade",
      "This release cannot upgrade the selected database schema.",
      "Use a supported migration release; no data was changed.",
    );
  const plan: DeploymentUpdatePlan = {
    worker: journal.name,
    accountId: journal.accountId,
    databaseId: journal.databaseId,
    fromVersion: journal.version,
    toVersion: artifact.manifest.version,
  };
  if (flags["dry-run"]) return { dryRun: true, ...plan };
  await confirm(
    `Update ${journal.name} to ${artifact.manifest.version}? Database migrations cannot be rolled back automatically.`,
    flags,
  );
  const file = await configFile(ctx, journal, artifact);
  await cf.run(["d1", "migrations", "apply", "DB", "--remote", "--config", file.path], {
    cwd: file.directory,
  });
  await cf.run(["deploy", "--config", file.path, "--keep-vars"], {
    cwd: file.directory,
  });
  await verifyDeployment(ctx, ctx.url, journal.id);
  await advance(ctx, journal, journal.phase, { version: artifact.manifest.version });
  return { updated: true, ...plan };
}

/** A fresh installation's journal, before anything has been provisioned. */
function newInstallation(
  name: string,
  accountId: string,
  url: string,
  version: string,
): Omit<InstallationJournal, "phase"> {
  const id = randomUUID();
  return {
    id,
    name,
    accountId,
    databaseName: name + "-" + id.slice(0, 8),
    version,
    url,
    vars: { CLI_CONSOLE_ORIGIN: url },
    bootstrap: { idempotencyKey: randomToken(), pollToken: randomToken() },
    // Held only until the Worker has them and the install is ready; the vault
    // key is the one that outlives setup, and it lives in its own file.
    secrets: {
      JWT_SECRET: randomToken(),
      BETTER_AUTH_SECRET: randomToken(),
    },
  };
}

/**
 * What a setup run does when its journal is already `ready`: nothing, unless
 * the install still owes the domain it was asked for.
 */
async function completeInstallation(
  ctx: Context,
  cf: CloudflareClient,
  flags: Flags,
  ready: InstallationJournal,
  artifact: ReleaseArtifact,
  installations: Record<string, InstallationJournal>,
): Promise<DeploymentSetupPlan> {
  await retireInstallationSecrets(ctx, ready, flags);
  let journal = ready;
  if (journal.pendingDomain) {
    // Matched against the installation being finished rather than the selected
    // connection: this setup may be completing a deployment the CLI is not
    // connected to, which answers at its own URL and no other.
    journal = await matchExisting(ctx, cf, flags, {
      url: journal.url ?? ctx.url,
      deploymentId: journal.id,
      installations,
    });
    if (flags["dry-run"])
      return {
        installed: true,
        pendingDomain: journal.pendingDomain,
        dryRun: true,
      };
    await attachDomain(ctx, cf, journal, journal.pendingDomain!, artifact, false);
    await advance(ctx, journal, journal.phase, { pendingDomain: undefined });
  }
  await verifyDeployment(ctx, journal.url ?? ctx.url, journal.id);
  return {
    installed: true,
    deploymentId: journal.id,
    name: journal.name,
    accountId: journal.accountId,
    url: journal.url ?? ctx.url,
    note: "This installation is already complete. Use deployment connect to authenticate or deployment update to change its release.",
  };
}

/**
 * Carries one recorded installation from wherever it stopped to `ready`.
 *
 * Every step is repeatable, because a run that failed halfway is resumed by
 * the same command: the database is created only if the journal has none, the
 * migrations and the deploy are idempotent, and the account initialization is
 * sent on the proofs the journal already holds.
 */
async function install(
  ctx: Context,
  cf: CloudflareClient,
  journal: InstallationJournal,
  artifact: ReleaseArtifact,
  url: string,
  domain: string | undefined,
): Promise<void> {
  if (!journal.databaseId) {
    const databases = await cf.all<D1Database>(
      "/accounts/" + journal.accountId + "/d1/database",
    );
    let database = databases.find((d) => d.name === journal.databaseName);
    if (!database)
      database = await resultOf<D1Database>(
        cf,
        "/accounts/" + journal.accountId + "/d1/database",
        {
          method: "POST",
          body: { name: journal.databaseName },
        },
      );
    await advance(ctx, journal, journal.phase, { databaseId: database.uuid });
  }
  const file = await configFile(ctx, journal, artifact);
  await cf.run(["d1", "migrations", "apply", "DB", "--remote", "--config", file.path], {
    cwd: file.directory,
  });
  const secrets = {
    ...journal.secrets,
    SECRET_VAULT_LOCAL_KEK_V1: await ctx.store.vaultKey(journal.id),
  };
  const secretPath = join(file.directory, "secrets.json");
  await writeFile(secretPath, JSON.stringify(secrets), {
    mode: 0o600,
  });
  try {
    await cf.run(["deploy", "--config", file.path, "--secrets-file", secretPath], {
      cwd: file.directory,
      redact: Object.values(secrets),
    });
  } finally {
    await unlink(secretPath).catch(() => {});
  }
  await advance(ctx, journal, "deployed");
  await verifyDeployment(ctx, url, journal.id);
  // Sent on the same proofs however many attempts it takes, which is what
  // makes retrying safe: the deployment keys the account it creates by them
  // and answers an identical request with the identical account.
  const proofs = {
    idempotencyKey: journal.bootstrap!.idempotencyKey,
    pollToken: journal.bootstrap!.pollToken,
  };
  const { data } = await whileWarming(() =>
    ctx.publicCall("bootstrapCliAccount", { body: proofs, url }),
  );
  await ctx.select(url, data);
  // The Worker holds the auth secrets now; only the vault key is worth
  // keeping, and it is already in its own file. The domain becomes this
  // journal's debt until it is attached, so a run that stops in between
  // resumes owing it.
  await advance(ctx, journal, "ready", {
    ...(domain ? { pendingDomain: domain } : {}),
    secrets: undefined,
  });
  if (domain) {
    await attachDomain(ctx, cf, journal, domain, artifact, false);
    await advance(ctx, journal, journal.phase, { pendingDomain: undefined });
  }
}

export async function deploymentSetup(
  ctx: Context,
  flags: Flags,
  cf: CloudflareClient = new Cloudflare(),
  loadRelease: typeof release = release,
): Promise<DeploymentSetupPlan> {
  const artifact = await authorized(flags, cf, loadRelease);
  const name =
    flags.name ?? (await prompt("Worker name", flags, { defaultValue: "app-ai-gateway" }));
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name))
    fail("invalid_input", "Worker name must be a lowercase slug of at most 63 characters.");
  const domain = flags.domain ? hostname(flags.domain) : undefined;
  const accountId = await cf.account(flags);
  const workers = await cf.all<WorkerScript>("/accounts/" + accountId + "/workers/scripts");
  const installations = (ctx.state.installations ??= {});
  const recorded = Object.values(installations).find(
    (j) => j.accountId === accountId && j.name === name,
  );
  const exists = workers.some((w) => w.id === name);
  if (exists && !recorded)
    fail(
      "worker_name_collision",
      "A Worker already uses this name.",
      "Choose a different --name; setup never takes over an existing installation.",
    );
  if (exists && recorded) {
    const settings = await resultOf<WorkerSettings>(
      cf,
      `/accounts/${accountId}/workers/scripts/${name}/settings`,
    );
    if (settings.bindings?.find((b) => b.name === "DEPLOYMENT_ID")?.text !== recorded.id)
      fail(
        "deployment_identity_mismatch",
        "Existing Worker does not match the saved installation journal.",
      );
  }
  if (recorded?.phase === "ready")
    return completeInstallation(ctx, cf, flags, recorded, artifact, installations);
  const subdomain = (
    await resultOf<{ subdomain?: string }>(cf, "/accounts/" + accountId + "/workers/subdomain")
  ).subdomain;
  if (!subdomain)
    fail(
      "workers_subdomain_required",
      "Enable your Cloudflare workers.dev subdomain before setup.",
    );
  const url = `https://${name}.${subdomain}.workers.dev`;
  const plan: DeploymentSetupPlan = {
    name,
    accountId,
    url,
    version: artifact.manifest.version,
    domain: domain ?? null,
    resources: ["D1 database", "Worker", "Durable Objects", "private initial account"],
  };
  if (domain) await checkDomain(cf, { name, accountId }, domain);
  if (flags["dry-run"]) return { dryRun: true, ...plan };
  await confirm(
    `Install ${name} in Cloudflare account ${accountId} at ${url}${domain ? " with " + domain : ""}?`,
    flags,
  );
  const journal =
    recorded ??
    (await prepare(
      ctx,
      installations,
      newInstallation(name, accountId, url, artifact.manifest.version),
    ));
  try {
    await install(ctx, cf, journal, artifact, url, domain);
    return {
      installed: true,
      ...plan,
      deploymentId: journal.id,
      backup:
        "Back up the protected CLI state directory securely: it contains the vault key and deployment recovery state. Existing cloud apps and usage remain on cloud.",
    };
  } catch (error) {
    if (error instanceof CliError)
      throw new CliError(
        error.code,
        error.message,
        `${error.nextAction} Retry deployment setup with --name ${name} and --cloudflare-account-id ${accountId}; installation ${journal.id} is recorded locally.`,
        error.exitCode,
        error.details,
      );
    throw error;
  }
}

/**
 * The three deployment commands by name.
 *
 * Kept so that `main` dispatches one way for every command it does not handle
 * itself; each command's own function is exported beside it and takes the same
 * arguments minus the name.
 */
export async function deploymentCommand(
  ctx: Context,
  command: string,
  flags: Flags,
  cf: CloudflareClient = new Cloudflare(),
  loadRelease: typeof release = release,
): Promise<DeploymentResult> {
  if (command === "deployment setup") return deploymentSetup(ctx, flags, cf, loadRelease);
  if (command === "deployment domain") return deploymentDomain(ctx, flags, cf, loadRelease);
  if (command === "deployment update") return deploymentUpdate(ctx, flags, cf, loadRelease);
  fail("unknown_command", "Unknown command.");
}
