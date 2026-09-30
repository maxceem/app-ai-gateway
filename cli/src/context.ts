import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CliAccountResponse,
  CliCapabilitiesResponse,
  CliCredential,
  CliDeployment,
  CliLogin,
  CliOperation,
  CliOperationPayload,
  CliOperationRequestInput,
  CliRequestedOperationKind,
} from "../../src/contracts/cli.ts";
import type { CreatedApiKey, OrganizationSummary } from "../../src/contracts/responses.ts";
import type { z } from "zod";
import {
  CATALOG,
  operationPath,
  type OperationName,
  type OperationParams,
  type OperationQuery,
  type OperationRequest,
  type OperationResponse,
} from "../../src/contracts/catalog.ts";
import { CliError, CLOUD, fail, MANAGEMENT_KEY_ENV, origin, randomToken } from "./common.ts";
import { secret } from "./input.ts";
import { browserAvailable, clientDescription, listenLoopback, type Loopback } from "./login.ts";
import type { OutputSink } from "./main.ts";
import type { Flags } from "./parser.ts";
import { styleFor } from "./style.ts";
import { releaseOutput } from "./state.ts";
import type {
  ActiveConnection,
  CliState,
  OperationRecord,
  ReservedOutput,
  StateStore,
  StoredKeyMetadata,
} from "./state.ts";
import type { Transport } from "./transport.ts";

export type { OperationName };

/** The `/v1/cli` half of the table, which a deployment connection cannot reach. */
const CLI_OPERATIONS = new Set<OperationName>([
  "getCliCapabilities",
  "bootstrapCliAccount",
  "createCliOperation",
  "pollCliOperation",
  "getCliAccount",
  "getCliUsage",
  "openCliLogin",
  "redeemCliLogin",
  "revokeCliCredential",
]);

/** How long a browser login is waited for, as every other browser step is. */
const LOGIN_TIMEOUT_SECONDS = 300;
/** How long a pending login's record is worth keeping; the deployment keeps one 15 minutes. */
const LOGIN_RECORD_MS = 3_600_000;
/**
 * How long an approved loopback login waits for its browser to come back. The
 * page navigates the moment it is approved, so this only runs out when it was
 * approved somewhere that cannot reach this machine.
 */
const LOOPBACK_GRACE_MS = 10_000;

/** What the context reaches outside itself for; replaced in tests. */
export interface ContextIo {
  stderr: OutputSink;
  /** Resolves false when no browser could be started. */
  openBrowser(url: string): Promise<boolean>;
  /** Whether a browser opened here would be in front of the person at this terminal. */
  browserAvailable(): boolean;
  listen(): Promise<Loopback>;
  env: Record<string, string | undefined>;
}

const defaultIo = (): ContextIo => ({
  stderr: process.stderr,
  openBrowser,
  browserAvailable: () => browserAvailable(),
  listen: listenLoopback,
  env: process.env,
});

/** What `account login` and `deployment connect` answer with once signed in. */
export type LoginResult = CliAccountResponse & { connected: true };

/** What `account logout` answers with. */
export interface LogoutResult {
  loggedOut: true;
  /** Whether the deployment revoked the key this call removed. */
  revoked: boolean;
}

export interface CallOptions<K extends OperationName> {
  /** The `{name}` segments of the operation's path, if it has any. */
  params?: OperationParams<K>;
  query?: OperationQuery<K>;
  body?: OperationRequest<K>;
  /** Overrides the connection credential; used by the poll and login proofs. */
  key?: string | undefined;
  url?: string;
  headers?: Record<string, string>;
}

export interface CallResult<T> {
  data: T;
}

/** The subset of a state store the context writes through; real one in `state.ts`. */
export type ContextStore = Pick<
  StateStore,
  "write" | "reserve" | "directory" | "keyOutput" | "vaultKey"
>;

/** The operations that mint an application key, which the CLI stores in a file of its own. */
export type KeyOperationKind = "app.add" | "app.key.add";
const KEY_OPERATION_KINDS: ReadonlySet<string> = new Set<KeyOperationKind>(["app.add", "app.key.add"]);

/**
 * How long a deployment keeps an operation it ran at once. A record older than
 * this may name a row that is gone, and resending its token would then repeat
 * work that already landed rather than recover it.
 */
const OPERATION_RETENTION_MS = 90 * 86_400_000;

/** A key-minting operation once its key is safely in its output file. */
export interface KeyedOperation {
  operation: CliOperation;
  key: StoredKeyMetadata;
}

