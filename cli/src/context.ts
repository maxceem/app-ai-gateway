import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CliAccount,
  CliAccountResponse,
  CliCredential,
  CliDeployment,
  CliOperationKind,
  CliOperationResponse,
  CliPollResponse,
} from "../../src/contracts/cli.ts";
import type { z } from "zod";
import {
  AppResponseSchema,
  CreatedApiKeySchema,
  ProviderGatewayResponseSchema,
  ProviderResponseSchema,
  type CreatedApiKey,
} from "../../src/contracts/responses.ts";
import { responseSchemaFor } from "../../src/contracts/operation-schemas.ts";
import {
  operations,
  type HttpMethod,
  type OperationParams,
  type OperationRequest,
  type OperationResponse,
} from "../../src/contracts/operations.ts";
import { CliError, CLOUD, fail, origin, randomToken } from "./common.ts";
import { secret } from "./input.ts";
import type { Flags } from "./parser.ts";
import { releaseOutput } from "./state.ts";
import type {
  ActiveConnection,
  CliState,
  MutationRecord,
  OutputReservation,
  ReservedOutput,
  StateStore,
  StoredKeyMetadata,
} from "./state.ts";
import type { Transport } from "./transport.ts";

export type OperationName = keyof typeof operations;
type Descriptor<K extends OperationName> = (typeof operations)[K];

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
  body?: OperationRequest<Descriptor<K>>;
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

/** The creations that go through the idempotent receipt path. */
export type CreateOperationName =
  | "createApp"
  | "createAppKey"
  | "createProvider"
  | "createProviderGateway";

/**
 * What a completed creation is allowed to leave behind in protected state.
 *
 * Each entry is the live response minus its one-time plaintext, and zod drops
 * what it does not declare. That matters because these two records have
 * different lifetimes: the recovery copy in `mutation.response` holds the real
 * key and is deleted the moment the chosen output file is written, while this
 * one survives until stdout has been acknowledged — and survives a crash in
 * between, on disk. A key that has already been delivered has no business
 * being in it, and a replay does not need it: `keyStored` recorded the key's
 * non-secret metadata before `complete` was ever called.
 */
const RECORDED_RESULT = {
  createApp: AppResponseSchema.extend({
    api_key: CreatedApiKeySchema.omit({ key: true }).nullable(),
  }),
  createAppKey: CreatedApiKeySchema.omit({ key: true }),
  createProvider: ProviderResponseSchema,
  createProviderGateway: ProviderGatewayResponseSchema,
} as const;

export type RecordedResult<K extends CreateOperationName> = z.infer<(typeof RECORDED_RESULT)[K]>;

/** The same map, widened so a generic operation name indexes one schema. */
const recordedResultFor: { [K in CreateOperationName]: z.ZodType<RecordedResult<K>> } =
  RECORDED_RESULT;

/**
 * What `app add` and `app key add` hand back once a creation has landed.
 *
 * `data` is the live response on the run that created the resource, and the
 * redacted recorded copy on a replay — which is why the key-bearing commands
 * read `keyMetadata` first and only reach for a minted key when there is none.
 */
export interface CreateOutcome<Live, Recorded> {
  data: Live | Recorded;
  /** Present exactly when `data` is the replayed copy. */
  keyMetadata?: StoredKeyMetadata | undefined;
  keyStored?: (metadata: StoredKeyMetadata) => Promise<void>;
  complete: () => Promise<void>;
}

export interface KeyOutput extends ReservedOutput {
  recoveryAvailable: () => boolean;
  mutation: MutationRecord;
}

export interface Onboarding {
  account: CliAccount;
  trial: { endsAt: string; limit?: number } | null;
  deployment: CliDeployment;
}

/** Refused now, but the same request may still be accepted later. */
const RETRYABLE_STATUS = new Set([408, 425, 429]);

/**
 * Refused by a receipt the deployment already holds, which this one must not
 * outlive: a mismatched proof, a bound request that differs, or a resource that
 * was created and whose one-time response is gone.
 */
const RECEIPT_BOUND_STATUS = new Set([409, 410]);

