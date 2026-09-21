import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { cp, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CliCapabilitiesResponse } from "../../src/contracts/cli.ts";
import { release, type ReleaseArtifact } from "./release.ts";
import { CliError, fail, origin, randomToken } from "./common.ts";
import type { Context } from "./context.ts";
import { protectedDirectory, type InstallationJournal } from "./state.ts";
import { confirm, prompt } from "./input.ts";
import type { Flags } from "./parser.ts";

const require = createRequire(import.meta.url);

export interface WranglerOptions {
  cwd?: string;
  input?: string;
  interactive?: boolean;
  /** Secret values that must never appear in a reported failure. */
  redact?: string[];
}

export type WranglerRunner = (args: string[], options?: WranglerOptions) => Promise<string>;

/** How much of a failed run's output is repeated; enough to name the cause. */
const OUTPUT_TAIL = 5000;

/**
 * What a failed wrangler run has to say, as the error envelope reports it.
 *
 * The tail of its own output is the only thing that distinguishes a name
 * collision from an expired token or a migration that could not apply, so it
 * is carried rather than discarded — minus any secret value the caller passed
 * to the run, which must not reach stdout even in a failure.
 */
export function wranglerFailure(
  args: string[],
  code: number | null,
  output: string,
  redact: string[] = [],
): CliError {
  // Redacted before it is cut down, so a trimmed tail cannot end mid-secret.
  // Wrangler colours its output for a terminal and this is reported inside a
  // JSON envelope, so the escapes come out: same text, without the noise.
  const tail = stripVTControlCharacters(
    redact
      .filter((value) => value.length >= 8)
      .reduce((text, value) => text.split(value).join("[redacted]"), output),
  )
    .trim()
    .slice(-OUTPUT_TAIL);
  return new CliError(
    "wrangler_failed",
    `wrangler ${args[0] ?? ""} failed${code === null ? "" : ` (exit ${code})`}.`,
    "Read the reported wrangler output; fix what it names and retry the same command.",
    3,
    tail ? { output: tail } : undefined,
  );
}

/**
 * The environment a wrangler run is given.
 *
 * `WRANGLER_LOG` is set rather than inherited, so a caller's `debug` cannot
 * leak into a run this CLI has to read. It is `log` — everything wrangler has
 * to say short of debug — for two reasons. A run whose stdout is read needs it,
 * because that is the level wrangler prints its `--json` answers at, and
 * quietening one silences the answer while still exiting 0, which is
 * indistinguishable from not being logged in. Every other run needs it because
 * its output is what a failure is reported with: wrangler explains itself in
 * warnings and notices as much as in the error it ends on, and a deployment
 * that fails against somebody's own Cloudflare account can only be diagnosed
 * from what wrangler said about it.
 */
export function wranglerEnvironment({
  interactive = false,
}: Pick<WranglerOptions, "interactive"> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG: "log",
    CI: interactive ? "" : "true",
  };
}

export async function runWrangler(
  args: string[],
  { cwd, input, interactive = false, redact }: WranglerOptions = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve("wrangler/bin/wrangler.js"), ...args], {
      ...(cwd === undefined ? {} : { cwd }),
      env: wranglerEnvironment({ interactive }),
      stdio: [input ? "pipe" : interactive ? "inherit" : "ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout?.on("data", (data: Buffer) => {
      output += data;
      if (interactive) process.stderr.write(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      errors += data;
      if (interactive) process.stderr.write(data);
    });
    if (input) child.stdin?.end(input);
    child.once("error", () =>
      reject(
        new CliError(
          "wrangler_unavailable",
          "Wrangler could not start.",
          "Reinstall the CLI so its bundled wrangler is present, then retry.",
          3,
        ),
      ),
    );
    child.once("close", (code) => {
      if (code !== 0) reject(wranglerFailure(args, code, errors || output, redact));
      else resolve(output);
    });
  });
}

/** How `wrangler auth token --json` reports the current authorization. */
interface CloudflareAuth {
  type?: string;
  token?: string;
  key?: string;
  email?: string;
}

/** Whether an authorization carries enough to sign a Cloudflare API request. */
function usable(auth: CloudflareAuth): boolean {
  return auth.type === "api_key" ? Boolean(auth.key && auth.email) : Boolean(auth.token);
}