export interface Onboarding {
  account: OrganizationSummary;
  unclaimedAccess: { endsAt: string; limit?: number } | null;
  deployment: CliDeployment;
}

/**
 * The catalog's own path builder, reached generically.
 *
 * One cast, because `operationPath` takes the parameters an operation's own
 * template declares, and a generic name stands for every template at once. The
 * types a caller sees are the catalog's; this only erases them internally.
 */
const pathFor = operationPath as (
  name: OperationName,
  params?: Record<string, string>,
  query?: object,
) => string;

/** Refused now, but the same request may still be accepted later. */
const RETRYABLE_STATUS = new Set([408, 425, 429]);

/**
 * Refused by an operation the deployment already holds under this token, which
 * the local record must not outlive: a request that differs from the one the
 * token is bound to.
 */
const OPERATION_BOUND_STATUS = new Set([409, 410]);

/**
 * Whether a refusal settles the request for good, so its local record has
 * nothing left to protect.
 *
 * A record is written before the request is sent, which is what lets a lost
 * response be retried under the same token instead of repeating the work. But
 * a deployment that refuses an operation outright — an unacceptable field, a
 * duplicate slug, an expired account — wrote nothing, so there is nothing to
 * recover, and keeping the record would only make the identical command send
 * the refused token again.
 *
 * Deliberately not every 4xx: a rate limit is the same request arriving too
 * soon, and the operation-bound statuses mean the deployment does hold a record
 * this token is the key to.
 */
function definitiveRefusal(error: unknown): boolean {
  if (!(error instanceof CliError)) return false;
  const status = error.details?.status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    !RETRYABLE_STATUS.has(status) &&
    !OPERATION_BOUND_STATUS.has(status)
  );
}

/** The id the deployment gives the operation a token proves: `op:` and the token's digest. */
export function operationIdFor(token: string): string {
  return `op:${createHash("sha256").update(token).digest("hex")}`;
}

/** What `select` takes out of a completed bootstrap. */
export function bootstrapCredential(operation: CliOperation): SelectedCredential {
  const credential = operation.result?.credential;
  if (!credential || !operation.account)
    fail(
      "invalid_response",
      "The bootstrap did not return its account and management access.",
      "Run the same command again; it will not create another account.",
      3,
    );
  return { credential, account: operation.account, deployment: operation.deployment };
}

/** The credential exchange both `bootstrap` and `login` end with. */
interface SelectedCredential {
  credential: CliCredential;
  account: OrganizationSummary;
  deployment: CliDeployment;
}

export class Context {
  readonly store: ContextStore;
  readonly state: CliState;
  readonly transport: Pick<Transport, "request">;
  readonly flags: Flags;
  readonly io: ContextIo;
  /** Operations whose result this run has printed, released once stdout has taken it. */
  readonly delivered = new Set<string>();
  onboarding?: Onboarding;

  constructor(
    store: ContextStore,
    state: CliState,
    transport: Pick<Transport, "request">,
    flags: Flags,
    io: Partial<ContextIo> = {},
  ) {
    this.store = store;
    this.state = state;
    this.transport = transport;
    this.flags = flags;
    this.io = { ...defaultIo(), ...io };
  }

  get active(): ActiveConnection | null {
    return this.state.active;
  }

  get url(): string {
    return this.active?.url || CLOUD;
  }

  /** `AGW_MANAGEMENT_KEY`, when it is set to anything. */
  get environmentKey(): string | undefined {
    const value = this.io.env[MANAGEMENT_KEY_ENV]?.trim();
    return value ? value : undefined;
  }

  /**
   * The management credential every call is sent with: the environment's, which
   * always wins, or the one the selected connection stored.
   */
  get managementKey(): string | undefined {
    return this.environmentKey ?? this.active?.credential;
  }

  /** Refuses a command that would store a key the environment would then override. */
  private assertNoEnvironmentKey(): void {
    if (this.environmentKey)
      fail(
        "environment_credential",
        `${MANAGEMENT_KEY_ENV} is set, so it is the credential for every command and a stored login would never be used.`,
        `Unset ${MANAGEMENT_KEY_ENV} to log in, or keep using it as is.`,
        4,
      );
  }

  async save(): Promise<void> {
    await this.store.write(this.state);
  }

