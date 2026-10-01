/**
 * What any credential of an account may learn about one of its operations,
 * and the one place a key an operation created is handed to a person.
 *
 * Both read through the engine, which shows an operation only to a caller of
 * the account that opened it and answers everyone else as though it did not
 * exist, hides its own internal kinds from both, and keeps a sealed outcome
 * out of every answer but a reveal.
 */

import type { AuthState, OperationStatus } from "@maxceem/cf-auth";
import { engineRefused } from "../auth/identity";
import { isReservedKindName } from "../auth/operation-kinds";
import type {
  OperationResult,
  OperationStatusResponse,
  RevealedOperationResponse,
} from "../contracts/responses";
import { GatewayError } from "../core/errors";
import { revealUrl } from "./operation-links";
import { outcomeHeld } from "./resource-operations";
import type { ManagementScope } from "./scope";

function notFound(): GatewayError {
  return new GatewayError(404, "operation_not_found", "No operation of your account has this id");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a completed operation's clear record publishes: the fields
 * {@link OperationResult} names, each taken only when it is there. A record
 * holds more than a caller has any business seeing — who approved a claim,
 * the digest of a request, the key id a login minted — and naming the fields
 * is what keeps the rest out; an application key's value is dropped even if a
 * record ever carried one.
 */
function publishedResult(record: unknown): OperationResult {
  if (!isRecord(record)) return {};
  const accountId = typeof record.accountId === "string"
    ? record.accountId
    : typeof record.organizationId === "string" ? record.organizationId : undefined;
  const apiKey = record.api_key;
  return {
    ...(accountId === undefined ? {} : { accountId }),
    ...(isRecord(record.app) ? { app: record.app as NonNullable<OperationResult["app"]> } : {}),
    ...(apiKey === null
      ? { api_key: null }
      : isRecord(apiKey)
        ? { api_key: withoutValue(apiKey) as NonNullable<OperationResult["api_key"]> }
        : {}),
    ...(isRecord(record.provider) ? { provider: record.provider as NonNullable<OperationResult["provider"]> } : {}),
    ...(isRecord(record.gateway) ? { gateway: record.gateway as NonNullable<OperationResult["gateway"]> } : {}),
  };
}

function withoutValue(apiKey: Record<string, unknown>): Record<string, unknown> {
  const { key: _key, ...metadata } = apiKey;
  return metadata;
}

/**
 * Where one operation of the caller's account stands.
 *
 * Read with the caller's own credential, of any role and grant, as the
 * engine's opener view: never the sealed outcome, and never collecting it, so
 * a key the CLI is still to collect is still there for it afterwards.
 * `reveal_url` names the page a person reveals a created key on, for as long
 * as the engine still holds that key.
 */
export async function getOperation(
  scope: ManagementScope,
  state: AuthState,
  id: string,
): Promise<OperationStatusResponse> {
  const engine = (await scope.identity()).operations;
  let status: OperationStatus;
  try {
    status = await engine.status({ id, opener: state });
  } catch (error) {
    if (engineRefused(error, "operation_not_found")) throw notFound();
    throw error;
  }
  const base = { id: status.id, kind: status.kind, createdAt: status.createdAt, expiresAt: status.expiresAt };
  switch (status.state) {
    case "pending":
      return { ...base, state: "pending" };
    case "denied":
      return { ...base, state: "expired", denied: true };
    case "expired":
    case "retired":
      return { ...base, state: "expired" };
    case "completed":
      break;
  }
  const result = publishedResult(status.record);
  const revealable = isReservedKindName(status.kind)
    && isRecord(result.api_key)
    && await outcomeHeld(scope, status.id);
  return {
    ...base,
    state: "completed",
    result,
    ...(revealable ? { reveal_url: revealUrl(scope.deployment, status.id) } : {}),
  };
}

/**
 * The key an operation created, handed to the person on the reveal page,
 * once.
 *
 * The person is the whole authority: the catalog entry has already required
 * an interactive session with the owner or admin role, and the engine checks
 * that role in the operation's own account in the statement that hands the
 * key over, whoever opened the operation and whatever has happened to the
 * credential that did.
 */
export async function revealOperation(
  scope: ManagementScope,
  state: AuthState,
  id: string,
): Promise<RevealedOperationResponse> {
  const engine = (await scope.identity()).operations;
  try {
    const revealed = await engine.reveal({ id, actor: state });
    return {
      id: revealed.id,
      kind: revealed.kind,
      result: revealed.outcome as RevealedOperationResponse["result"],
    };
  } catch (error) {
    if (engineRefused(error, "operation_not_found")) throw notFound();
    if (engineRefused(error, "already_revealed"))
      throw new GatewayError(409, "already_revealed", "This key was already revealed, and is shown only once");
    if (engineRefused(error, "operation_expired"))
      throw new GatewayError(
        410,
        "operation_expired",
        "This key can no longer be revealed: its window passed, or it was revoked",
      );
    throw error;
  }
}