/**
 * The Cloudflare credential values the environment carries, under the names
 * and in the two shapes wrangler itself accepts: an API token, or a global key
 * paired with an email.
 *
 * Wrangler reads exactly these, so an empty result is what allows a failed
 * read to mean "logged out" at all — with credentials present it cannot. The
 * values are also what a reported wrangler failure has to be scrubbed of.
 */
function environmentCredentials(): string[] {
  const env = process.env;
  const token = env.CLOUDFLARE_API_TOKEN ?? env.CF_API_TOKEN;
  const key = env.CLOUDFLARE_API_KEY ?? env.CF_API_KEY;
  const email = env.CLOUDFLARE_EMAIL ?? env.CF_EMAIL;
  return [token, key && email ? key : undefined].filter((value): value is string =>
    Boolean(value),
  );
}

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  result_info?: { total_pages?: number };
  errors?: { code?: number; message?: string }[];
}

/** How much of Cloudflare's own account of a refusal is repeated. */
const API_ERROR_TAIL = 500;

/**
 * What the v4 envelope says went wrong, as one line.
 *
 * The status alone does not distinguish a ceiling from a permission or a name
 * already taken, and these messages are where Cloudflare says which — so a
 * refusal is reported with them rather than as its number.
 */
function apiErrors(data: CloudflareEnvelope<unknown>): string {
  return (data.errors ?? [])
    .map((error) =>
      [error.message, error.code === undefined ? "" : `[code: ${error.code}]`]
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean)
    .join("; ")
    .slice(0, API_ERROR_TAIL);
}

interface WorkerBinding {
  name: string;
  type: string;
  text?: string;
  id?: string;
  class_name?: string;
  script_name?: string;
  environment?: string;
}

interface WorkerSettings {
  bindings?: WorkerBinding[];
}

interface CloudflareAccount {
  id: string;
  name: string;
}
interface CloudflareZone {
  id: string;
  name: string;
}
interface WorkerDomain {
  hostname: string;
  service: string;
}
interface WorkerScript {
  id: string;
}
interface D1Database {
  uuid: string;
  name: string;
}

export interface CloudflareRequestOptions {
  method?: string;
  body?: unknown;
  allow404?: boolean;
}

export class Cloudflare {
  readonly run: WranglerRunner;
  private readonly fetch: typeof globalThis.fetch;
  private auth: CloudflareAuth | undefined;

  constructor(run: WranglerRunner = runWrangler, fetchImpl: typeof globalThis.fetch = fetch) {
    this.run = run;
    this.fetch = fetchImpl;
  }

  /**
   * The authorization wrangler holds, or undefined when it holds none.
   *
   * Only one outcome may be read as "logged out": wrangler exiting non-zero
   * with nothing in the environment for it to have used. A run that failed
   * while credentials were set failed at something else, a run that could not
   * start failed at nothing to do with authorization, and output that will not
   * parse means this CLI and the wrangler it drives disagree about the
   * command. Answering any of those with a login would hide the cause behind a
   * message about something the caller had already done.
   */
  private async readAuth(): Promise<CloudflareAuth | undefined> {
    const credentials = environmentCredentials();
    let reported: string;
    try {
      // Away from the caller's directory: this command reads a wrangler config
      // if one sits beside it, and an unrelated project's config must not
      // decide whether Cloudflare is authorized.
      reported = await this.run(["auth", "token", "--json"], {
        cwd: tmpdir(),
        redact: credentials,
      });
    } catch (error) {
      if (
        credentials.length > 0 ||
        !(error instanceof CliError) ||
        error.code !== "wrangler_failed"
      )
        throw error;
      return undefined;
    }
    let auth: CloudflareAuth;
    try {
      auth = JSON.parse(reported) as CloudflareAuth;
    } catch {
      fail(
        "cloudflare_auth_unreadable",
        "Wrangler did not report the Cloudflare authorization it holds.",
        "Reinstall the CLI so the wrangler it bundles is the one it expects, then retry.",
        3,
      );
    }
    return usable(auth) ? auth : undefined;
  }

  async authenticate(flags: Flags): Promise<void> {
    this.auth = await this.readAuth();
    if (this.auth) return;
    if (flags["no-input"] || flags["dry-run"])
      fail(
        "cloudflare_auth_required",
        "Cloudflare authentication is required.",
        "Set CLOUDFLARE_API_TOKEN securely, or run setup interactively to authorize Cloudflare.",
        4,
      );
    // Reaching here means the environment carried nothing, so wrangler will
    // not refuse the flow. Run it away from the caller's directory too, for
    // the same reason the read is.
    await this.run(["login"], { interactive: true, cwd: tmpdir() });
    // Wrangler reports a refused login on stderr and still exits 0, so what it
    // holds afterwards is the only answer worth believing.
    this.auth = await this.readAuth();
    if (!this.auth)
      fail(
        "cloudflare_auth_required",
        "Cloudflare authorization was not completed.",
        "Read the wrangler output above, complete the browser login, then retry the same command.",
        4,
      );
  }