  /**
   * Sends one documented operation and parses its answer with that operation's
   * own schema.
   *
   * The parse is not a formality. zod drops what a schema does not declare, so
   * this is what keeps an undocumented server field — or anything an unexpected
   * response carries — out of the values the commands go on to print.
   */
  async publicCall<K extends OperationName>(
    name: K,
    { params, query, body, key, url, headers }: CallOptions<K> = {},
  ): Promise<CallResult<OperationResponse<K>>> {
    const wire = await this.transport.request(
      url ?? this.url,
      pathFor(name, params as Record<string, string> | undefined, query as object | undefined),
      {
        method: CATALOG[name].method,
        ...(body === undefined ? {} : { body }),
        ...(key === undefined ? {} : { key }),
        ...(headers === undefined ? {} : { headers }),
      },
    );
    return { data: this.parse(name, wire.data) };
  }

  private parse<K extends OperationName>(
    name: K,
    data: unknown,
  ): OperationResponse<K> {
    const parsed = (CATALOG[name].response as z.ZodType).safeParse(data);
    if (!parsed.success)
      fail(
        "invalid_response",
        `The deployment answered ${String(name)} with an unusable body.`,
        "Check that the CLI and the deployment are the same release.",
        3,
      );
    // The schema really is the one this operation's response type is inferred
    // from; zod's own output type just cannot be resolved through the generic
    // index into the catalog.
    return parsed.data as OperationResponse<K>;
  }

  /** The same call, with the connection's management credential attached. */
  async call<K extends OperationName>(
    name: K,
    options: CallOptions<K> = {},
  ): Promise<CallResult<OperationResponse<K>>> {
    const key = options.key ?? this.credential(name);
    try {
      return await this.publicCall(name, { ...options, key });
    } catch (error) {
      // The generic answer to a refused key is to log in, which a key taken
      // from the environment would override again.
      if (
        error instanceof CliError &&
        error.details?.status === 401 &&
        options.key === undefined &&
        this.environmentKey
      )
        throw new CliError(
          error.code,
          error.message,
          `Check ${MANAGEMENT_KEY_ENV}: the deployment refused the key it holds.`,
          error.exitCode,
          error.details,
        );
      throw error;
    }
  }

  /**
   * The current management credential, or the refusal that names the way back.
   * An admin operation is also reachable from a plain deployment connection,
   * which is why those get the wider instruction.
   */
  private credential(name: OperationName): string {
    const token = this.managementKey;
    if (!token)
      fail(
        "login_required",
        "The selected connection is not authenticated.",
        CLI_OPERATIONS.has(name)
          ? `Run agw account login, or set ${MANAGEMENT_KEY_ENV}.`
          : `Run agw account login or agw deployment connect, or set ${MANAGEMENT_KEY_ENV}.`,
        4,
      );
    return token;
  }

