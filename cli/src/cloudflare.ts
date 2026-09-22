import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { CliError, fail } from "./common.ts";
import { prompt } from "./input.ts";
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

export interface WorkerSettings {
  bindings?: WorkerBinding[];
}

interface CloudflareAccount {
  id: string;
  name: string;
}
export interface CloudflareZone {
  id: string;
  name: string;
}
export interface WorkerDomain {
  hostname: string;
  service: string;
}
export interface WorkerScript {
  id: string;
}
export interface D1Database {
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
export async function resultOf<T>(
  cf: CloudflareClient,
  path: string,
  options?: CloudflareRequestOptions,
): Promise<T> {
  const data = await cf.request<T>(path, options);
  if (!data) fail("cloudflare_error", "Cloudflare returned no result.");
  return data.result;
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
 * `verifyDeployment` in installation.ts polls for half a minute before it calls an install
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