  private authHeaders(): Record<string, string> {
    const auth = this.auth;
    if (!auth) fail("cloudflare_auth_required", "No Cloudflare authorization is available.");
    return auth.type === "api_key"
      ? { "X-Auth-Key": auth.key ?? "", "X-Auth-Email": auth.email ?? "" }
      : { authorization: "Bearer " + (auth.token ?? "") };
  }

  async request<T>(
    path: string,
    { method = "GET", body, allow404 = false }: CloudflareRequestOptions = {},
  ): Promise<CloudflareEnvelope<T> | null> {
    let response: Response;
    try {
      response = await this.fetch("https://api.cloudflare.com/client/v4" + path, {
        method,
        redirect: "error",
        headers: {
          ...this.authHeaders(),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      if (error instanceof CliError) throw error;
      fail(
        "cloudflare_unavailable",
        "Cloudflare could not be reached.",
        "Retry the same deployment command; protected installation state was retained.",
        3,
      );
    }
    if (response.status === 404 && allow404) return null;
    let data: CloudflareEnvelope<T>;
    try {
      data = (await response.json()) as CloudflareEnvelope<T>;
    } catch {
      fail("cloudflare_error", "Cloudflare returned an invalid response.");
    }
    if (!response.ok || !data.success) {
      const reported = apiErrors(data);
      fail(
        "cloudflare_error",
        `Cloudflare rejected the request (HTTP ${response.status})${reported ? `: ${reported}` : ""}`,
        "Check Cloudflare permissions and the deployment resource IDs; retry the same command.",
        3,
        reported ? { apiErrors: reported } : undefined,
      );
    }
    return data;
  }

  async all<T>(path: string): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= 10000; page++) {
      const data = await this.request<T[]>(
        path + (path.includes("?") ? "&" : "?") + "page=" + page + "&per_page=50",
      );
      if (!data || !Array.isArray(data.result))
        fail("cloudflare_error", "Expected a Cloudflare resource list.");
      result.push(...data.result);
      if (
        data.result_info?.total_pages
          ? page >= data.result_info.total_pages
          : data.result.length < 50
      )
        return result;
    }
    fail("cloudflare_error", "Cloudflare pagination exceeded its safety bound.");
  }

  async account(flags: Flags): Promise<string> {
    const accounts = await this.all<CloudflareAccount>("/accounts");
    let id = flags["cloudflare-account-id"];
    if (!id && accounts.length === 1) id = accounts[0]!.id;
    if (!id) {
      process.stderr.write(accounts.map((a) => `${a.name}: ${a.id}`).join("\n") + "\n");
      id = await prompt("Cloudflare account ID", flags);
    }
    if (!accounts.some((a) => a.id === id))
      fail("cloudflare_account_not_found", "The selected Cloudflare account is not accessible.");
    return id;
  }
}

/**
 * The structural client the deployment commands drive. Declared rather than
 * taken as the class so the suite can stand a recording double in its place.
 */
export type CloudflareClient = Pick<
  Cloudflare,
  "authenticate" | "account" | "all" | "request" | "run"
>;

/** A single Cloudflare read whose `result` the caller cannot do without. */
async function resultOf<T>(
  cf: CloudflareClient,
  path: string,
  options?: CloudflareRequestOptions,
): Promise<T> {
  const data = await cf.request<T>(path, options);
  if (!data) fail("cloudflare_error", "Cloudflare returned no result.");
  return data.result;
}

function hostname(value: string): string {
  const u = origin("https://" + value);
  if (new URL(u).hostname !== value || !value.includes(".") || value.includes(":"))
    fail("invalid_input", "Supply a hostname without protocol, path or port.");
  return value;
}

interface DeploymentFile {
  path: string;
  directory: string;
  config: Record<string, unknown>;
}

async function configFile(
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

/**
 * The failures that mean "not yet" rather than "not ever".
 *
 * Every one of them is the deployment failing to answer at all: a 5xx it raised
 * reaching its own storage, a connection its Worker is not routable for yet, or
 * an edge error page in front of that Worker, which is a 5xx that is not even
 * JSON. None of them says anything about the request, so none of them is
 * settled by sending a different one.
 *
 * The status is what decides, never the code alone: `invalid_response` is also
 * how `Context.parse` reports a body this CLI cannot read, which is a release
 * mismatch that no amount of waiting repairs, and that one carries no status.
 *
 * Distinct from `RETRYABLE_STATUS` in context.ts, which answers a different
 * question — whether a *receipt* survives a refusal — and deliberately includes
 * 429, which must stop this loop rather than restart it.
 */
function transient(error: unknown): boolean {
  if (!(error instanceof CliError)) return false;
  if (error.code === "connection_failed") return true;
  const status = error.details?.status;
  return typeof status === "number" && status >= 500;
}

/**
 * Sends a request that only a warmed deployment can answer, until it can.
 *
 * `verifyDeployment` below polls for half a minute before it calls an install
 * live, but it polls `getCliCapabilities`, which reads environment variables
 * and a static registry — it can answer from a Worker whose D1 binding and
 * Durable Object namespaces, created by the same deploy, are still propagating.
 * Passing it therefore proves the Worker is running and nothing more, so the
 * first request that does touch storage is the one that meets the gap, and it
 * needs a wait of its own.
 *
 * Only for a request that is idempotent by its own stored proofs: a retry here
 * re-sends a request whose outcome is unknown, and nothing but the deployment's
 * own receipt keeps that from creating a second thing.
 *
 * Backing off rather than polling flat, and bounded at six attempts: the
 * window this is waiting out is measured in seconds, so a deployment still
 * refusing after half a minute of it is not warming up — it is broken, and the
 * useful thing to do with the sixth attempt's answer is print it. Half a
 * minute is the waiting, not the ceiling: an attempt that hangs spends the
 * transport's own 30s timeout before this one starts counting.
 *
 * Each attempt is a real account initialization, which the deployment answers
 * from the proofs rather than by creating a second account. A self-host counts
 * none of them, deliberately — see the rate limit in src/routes/cli/bootstrap.ts,
 * which a deployment nobody owns yet does not apply.
 *
 * Each wait is announced on stderr, never stdout: a `--json` run stays one
 * document, and a person watching an install that has gone quiet for half a
 * minute can see what it is waiting for — and say so in a bug report, which is
 * the one piece of evidence this failure has been hard to collect.
 */
export async function whileWarming<T>(
  run: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = delay,
  report: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): Promise<T> {
  let wait = 1000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt === 5 || !transient(error)) throw error;
      const { code, details } = error as CliError;
      const status = details?.status;
      report(
        `Deployment is still coming up (${code}${status === undefined ? "" : ` ${status}`});` +
          ` retrying in ${wait / 1000}s.`,
      );
      await sleep(wait);
      wait = Math.min(wait * 2, 8000);
    }
  }
}