  /**
   * The record for one operation: the one an identical earlier command left,
   * or a new one with a fresh token, written before anything is sent.
   *
   * Reserved rather than written: an identical command running beside this
   * one must join this record, not send the same work under a second token.
   */
  private async reserveOperation(
    kind: string,
    payload: unknown,
    url: string,
  ): Promise<[string, OperationRecord]> {
    const accountId = kind === "bootstrap" ? null : this.active?.account?.id ?? null;
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ url, kind, payload }))
      .digest("hex");
    return this.store.reserve(
      this.state,
      (state) => Object.entries(state.operations).find(
        ([, record]) =>
          record.requestHash === requestHash && record.url === url && record.accountId === accountId,
      ),
      (state) => {
        const token = randomToken();
        const record: OperationRecord = {
          url,
          token,
          kind,
          requestHash,
          accountId,
          createdAt: new Date().toISOString(),
        };
        const id = operationIdFor(token);
        state.operations[id] = record;
        return [id, record];
      },
    );
  }

  /** Drops a record and persists that, best effort: the command is failing either way. */
  private async forget(id: string): Promise<void> {
    delete this.state.operations[id];
    await this.save().catch(() => {});
  }

  /**
   * Refuses to resend a record the deployment may no longer remember. The record
   * is dropped, so running the command again, once its effect has been checked,
   * sends it as a new operation — a decision the person makes, not the retry.
   */
  private async assertRecoverable(id: string, record: OperationRecord): Promise<void> {
    if (!(Date.now() - Date.parse(record.createdAt) > OPERATION_RETENTION_MS)) return;
    await this.forget(id);
    fail(
      "operation_retry_expired",
      "This unfinished operation is older than the 90-day retry window, so resending it could repeat it.",
      "Check whether it took effect; run the command again to send it as a new operation.",
      4,
      { id },
    );
  }

  /** Sends a reserved operation, dropping its record if the deployment refused it for good. */
  private async send<T>(id: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (definitiveRefusal(error)) await this.forget(id);
      throw error;
    }
  }

  /**
   * Sends one operation, or recovers the one an identical earlier command sent.
   *
   * An operation with no browser step answers completed, and its record is
   * released once the command has printed it. One that owes a browser step
   * opens the approval page and waits for it, unless the command was asked not
   * to, in which case it answers pending with the URL and the id to resume.
   */
  async operation<Kind extends CliRequestedOperationKind>(
    kind: Kind,
    payload: CliOperationPayload<Kind>,
    { browser = false, url = this.url }: { browser?: boolean; url?: string } = {},
  ): Promise<CliOperation> {
    if (!this.managementKey)
      fail(
        "login_required",
        "This operation requires account management access.",
        `Run agw account login, or set ${MANAGEMENT_KEY_ENV}.`,
        4,
      );
    const target = origin(url);
    const [id, record] = await this.reserveOperation(kind, payload, target);
    await this.assertRecoverable(id, record);
    const data = await this.send(id, async () => (await this.publicCall("createCliOperation", {
      // One member of the per-kind union: `payload` was typed by `kind` above,
      // which is the correlation the compiler cannot follow through a generic.
      body: { kind, payload, token: record.token, ...(browser ? { browser: true } : {}) } as CliOperationRequestInput,
      url: target,
      key: this.managementKey,
    })).data);
    if (data.state === "expired") {
      await this.forget(id);
      expired(data);
    }
    if (data.state !== "pending" || !data.url) {
      if (data.state === "completed") this.delivered.add(id);
      return data;
    }
    const { data: capabilities } = await this.publicCall("getCliCapabilities", { url: target });
    assertTrustedApprovalUrl(data.url, capabilities, target);
    if (!this.flags["no-open"] && !(await this.io.openBrowser(data.url)))
      this.io.stderr.write("Browser could not open. Use the returned handoff URL.\n");
    if (this.flags["no-open"] || this.flags.json || this.flags["no-input"]) return data;
    this.io.stderr.write(`Complete the browser step: ${data.url}\nOperation: ${data.id}\n`);
    return this.wait(data.id, 300);
  }

  /**
   * One operation that mints an application key, with the key written to a
   * file before anything is printed.
   *
   * The output is reserved and recorded before the operation is sent, so a
   * command that dies after the deployment answered finishes the same file on
   * its next run: the deployment still holds the key sealed for fifteen
   * minutes, and answers the same token with it rather than minting another.
   * Once the file holds the key, the record keeps only its metadata.
   */
  async keyOperation<Kind extends KeyOperationKind>(
    kind: Kind,
    payload: CliOperationPayload<Kind>,
    requestedPath: string | undefined,
  ): Promise<KeyedOperation> {
    if (!this.managementKey)
      fail(
        "login_required",
        "The selected connection is not authenticated.",
        `Run agw account login, or set ${MANAGEMENT_KEY_ENV}.`,
        4,
      );
    const target = origin(this.url);
    const [id, record] = await this.reserveOperation(kind, payload, target);
    const chosen = requestedPath ? resolve(requestedPath) : record.output?.path;
    if (record.completedAt && chosen !== record.output?.path)
      fail(
        "output_changed",
        "A completed key creation cannot move its output.",
        "Copy the protected existing file, or create a replacement with a new key name.",
        4,
      );
    const output = await this.store.keyOutput(chosen, {
      reservation: chosen && chosen === record.output?.path ? record.output : undefined,
      retain: true,
    });
    try {
      if (record.completedAt && record.keyMetadata) {
        if (record.keyMetadata.contentHash !== (await output.contentHash()))
          fail(
            "output_changed",
            "The completed key output is missing or changed.",
            "Use app key add with a new name to generate a replacement; this creation will not be repeated.",
            4,
          );
        this.delivered.add(id);
        return { operation: record.result as CliOperation, key: record.keyMetadata };
      }
      await this.assertRecoverable(id, record);
      record.output = output.reservation;
      await this.save();
      const operation = await this.send(id, async () => (await this.publicCall("createCliOperation", {
        body: { kind, payload, token: record.token } as CliOperationRequestInput,
        url: target,
        key: this.managementKey,
      })).data);
      const minted = operation.result?.api_key;
      const appId = operation.result?.app?.id ?? (payload as { app?: string }).app ?? "";
      if (operation.state !== "completed" || !minted)
        fail("invalid_response", "The server did not return the generated application key.", "Inspect the app key list before retrying.", 3);
      const { key: plaintext, ...redacted } = minted;
      if (!plaintext) {
        // Nothing is left to recover: the deployment no longer holds the key.
        await this.forget(id);
        fail(
          "key_recovery_expired",
          "This key was created, but it can no longer be recovered: its one-time recovery window ended or it was revoked.",
          "Inspect the resource and revoke or replace its key explicitly.",
          4,
          { appId, keyId: minted.id },
        );
      }
      const key = await storeKey({ ...redacted, key: plaintext }, output, appId);
      record.keyMetadata = key;
      record.result = { ...operation, result: { ...operation.result, api_key: redacted } };
      record.completedAt = new Date().toISOString();
      await this.save();
      this.delivered.add(id);
      return { operation: record.result as CliOperation, key };
    } finally {
      await output.cancel();
      // The record this file was reserved for is gone, so the operation was
      // refused outright and the reservation holds nothing.
      if (!this.state.operations[id]) await releaseOutput(output.reservation);
    }
  }

  /** Releases the records of every operation this run has printed. */
  async acknowledgeOutput(): Promise<void> {
    if (!this.delivered.size) return;
    const released = [...this.delivered].flatMap((id) => {
      const record = this.state.operations[id];
      return record ? [[id, record] as const] : [];
    });
    for (const [id] of released) delete this.state.operations[id];
    try {
      await this.save();
    } catch {
      // Kept, so a command whose output could not be acknowledged still finds
      // its operation next time rather than sending it again.
      for (const [id, record] of released) this.state.operations[id] = record;
    }
  }

  async bootstrap(): Promise<void> {
    if (this.managementKey) return;
    if (this.active)
      fail(
        "login_required",
        "This connection has prior account state; it cannot create another account.",
        "Run agw account login.",
        4,
      );
    const [id, record] = await this.reserveOperation("bootstrap", {}, CLOUD);
    // Another command started beside this one may have finished the same
    // bootstrap while this one waited for the lock, and reserving adopted its
    // connection.
    if ((this.state.active as ActiveConnection | null)?.credential) return;
    const data = await this.send(id, async () => (await this.publicCall("bootstrapCliAccount", {
      body: { token: record.token },
      url: CLOUD,
    })).data);
    const selected = bootstrapCredential(data);
    await this.select(CLOUD, selected);
    this.onboarding = {
      account: selected.account,
      unclaimedAccess: data.result?.unclaimedAccess ?? null,
      deployment: selected.deployment,
    };
    delete this.state.operations[id];
    await this.save();
  }

  async select(url: string, data: SelectedCredential): Promise<void> {
    if (!data.credential.token)
      fail(
        "invalid_response",
        "Credential exchange did not return management access.",
        "Run the same command again; do not create another account.",
        3,
      );
    if (!data.account.id || !data.deployment.id)
      fail(
        "invalid_response",
        "Credential exchange did not identify its account and deployment.",
      );
    this.state.active = {
      url: origin(url),
      credential: data.credential.token,
      account: data.account,
      deployment: data.deployment,
      authenticated: true,
    };
    await this.save();
  }

  /** `account login --key-stdin` or `--key-prompt`: a management key a person already holds. */
  async keyLogin(url: string = this.url): Promise<LoginResult> {
    this.assertNoEnvironmentKey();
    const token = await secret(this.flags, "Management API key");
    if (!token)
      fail("input_required", "A management API key is required.", "Supply it with --key-stdin.");
    const { data } = await this.publicCall("getCliAccount", { key: token, url });
    await this.select(url, { ...data, credential: { token } });
    return { connected: true, ...data };
  }

  /**
   * `deployment connect` while `AGW_MANAGEMENT_KEY` is set: selects the
   * deployment the key is checked against, and stores no key of its own.
   */
  async connectWithEnvironment(url: string): Promise<LoginResult> {
    const key = this.environmentKey!;
    const target = origin(url);
    const { data } = await this.publicCall("getCliAccount", { key, url: target });
    this.state.active = {
      url: target,
      account: data.account,
      deployment: data.deployment,
      authenticated: false,
    };
    await this.save();
    this.io.stderr.write(
      `${MANAGEMENT_KEY_ENV} is set, so it stays the credential for every command; no key was stored.\n`,
    );
    return { connected: true, ...data };
  }

  /**
   * `account login`: a person approves this CLI in a browser, and it receives
   * a management key of its own, stored exactly as a pasted one is.
   *
   * The login is recorded like every other operation before it is opened, so
   * one left waiting — by `--json`, `--no-input`, a timeout — is finished by
   * `agw operation wait`. When this process is going to wait and a browser on
   * this machine is in front of the person, it also listens on `127.0.0.1`,
   * and the approval page hands the browser back to it with a one-time code;
   * the key is then released only for that code and never to a poll.
   * Otherwise — `--no-open`, SSH, no display, nobody at the terminal — the
   * approval may happen on any device, so nothing listens and the key is
   * polled for. A browser that turns out not to open is the same case, found
   * late: that login is abandoned for one that is polled.
   */
  async browserLogin(url: string = this.url): Promise<LoginResult | CliLogin> {
    this.assertNoEnvironmentKey();
    const target = origin(url);
    const { data: capabilities } = await this.publicCall("getCliCapabilities", { url: target });
    if (!capabilities.features?.browserLogin)
      fail(
        "browser_login_unsupported",
        "This deployment does not offer browser login.",
        "Update the deployment, or pipe a management key to agw account login --key-stdin.",
        3,
      );
    const opens = !this.flags["no-open"] && this.io.browserAvailable();
    const detached = Boolean(this.flags.json || this.flags["no-input"]);
    if (detached) {
      const { login } = await this.openLogin(target, capabilities, null);
      if (opens && !(await this.io.openBrowser(login.url)))
        this.io.stderr.write("Browser could not open. Use the returned URL.\n");
      return login;
    }
    let loopback = opens ? await this.io.listen() : null;
    try {
      let opened = await this.openLogin(target, capabilities, loopback);
      if (loopback && !(await this.io.openBrowser(opened.login.url))) {
        // Nothing but a browser on this machine could finish that login, so it
        // is left to expire and one that can be approved anywhere replaces it.
        await loopback.close();
        loopback = null;
        await this.forget(opened.id);
        this.io.stderr.write(
          "The browser could not be opened, so the approval will be collected by polling.\n",
        );
        opened = await this.openLogin(target, capabilities, null);
      }
      const { id, token, login } = opened;
      const style = styleFor(this.io.stderr);
      this.io.stderr.write(
        [
          ...(login.userCode
            ? [
                `Pairing code: ${style.headline(login.userCode)}`,
                "Check that your browser shows this same code before you approve.",
              ]
            : []),
          `Approve at: ${login.url}`,
          "",
        ].join("\n"),
      );
      if (loopback) {
        try {
          await this.collectLoopbackLogin(id, token, target, capabilities, loopback);
        } finally {
          // Only this process could ever finish a loopback login: nothing a
          // later command could poll would carry its key.
          if (this.state.operations[id]) await this.forget(id);
        }
      } else await this.wait(id, LOGIN_TIMEOUT_SECONDS);
      const { data } = await this.call("getCliAccount", { url: target });
      return { connected: true, ...data };
    } finally {
      await loopback?.close();
    }
  }

  /** Records and opens one login, refusing one that is not pending on the trusted console. */
  private async openLogin(
    target: string,
    capabilities: CliCapabilitiesResponse,
    loopback: Loopback | null,
  ): Promise<{ id: string; token: string; login: CliLogin & { url: string } }> {
    const token = randomToken();
    const id = operationIdFor(token);
    await this.recordLogin(id, token, target);
    const { data: login } = await this.send(id, () => this.publicCall("openCliLogin", {
      body: {
        token,
        client: clientDescription(),
        ...(loopback ? { loopbackRedirect: loopback.redirect } : {}),
      },
      url: target,
    }));
    if (login.state !== "pending" || !login.url) {
      await this.forget(id);
      expired({
        id,
        state: "expired",
        expiresAt: login.expiresAt,
        ...(login.state === "denied" ? { denied: true as const } : {}),
      });
    }
    assertTrustedApprovalUrl(login.url, capabilities, target);
    return { id, token, login: { ...login, url: login.url } };
  }

  /** Writes a login's record before it is opened, and drops logins long since expired. */
  private async recordLogin(id: string, token: string, url: string): Promise<void> {
    const now = Date.now();
    for (const [key, record] of Object.entries(this.state.operations))
      if (record.kind === "login" && now - Date.parse(record.createdAt) > LOGIN_RECORD_MS)
        delete this.state.operations[key];
    this.state.operations[id] = {
      url,
      token,
      kind: "login",
      // Never matched: every login is a new one, since a listener's port is.
      requestHash: createHash("sha256").update(id).digest("hex"),
      accountId: null,
      createdAt: new Date(now).toISOString(),
    };
    await this.save();
  }

  /**
   * Waits for the approval page to send the browser back with the redeem code,
   * and redeems it. Polls meanwhile, since a declined or expired login never
   * comes back to the listener.
   */
  private async collectLoopbackLogin(
    id: string,
    token: string,
    url: string,
    capabilities: CliCapabilitiesResponse,
    loopback: Loopback,
  ): Promise<void> {
    let code: string | undefined;
    const arrived = loopback.code.then((value) => {
      code = value;
    });
    const end = Date.now() + LOGIN_TIMEOUT_SECONDS * 1000;
    let approvedAt: number | undefined;
    while (code === undefined) {
      const { data: status } = await this.publicCall("pollCliOperation", {
        params: { id },
        key: token,
        url,
      });
      if (code !== undefined) break;
      if (status.state === "expired") {
        await this.forget(id);
        expired(status);
      }
      if (status.state === "completed") {
        approvedAt ??= Date.now();
        if (Date.now() - approvedAt > LOOPBACK_GRACE_MS) {
          await this.forget(id);
          fail(
            "login_not_delivered",
            "The login was approved, but the browser never came back to this terminal.",
            "Run agw account login --no-open to approve it from another device, or run agw account login again here.",
            3,
            { id },
          );
        }
      }
      if (Date.now() >= end) {
        await this.forget(id);
        fail(
          "wait_timeout",
          "The login was not approved in time.",
          "Run agw account login again.",
          5,
          { id, state: status.state, expiresAt: status.expiresAt },
        );
      }
      await Promise.race([delay(Math.min(1500, Math.max(0, end - Date.now()))), arrived]);
    }
    try {
      const { data } = await this.publicCall("redeemCliLogin", {
        params: { id },
        body: { redeemCode: code },
        key: token,
        url,
      });
      await this.select(url, { ...data, deployment: capabilities.deployment });
      delete this.state.operations[id];
      await this.save();
      loopback.answer(true);
    } catch (error) {
      loopback.answer(false);
      throw error;
    }
  }

  /**
   * `account logout`: the deployment revokes the stored key, then this machine
   * forgets it. A key the deployment no longer accepts is already as good as
   * revoked; any other failure still removes it here, and says so, because a
   * machine must always be able to sign out.
   */
  async logout(): Promise<LogoutResult> {
    const active = this.active;
    const key = active?.credential;
    let revoked = false;
    if (active && key) {
      try {
        await this.publicCall("revokeCliCredential", { key, url: active.url });
        revoked = true;
      } catch (error) {
        const status = error instanceof CliError ? error.details?.status : undefined;
        if (status !== 401)
          this.io.stderr.write(
            `The key could not be revoked (${error instanceof Error ? error.message : "unknown error"}). ` +
              "It was removed from this machine; revoke it on the console's keys page.\n",
          );
      }
    }
    if (active) {
      delete active.credential;
      active.authenticated = false;
      await this.save();
    }
    if (this.environmentKey)
      this.io.stderr.write(
        `${MANAGEMENT_KEY_ENV} is still set, so it stays the credential for every command; unset it to sign out completely.\n`,
      );
    return { loggedOut: true, revoked };
  }

  async poll(id: string): Promise<CliOperation> {
    const record = this.state.operations[id];
    if (!record)
      fail(
        "operation_unknown",
        "This operation has no locally stored token.",
        "Resume it from the machine that initiated the operation.",
        4,
      );
    // A login selects the deployment it was opened on, whatever was selected before.
    if (this.active && this.active.url !== record.url && record.kind !== "login")
      fail(
        "operation_context",
        "This operation belongs to another selected deployment.",
        "Reconnect explicitly to the operation’s originating deployment.",
        4,
      );
    // Its key goes to a protected file, never to stdout, and only the command
    // that reserved that file can finish it.
    if (KEY_OPERATION_KINDS.has(record.kind))
      fail(
        "operation_key_output",
        "This operation delivers an application key to a file.",
        "Run the command that created it again to finish its key file.",
        4,
      );
    const { data } = await this.publicCall("pollCliOperation", {
      params: { id },
      key: record.token,
      url: record.url,
    });
    if (data.state === "expired") await this.forget(id);
    if (data.state === "completed" && record.kind === "login") return this.polledLogin(id, record, data);
    if (data.state === "completed") {
      // A claim only ever adds a human owner: this connection keeps the
      // credential it polled with, so nothing here is invalidated by it. Only
      // the connection to the account it claimed learns of it.
      if (
        record.kind === "claim"
        && data.account
        && this.active?.account?.id === record.accountId
        && data.account.id === record.accountId
      ) {
        this.active.account = data.account;
        await this.save();
      }
      this.delivered.add(id);
    }
    return data;
  }

  /**
   * A completed login, as a poll first sees it: its key is stored the way a
   * pasted one is, and taken out of what the command prints. A login whose key
   * was already handed to another poll, or is only ever redeemed, cannot be
   * collected here.
   */
  private async polledLogin(
    id: string,
    record: OperationRecord,
    data: CliOperation,
  ): Promise<CliOperation> {
    const { credential, ...result } = data.result ?? {};
    if (credential) {
      if (!data.account)
        fail(
          "invalid_response",
          "The login did not say which account it was approved into.",
          "Run agw account login again.",
          3,
        );
      await this.select(record.url, { credential, account: data.account, deployment: data.deployment });
    } else if (
      !(
        this.active?.credential &&
        this.active.url === record.url &&
        data.account &&
        this.active.account?.id === data.account.id
      )
    ) {
      await this.forget(id);
      fail(
        "login_not_delivered",
        "This login was approved, but its key can no longer be collected here.",
        "Run agw account login again.",
        3,
        { id },
      );
    }
    this.delivered.add(id);
    return { ...data, result };
  }

  async wait(id: string, timeout: number): Promise<CliOperation> {
    const end = Date.now() + timeout * 1000;
    for (;;) {
      const result = await this.poll(id);
      if (result.state !== "pending") {
        if (result.state !== "completed") expired(result);
        return result;
      }
      if (Date.now() >= end)
        fail(
          "wait_timeout",
          "Operation is still pending.",
          "Run agw operation wait " + id + " to resume.",
          5,
          { id: result.id, state: result.state, expiresAt: result.expiresAt },
        );
      await delay(Math.min(1500, end - Date.now()));
    }
  }
}