/**
 * Whether a refusal settles the request for good, so its local receipt has
 * nothing left to protect.
 *
 * A receipt is reserved before the request is sent, which is what lets a lost
 * response be retried under the same idempotency key instead of creating a
 * second resource. But a deployment that refuses a creation outright — an
 * unacceptable field, a duplicate slug, an expired account — commits no receipt
 * of its own, because the server writes one only in the same transaction as the
 * resource. So nothing was created, nothing can be recovered, and keeping the
 * local record only means the identical command is refused as an unfinished
 * creation once it is ninety days old.
 *
 * Deliberately not every 4xx: a rate limit is the same request arriving too
 * soon, and the two receipt-bound statuses mean the deployment does hold a
 * record this one is the key to.
 */
function definitiveRefusal(error: unknown): boolean {
  if (!(error instanceof CliError)) return false;
  const status = error.details?.status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    !RETRYABLE_STATUS.has(status) &&
    !RECEIPT_BOUND_STATUS.has(status)
  );
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
  readonly deliveredMutations = new Set<string>();
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
    params: OperationParams<Descriptor<K>>,
    { body, key, url, headers }: CallOptions<K> = {},
  ): Promise<CallResult<OperationResponse<Descriptor<K>>>> {
    // One cast, because indexing the table with a generic name yields a union of
    // path builders that no single signature can describe. The types the caller
    // sees come from the descriptor, which is what this erases.
    const descriptor = operations[name] as unknown as {
      method: HttpMethod;
      path: (...params: readonly unknown[]) => string;
    };
    const wire = await this.transport.request(
      url ?? this.url,
      descriptor.path(...(params as readonly unknown[])),
      {
        method: descriptor.method,
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
  ): OperationResponse<Descriptor<K>> {
    const parsed = responseSchemaFor[name].safeParse(data);
    if (!parsed.success)
      fail(
        "invalid_response",
        `The deployment answered ${String(name)} with an unusable body.`,
        "Check that the CLI and the deployment are the same release.",
        3,
      );
    // The map is declared as `ResponseSchemaMap`, so the schema really is the
    // one this operation's response type calls for; zod's own output type just
    // cannot be resolved through the generic index.
    return parsed.data as OperationResponse<Descriptor<K>>;
  }

  /** A completed creation's recorded copy, re-checked as it is read back. */
  private parseRecorded<K extends CreateOperationName>(
    name: K,
    value: unknown,
  ): RecordedResult<K> {
    const parsed = recordedResultFor[name].safeParse(value);
    if (!parsed.success)
      fail(
        "invalid_state",
        "The recorded result of a completed creation is unreadable.",
        "Inspect the resource directly; this creation will not be repeated.",
        4,
      );
    return parsed.data;
  }

  /** The same call, with the connection's management credential attached. */
  async call<K extends OperationName>(
    name: K,
    params: OperationParams<Descriptor<K>>,
    options: CallOptions<K> = {},
  ): Promise<CallResult<OperationResponse<Descriptor<K>>>> {
    return this.publicCall(name, params, {
      ...options,
      key: options.key ?? this.credential(name),
    });
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

  async prepareCreate(path: string, body: unknown): Promise<MutationRecord> {
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ url: this.url, path, body }))
      .digest("hex");
    // Reserved rather than written: an identical command running beside this
    // one must join this receipt, not create a second resource with its own.
    return this.store.reserve(
      this.state,
      (state) =>
        Object.values(state.mutations ?? {}).find(
          (entry) =>
            entry.requestHash === requestHash &&
            (entry.accountId === null ||
              entry.accountId === this.active?.account?.id),
        ),
      (state) => {
        const mutation: MutationRecord = {
          id: randomToken(),
          proof: randomToken(),
          requestHash,
          url: this.url,
          accountId: this.active?.account?.id ?? null,
          path,
          createdAt: new Date().toISOString(),
        };
        (state.mutations ??= {})[mutation.id] = mutation;
        return mutation;
      },
    );
  }

  async keyOutput(
    path: string,
    body: unknown,
    requestedPath: string | undefined,
  ): Promise<KeyOutput> {
    const mutation = await this.prepareCreate(path, body);
    const chosen = requestedPath
      ? resolve(requestedPath)
      : mutation.output?.path;
    if (mutation.completedAt && chosen !== mutation.output?.path)
      fail(
        "output_changed",
        "A completed key creation cannot move its output.",
        "Copy the protected existing file, or create a replacement with a new key name.",
        4,
      );
    const existing: OutputReservation | undefined =
      chosen && chosen === mutation.output?.path ? mutation.output : undefined;
    const output = await this.store.keyOutput(chosen, {
      reservation: existing,
      retain: true,
    });
    if (
      mutation.completedAt &&
      mutation.keyMetadata?.contentHash !== (await output.contentHash())
    ) {
      await output.cancel();
      fail(
        "output_changed",
        "The completed key output is missing or changed.",
        "Use app key add with a new name to generate a replacement; this creation will not be repeated.",
        4,
      );
    }
    mutation.output = output.reservation;
    await this.save();
    return {
      ...output,
      recoveryAvailable: () => Boolean(mutation.response),
      mutation,
      cancel: async () => {
        await output.cancel();
        // The receipt this file was reserved for is gone, so the creation was
        // refused outright and the reservation holds nothing. Released after
        // the handle is closed, so Windows can remove it too.
        if (!this.state.mutations?.[mutation.id])
          await releaseOutput(output.reservation);
      },
    };
  }

  /**
   * One idempotent creation, recoverable across a lost response or a crash.
   *
   * The receipt in protected state holds the original server answer until the
   * command has printed it; `complete` is what releases it.
   */
  async create<K extends CreateOperationName>(
    name: K,
    params: OperationParams<Descriptor<K>>,
    body: OperationRequest<Descriptor<K>>,
  ): Promise<CreateOutcome<OperationResponse<Descriptor<K>>, RecordedResult<K>>> {
    if (!this.active?.credential)
      fail(
        "login_required",
        "The selected connection is not authenticated.",
        "Run agw account login.",
        4,
      );
    const descriptor = operations[name] as unknown as {
      path: (...params: readonly unknown[]) => string;
    };
    const path = descriptor.path(...(params as readonly unknown[]));
    const mutation = await this.prepareCreate(path, body);
    if (mutation.accountId === null) {
      mutation.accountId = this.active.account?.id ?? null;
      await this.save();
    }
    if (mutation.failure)
      fail(
        "key_storage_failed",
        "This creation ended with a revoked or unverified key.",
        `Inspect agw app key list ${mutation.failure.appId}; use a new key name to replace it.`,
        4,
        mutation.failure,
      );
    if (mutation.completedAt) {
      this.deliveredMutations.add(mutation.id);
      return {
        // Parsed against the recorded shape, not the live one: this copy never
        // held the plaintext, so the live schema would reject it — and a state
        // file that somehow grew one is stripped again on the way out.
        data: this.parseRecorded(name, mutation.result),
        keyMetadata: mutation.keyMetadata,
        complete: async () => {},
      };
    }
    if (
      !mutation.response &&
      Date.now() - Date.parse(mutation.createdAt) > 90 * 24 * 60 * 60 * 1000
    )
      fail(
        "resource_retry_expired",
        "This unfinished creation is older than the supported 90-day retry window.",
        "Inspect your apps and keys and recover the existing resource explicitly; this command will not create another one.",
        4,
      );
    let data: OperationResponse<Descriptor<K>>;
    if (mutation.response !== undefined) {
      const recovered = this.parse(name, mutation.response);
      const keyRecord = recoveredKey(name, recovered);
      if (keyRecord) {
        const appId = recoveredAppId(name, recovered, params);
        const { data: existing } = await this.call("listAppKeys", [appId]);
        if (
          !existing.keys.some(
            (key) => key.id === keyRecord.id && key.status === "active",
          )
        ) {
          mutation.failure = { appId, keyId: keyRecord.id, revoked: true };
          delete mutation.response;
          await this.save();
          fail(
            "resource_key_unavailable",
            "The recovered application key was revoked or removed.",
            "Create a replacement key with a new name; the previous creation will not be repeated.",
            4,
            mutation.failure,
          );
        }
      }
      data = recovered;
    } else {
      const response = await this.call(name, params, {
        body,
        headers: {
          "Idempotency-Key": mutation.id,
          "X-Idempotency-Proof": mutation.proof,
        },
      }).catch(async (error: unknown) => {
        await this.discard(mutation, error);
        throw error;
      });
      data = response.data;
      // Persist the original one-time response before writing the chosen output.
      // This protected recovery copy makes a disk-write retry independent of HTTP.
      mutation.response = data;
      await this.save();
    }
    return {
      data,
      keyStored: async (metadata: StoredKeyMetadata) => {
        mutation.keyMetadata = metadata;
        await this.save();
      },
      complete: async () => {
        mutation.result = recordedResultFor[name].parse(data);
        mutation.completedAt = new Date().toISOString();
        delete mutation.response;
        await this.save();
        this.deliveredMutations.add(mutation.id);
      },
    };
  }

  /**
   * Drops a receipt whose creation the deployment refused for good.
   *
   * Best effort on purpose: the refusal is what the caller is about to see, and
   * a state file that could not be rewritten must not replace it with a
   * different failure. The worst a failed write leaves behind is the record
   * this would have removed, which is where the CLI stood before.
   */
  private async discard(mutation: MutationRecord, error: unknown): Promise<void> {
    if (!definitiveRefusal(error)) return;
    delete this.state.mutations?.[mutation.id];
    await this.save().catch(() => {});
  }

  async acknowledgeOutput(): Promise<void> {
    if (!this.deliveredMutations.size) return;
    const previous = this.state.mutations;
    this.state.mutations = Object.fromEntries(
      Object.entries(previous ?? {}).filter(
        ([id]) => !this.deliveredMutations.has(id),
      ),
    );
    try {
      await this.save();
    } catch {
      this.state.mutations = previous;
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
    // Reserved rather than written: two first commands started side by side
    // must send one proof between them, never create two accounts. A command
    // that finds the account already created joins it and reserves nothing.
    const reservation = await this.store.reserve<CliState["bootstrap"] | null>(
      this.state,
      (state) => (state.active?.credential ? null : state.bootstrap),
      (state) =>
        (state.bootstrap = {
          createdAt: new Date().toISOString(),
          idempotencyKey: randomToken(),
          pollToken: randomToken(),
        }),
    );
    if (!reservation) return;
    const pendingSince = Date.parse(reservation.createdAt ?? "");
    if (
      !Number.isFinite(pendingSince) ||
      Date.now() - pendingSince >= 90 * 86400000
    )
      fail(
        "bootstrap_retry_expired",
        "This pending bootstrap has no valid recovery timestamp or is older than 90 days.",
        "Recover your existing account through account login; this command will not create another account automatically.",
        4,
      );
    const { idempotencyKey, pollToken } = reservation;
    const { data } = await this.publicCall(
      "bootstrapCliAccount",
      [],
      { body: { idempotencyKey, pollToken }, url: CLOUD },
    ).catch(async (error: unknown) => {
      // The same rule as a refused creation: a definitive refusal leaves no
      // account behind this key, so keeping it would only turn the next first
      // command into a stale pending bootstrap.
      if (definitiveRefusal(error)) {
        delete this.state.bootstrap;
        await this.save().catch(() => {});
      }
      throw error;
    });
    await this.select(CLOUD, data);
    this.onboarding = {
      account: data.account,
      trial: data.trial,
      deployment: data.deployment,
    };
    delete this.state.bootstrap;
    await this.save();
  }

  async select(url: string, data: SelectedCredential): Promise<void> {
    if (!data.credential.token)
      fail(
        "invalid_response",
        "Credential exchange did not return management access.",
        "Resume the operation; do not create another account.",
        3,
      );
    if (!data.account.id || !data.deployment.id)
      fail(
        "invalid_response",
        "Credential exchange did not identify its account and deployment.",
      );
    const next: ActiveConnection = {
      url: origin(url),
      credential: data.credential.token,
      account: data.account,
      deployment: data.deployment,
      authenticated: true,
    };
    if (this.active && this.active.url !== next.url)
      this.state.previous = this.active;
    this.state.active = next;
    this.state.generation = (this.state.generation ?? 0) + 1;
    await this.save();
  }

  async login(url: string = this.url): Promise<CliAccountResponse & { connected: true }> {
    const token = await secret(this.flags, "Management API key");
    if (!token)
      fail("input_required", "A management API key is required.", "Supply it with --key-stdin.");
    const { data } = await this.publicCall("getCliAccount", [], { key: token, url });
    await this.select(url, { ...data, credential: { token } });
    return { connected: true, ...data };
  }

  async operation(
    kind: CliOperationKind,
    payload: Record<string, unknown>,
    url: string = this.url,
    authenticated = true,
  ): Promise<CliOperationResponse | CliPollResponse> {
    if (authenticated && !this.active?.credential)
      fail(
        "login_required",
        "This handoff requires account management access.",
        "Run agw account login.",
        4,
      );
    const target = origin(url);
    const reusable = Object.entries(this.state.operations).find(
      ([, op]) =>
        op.phase === "initiating" &&
        op.url === target &&
        op.kind === kind &&
        JSON.stringify(op.payload) === JSON.stringify(payload),
    );
    const localId = reusable?.[0] ?? randomToken();
    if (!reusable) {
      this.state.operations[localId] = {
        url: target,
        pollToken: randomToken(),
        kind,
        phase: "initiating",
        payload,
        generation: this.state.generation ?? 0,
      };
      await this.save();
    }
    const operation = this.state.operations[localId]!;
    const { data: capabilities } = await this.publicCall("getCliCapabilities", [], {
      url: target,
    });
    const { data } = await this.publicCall("createCliOperation", [], {
      body: { kind, payload, pollToken: operation.pollToken },
      url: target,
      ...(authenticated ? { key: this.active?.credential } : {}),
    });
    const browserUrl = new URL(data.url);
    const trustedOrigin = origin(
      capabilities.consoleOrigin ?? capabilities.deployment.consoleOrigin ?? target,
    );
    if (
      browserUrl.origin !== trustedOrigin ||
      browserUrl.username ||
      browserUrl.password
    )
      fail(
        "invalid_response",
        "The handoff URL is not on this deployment’s trusted console origin.",
      );
    this.state.operations[data.id] = { ...operation, phase: "pending" };
    delete this.state.operations[localId];
    await this.save();
    if (!this.flags["no-open"]) await openBrowser(data.url);
    if (this.flags["no-open"] || this.flags.json || this.flags["no-input"])
      return data;
    process.stderr.write(
      `Complete the browser handoff: ${data.url}\nOperation: ${data.id}\n`,
    );
    return this.wait(data.id, 300);
  }

  async poll(id: string): Promise<CliPollResponse> {
    const operation = this.state.operations[id];
    if (!operation)
      fail(
        "operation_unknown",
        "This operation has no locally stored polling authorization.",
        "Resume it from the machine that initiated the operation.",
        4,
      );
    if (this.active && this.active.url !== operation.url)
      fail(
        "operation_context",
        "This operation belongs to another selected deployment.",
        "Reconnect explicitly to the operation’s originating deployment.",
        4,
      );
    const { data } = await this.publicCall("pollCliOperation", [id], {
      key: operation.pollToken,
      url: operation.url,
    });
    if (
      data.state === "completed" &&
      !operation.completed &&
      operation.kind === "claim"
    ) {
      if ((this.state.generation ?? 0) !== operation.generation)
        fail(
          "operation_context",
          "The active connection changed after this operation began.",
          "Start a new login for the intended connection.",
          4,
        );
      operation.completed = true;
      if (this.active) {
        if (data.account) this.active.account = data.account;
        if (data.result?.accessGranted === false) {
          delete this.active.credential;
          this.active.authenticated = false;
          this.state.generation = (this.state.generation ?? 0) + 1;
        }
      }
      await this.save();
    }
    return data;
  }

  async wait(id: string, timeout: number): Promise<CliPollResponse> {
    const end = Date.now() + timeout * 1000;
    for (;;) {
      const result = await this.poll(id);
      if (result.state !== "pending") {
        if (result.state !== "completed")
          fail(
            "operation_" + result.state,
            "The browser handoff " + result.state + ".",
            "Start a new handoff if needed.",
            3,
            { id: result.id, state: result.state, expiresAt: result.expiresAt },
          );
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

/** The one-time key a creation may have minted, whichever creation it was. */
function recoveredKey(name: CreateOperationName, data: unknown): CreatedApiKey | null {
  if (name === "createApp") return (data as { api_key: CreatedApiKey | null }).api_key;
  if (name === "createAppKey") return data as CreatedApiKey;
  return null;
}

function recoveredAppId(
  name: CreateOperationName,
  data: unknown,
  params: readonly unknown[],
): string {
  if (name === "createApp") return (data as { app: { id: string } }).app.id;
  return String(params[0]);
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
