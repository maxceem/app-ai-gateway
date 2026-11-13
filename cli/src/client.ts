/**
 * The gateway's documented operations, as the CLI sends them.
 *
 * Everything that makes a request is here and nothing else is: which URL it
 * goes to, which credential it carries, the path and method the catalog
 * declares for it, and the parse of its answer with that operation's own
 * response schema. `Transport` beneath it owns the wire — refusing redirects,
 * and turning a refusal into a `CliError` that carries the deployment's code
 * and status. What a command does with an answer — records, prompts, waiting
 * on a browser step — is `Context`'s.
 */

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
import { CliError, fail, MANAGEMENT_KEY_ENV } from "./common.ts";
import { formatPath, tolerant } from "./tolerant.ts";
import type { Transport } from "./transport.ts";

export type { OperationName };

/** The `/v1/cli` half of the table, which a deployment connection cannot reach. */
const CLI_OPERATIONS = new Set<OperationName>([
  "getCliCapabilities",
  "listCliTools",
  "callCliTool",
  "bootstrapCliAccount",
  "createCliOperation",
  "pollCliOperation",
  "getCliAccount",
  "getCliUsage",
  "openCliLogin",
  "redeemCliLogin",
  "revokeCliCredential",
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
  /** Overrides the transport's 30-second timeout. */
  timeoutMs?: number;
}

export interface CallResult<T> {
  data: T;
  /**
   * Where the answer carried settings this release does not know, which a
   * newer deployment may send; absent when it carried none. They are kept in
   * `data` as they were sent, so a command that writes them back loses none.
   */
  newer?: string[];
  /** The headers the answer came with, where the transport kept them. */
  headers?: Headers;
}

/**
 * Where a request goes and what it carries, read when each request is sent:
 * a command may select another connection, or log in, between two of them.
 */
export interface ClientSource {
  /** The selected deployment's URL, the default target of every request. */
  url(): string;
  /** The management credential every `call` carries: the environment's, or the connection's. */
  managementKey(): string | undefined;
  /** `AGW_MANAGEMENT_KEY`, when it is set, which changes the remedy for a refused key. */
  environmentKey(): string | undefined;
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

export class GatewayClient {
  readonly transport: Pick<Transport, "request">;
  private readonly source: ClientSource;

  constructor(transport: Pick<Transport, "request">, source: ClientSource) {
    this.transport = transport;
    this.source = source;
  }

  /**
   * Sends one documented operation and parses its answer with that operation's
   * own schema.
   *
   * The parse is not a formality. zod drops what a schema does not declare, so
   * this is what keeps an undocumented server field — or anything an unexpected
   * response carries — out of the values the commands go on to print. The one
   * exception is the configuration grammar's own strict objects, whose
   * unknown keys a newer deployment may have written: see `parse` below.
   */
  async publicCall<K extends OperationName>(
    name: K,
    { params, query, body, key, url, headers, timeoutMs }: CallOptions<K> = {},
  ): Promise<CallResult<OperationResponse<K>>> {
    const wire = await this.transport.request(
      url ?? this.source.url(),
      pathFor(name, params as Record<string, string> | undefined, query as object | undefined),
      {
        method: CATALOG[name].method,
        ...(body === undefined ? {} : { body }),
        ...(key === undefined ? {} : { key }),
        ...(headers === undefined ? {} : { headers }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    );
    const result = parse(name, wire.data);
    if (wire.headers) result.headers = wire.headers;
    return result;
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
        this.source.environmentKey()
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
   * One operation whose success is a file rather than JSON, with the
   * connection's management credential: its bytes, as the deployment sent them.
   */
  async download<K extends OperationName>(
    name: K,
    { params, query }: Pick<CallOptions<K>, "params" | "query"> = {},
  ): Promise<Uint8Array> {
    const wire = await this.transport.request(
      this.source.url(),
      pathFor(name, params as Record<string, string> | undefined, query as object | undefined),
      { method: CATALOG[name].method, key: this.credential(name), binary: true },
    );
    if (!(wire.data instanceof Uint8Array))
      fail("invalid_response", `The deployment answered ${String(name)} with an unusable body.`, undefined, 3);
    return wire.data;
  }

  /**
   * The current management credential, or the refusal that names the way back.
   * An admin operation is also reachable from a plain deployment connection,
   * which is why those get the wider instruction.
   */
  private credential(name: OperationName): string {
    const token = this.source.managementKey();
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
}

/**
 * An answer, parsed with its operation's own schema.
 *
 * A deployment is updated underneath the CLI that manages it, so an answer the
 * strict parse refuses gets a second, tolerant reading: when everything wrong
 * with it is something a newer release could have added — a key the
 * configuration grammar does not declare, a value an enum does not list — it
 * is accepted with those additions kept as sent, and `newer` names where they
 * are. A missing field, a wrong type or a failed check on a part with no
 * addition in it is still refused.
 */
function parse<K extends OperationName>(name: K, data: unknown): CallResult<OperationResponse<K>> {
  const read = tolerant(CATALOG[name].response as z.ZodType, data);
  if (!read)
    fail(
      "invalid_response",
      `The deployment answered ${String(name)} with an unusable body.`,
      "Check that the CLI and the deployment are the same release.",
      3,
    );
  // The schema really is the one this operation's response type is inferred
  // from; zod's own output type just cannot be resolved through the generic
  // index into the catalog. A tolerated answer is that type with additions
  // the type does not name, which every reader of it ignores.
  const result: CallResult<OperationResponse<K>> = { data: read.data as OperationResponse<K> };
  if (read.unknown.length) result.newer = read.unknown.map((entry) => formatPath(entry.path));
  return result;
}