/** The refusal for a browser step that was declined or ran out of time; its record is already gone. */
function expired(operation: Pick<CliOperation, "id" | "state" | "expiresAt" | "denied">): never {
  if (operation.denied)
    fail(
      "operation_denied",
      "The browser step was declined.",
      "Run the same command again to start a new one.",
      3,
      { id: operation.id, state: "denied", expiresAt: operation.expiresAt },
    );
  fail(
    "operation_expired",
    "The browser step expired before it was approved.",
    "Run the same command again to start a new one.",
    3,
    { id: operation.id, state: operation.state, expiresAt: operation.expiresAt },
  );
}

/**
 * Writes a minted key to its reserved output and answers with what may be kept
 * of it. A write that fails leaves the operation's record in place: the
 * deployment still holds the key sealed for fifteen minutes, so the same
 * command finishes the same file rather than minting a second key.
 */
async function storeKey(
  minted: CreatedApiKey,
  output: ReservedOutput,
  appId: string,
): Promise<StoredKeyMetadata> {
  try {
    await output.write(minted.key + "\n");
  } catch {
    fail(
      "key_output_pending",
      "The key was created, but its output file could not be written.",
      "Retry the same command within fifteen minutes to finish the file, or choose a new --key-output path. No second key will be generated.",
      4,
      { appId, keyId: minted.id, storagePath: output.path },
    );
  }
  return {
    id: minted.id,
    name: minted.name,
    key_prefix: minted.key_prefix,
    created_at: minted.created_at,
    storagePath: output.path,
    contentHash: createHash("sha256").update(minted.key + "\n").digest("hex"),
  };
}

/** Refuses an approval URL that is not on the deployment's own console. */
function assertTrustedApprovalUrl(
  url: string,
  capabilities: CliCapabilitiesResponse,
  target: string,
): void {
  const browserUrl = new URL(url);
  const trustedOrigin = origin(
    capabilities.consoleOrigin ?? capabilities.deployment.consoleOrigin ?? target,
  );
  if (browserUrl.origin !== trustedOrigin || browserUrl.username || browserUrl.password)
    fail("invalid_response", "The approval URL is not on this deployment’s trusted console origin.");
}

export async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
