import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CliAccount,
  CliAccountResponse,
  CliCredential,
  CliDeployment,
  CliOperation,
  CliOperationPayload,
  CliOperationRequestInput,
  CliRequestedOperationKind,
} from "../../src/contracts/cli.ts";
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
import { CliError, CLOUD, fail, origin, randomToken } from "./common.ts";
import { secret } from "./input.ts";
import type { Flags } from "./parser.ts";
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
]);

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
  account: CliAccount;
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
  account: CliAccount;
  deployment: CliDeployment;
}

export class Context {
  readonly store: ContextStore;
  readonly state: CliState;
  readonly transport: Pick<Transport, "request">;
  readonly flags: Flags;
  /** Operations whose result this run has printed, released once stdout has taken it. */
  readonly delivered = new Set<string>();
  onboarding?: Onboarding;

  constructor(
    store: ContextStore,
    state: CliState,
    transport: Pick<Transport, "request">,
    flags: Flags,
  ) {
    this.store = store;
    this.state = state;
    this.transport = transport;
    this.flags = flags;
  }

  get active(): ActiveConnection | null {
    return this.state.active;
  }

  get url(): string {
    return this.active?.url || CLOUD;
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
    return this.publicCall(name, { ...options, key: options.key ?? this.credential(name) });
  }

  /**
   * The current management credential, or the refusal that names the way back.
   * An admin operation is also reachable from a plain deployment connection,
   * which is why those get the wider instruction.
   */
  private credential(name: OperationName): string {
    const token = this.active?.credential;
    if (!token)
      fail(
        "login_required",
        "The selected connection is not authenticated.",
        CLI_OPERATIONS.has(name)
          ? "Run agw account login."
          : "Run agw account login or agw deployment connect.",
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
  private async send(
    id: string,
    request: () => Promise<CliOperation>,
  ): Promise<CliOperation> {
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
    if (!this.active?.credential)
      fail(
        "login_required",
        "This operation requires account management access.",
        "Run agw account login.",
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
      key: this.active?.credential,
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
    const browserUrl = new URL(data.url);
    const trustedOrigin = origin(
      capabilities.consoleOrigin ?? capabilities.deployment.consoleOrigin ?? target,
    );
    if (browserUrl.origin !== trustedOrigin || browserUrl.username || browserUrl.password)
      fail("invalid_response", "The approval URL is not on this deployment’s trusted console origin.");
    if (!this.flags["no-open"]) await openBrowser(data.url);
    if (this.flags["no-open"] || this.flags.json || this.flags["no-input"]) return data;
    process.stderr.write(`Complete the browser step: ${data.url}\nOperation: ${data.id}\n`);
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
    if (!this.active?.credential)
      fail("login_required", "The selected connection is not authenticated.", "Run agw account login.", 4);
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
        key: this.active?.credential,
      })).data);
      const minted = operation.result?.api_key;
      const appId = operation.result?.app?.id ?? (payload as { app?: string }).app ?? "";
      if (operation.state !== "completed" || !minted)
        fail("invalid_response", "The server did not return the generated application key.", "Inspect the app key list before retrying.", 3);
      if (!minted.key) {
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
      const key = await storeKey(minted.key, minted, output, appId);
      const { key: _plaintext, ...redacted } = minted;
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
    if (this.active?.credential) return;
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

  async login(url: string = this.url): Promise<CliAccountResponse & { connected: true }> {
    const token = await secret(this.flags, "Management API key");
    if (!token)
      fail("input_required", "A management API key is required.", "Supply it with --key-stdin.");
    const { data } = await this.publicCall("getCliAccount", { key: token, url });
    await this.select(url, { ...data, credential: { token } });
    return { connected: true, ...data };
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
    if (this.active && this.active.url !== record.url)
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

/** The refusal for a browser step that ran out of time; its record is already gone. */
function expired(operation: CliOperation): never {
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
  plaintext: string,
  minted: { id: string; name: string; key_prefix: string; created_at: string },
  output: ReservedOutput,
  appId: string,
): Promise<StoredKeyMetadata> {
  try {
    await output.write(plaintext + "\n");
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
    contentHash: createHash("sha256").update(plaintext + "\n").digest("hex"),
  };
}

export async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", () => {
      process.stderr.write(
        "Browser could not open. Use the returned handoff URL.\n",
      );
      resolve();
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