async function verifyDeployment(
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

async function checkDomain(
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

async function attachDomain(
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
  journal.domains = [...new Set([...(journal.domains ?? []), domain])];
  journal.vars = { ...journal.vars, CLI_CONSOLE_ORIGIN: "https://" + domain };
  await ctx.save();
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
async function retireInstallationSecrets(
  ctx: Context,
  journal: InstallationJournal,
  flags: Flags,
): Promise<void> {
  if (flags["dry-run"] || journal.phase !== "ready" || !journal.secrets) return;
  const kek = journal.secrets["SECRET_VAULT_LOCAL_KEK_V1"];
  if (kek) await ctx.store.vaultKey(journal.id, kek);
  delete journal.secrets;
  await ctx.save();
}

async function matchExisting(
  ctx: Context,
  cf: CloudflareClient,
  flags: Flags,
): Promise<InstallationJournal> {
  if (ctx.active?.deployment?.mode !== "self_hosted")
    fail("not_self_hosted", "This command requires a selected self-hosted deployment.");
  const installations = (ctx.state.installations ??= {});
  let journal = installations[ctx.active.deployment.id];
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
    const capabilities = await verifyDeployment(ctx, ctx.url, journal.id);
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
  if (deploymentId !== ctx.active.deployment.id)
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
  const { data: capabilities } = await ctx.publicCall("getCliCapabilities");
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

export async function deploymentCommand(
  ctx: Context,
  command: string,
  flags: Flags,
  cf: CloudflareClient = new Cloudflare(),
  loadRelease: typeof release = release,
): Promise<DeploymentResult> {
  // The release is downloaded once and cached; `--release-archive` names a copy
  // obtained some other way, which is the whole story for an install with no
  // route to github.com.
  const artifact = await loadRelease(flags.version, undefined, {
    archive: flags["release-archive"],
  });
  await cf.authenticate(flags);
  if (command !== "deployment setup") {
    const journal = await matchExisting(ctx, cf, flags);
    if (command === "deployment domain") {
      const domain = hostname(flags.hostname ?? (await prompt("Custom hostname", flags)));
      if (!flags["dry-run"])
        await confirm(
          `Attach ${domain} to ${journal.name} in Cloudflare account ${journal.accountId}?`,
          flags,
        );
      return attachDomain(ctx, cf, journal, domain, artifact, Boolean(flags["dry-run"]));
    }
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
    journal.version = artifact.manifest.version;
    await ctx.save();
    return { updated: true, ...plan };
  }
  const name =
    flags.name ?? (await prompt("Worker name", flags, { defaultValue: "app-ai-gateway" }));
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name))
    fail("invalid_input", "Worker name must be a lowercase slug of at most 63 characters.");
  const domain = flags.domain ? hostname(flags.domain) : undefined;
  const accountId = await cf.account(flags);
  const workers = await cf.all<WorkerScript>("/accounts/" + accountId + "/workers/scripts");
  const installations = (ctx.state.installations ??= {});
  let journal = Object.values(installations).find(
    (j) => j.accountId === accountId && j.name === name,
  );
  const exists = workers.some((w) => w.id === name);
  if (exists && !journal)
    fail(
      "worker_name_collision",
      "A Worker already uses this name.",
      "Choose a different --name; setup never takes over an existing installation.",
    );
  if (exists && journal) {
    const settings = await resultOf<WorkerSettings>(cf, 
      `/accounts/${accountId}/workers/scripts/${name}/settings`,
    );
    if (settings.bindings?.find((b) => b.name === "DEPLOYMENT_ID")?.text !== journal.id)
      fail(
        "deployment_identity_mismatch",
        "Existing Worker does not match the saved installation journal.",
      );
  }
  if (journal?.phase === "ready") {
    await retireInstallationSecrets(ctx, journal, flags);
    if (journal.pendingDomain) {
      const inventoryContext = Object.create(ctx) as Context;
      Object.defineProperty(inventoryContext, "active", {
        value: { deployment: { id: journal.id, mode: "self_hosted" } },
      });
      Object.defineProperty(inventoryContext, "url", {
        value: journal.url ?? ctx.url,
      });
      journal = await matchExisting(inventoryContext, cf, flags);
      if (flags["dry-run"])
        return {
          installed: true,
          pendingDomain: journal.pendingDomain,
          dryRun: true,
        };
      await attachDomain(ctx, cf, journal, journal.pendingDomain!, artifact, false);
      delete journal.pendingDomain;
      await ctx.save();
    }
    await verifyDeployment(ctx, journal.url ?? ctx.url, journal.id);
    return {
      installed: true,
      deploymentId: journal.id,
      name,
      accountId,
      url: journal.url ?? ctx.url,
      note: "This installation is already complete. Use deployment connect to authenticate or deployment update to change its release.",
    };
  }
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
  if (!journal) {
    const id = randomUUID();
    journal = {
      id,
      name,
      accountId,
      databaseName: name + "-" + id.slice(0, 8),
      version: artifact.manifest.version,
      phase: "prepared",
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
    installations[id] = journal;
    await ctx.save();
  }
  try {
    if (!journal.databaseId) {
      const databases = await cf.all<D1Database>("/accounts/" + accountId + "/d1/database");
      let database = databases.find((d) => d.name === journal!.databaseName);
      if (!database)
        database = await resultOf<D1Database>(cf, "/accounts/" + accountId + "/d1/database", {
          method: "POST",
          body: { name: journal.databaseName },
        });
      journal.databaseId = database.uuid;
      await ctx.save();
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
    journal.phase = "deployed";
    await ctx.save();
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
    journal.phase = "ready";
    if (domain) journal.pendingDomain = domain;
    // The Worker holds these now; only the vault key is worth keeping, and it
    // is already in its own file.
    delete journal.secrets;
    await ctx.save();
    if (domain) {
      await attachDomain(ctx, cf, journal, domain, artifact, false);
      delete journal.pendingDomain;
      await ctx.save();
    }
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
