/**
 * One CLI operation, from the request that sends it to the answer that
 * reports it.
 *
 * Every kind — a bootstrap, a claim, a resource write — is one `mgmt_operation`
 * row whose id is the digest of the token the CLI saved before sending. A
 * retry with that token finds the row instead of repeating the work; a poll
 * with it reads the result; the browser's own proof is derived from it. A
 * resource write runs under the row as its transaction boundary: the write
 * lands only while the row is pending, and the row is completed in the same
 * batch only if the write did, so a lost response is recovered rather than
 * repeated.
 */

import { cfAuth, identityAuthFor } from "../../auth/identity";
import {
  accountLifecycle,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { GatewayError } from "../../core/errors";
import type { CliOperation, CliOperationResult } from "../../contracts/cli";
import { mgmtAuthTables } from "../../db/schema";
import { actorFromOperation } from "../../management/actor";
import { parseRequest } from "../../management/validation";
import type { ResourceWriteBoundary } from "../../management/write-boundary";
import { managementActor } from "../../middleware/admin";
import { accountAccessCondition } from "../../policy/sql";
import { openSecret, sealSecret } from "../../vault/secrets";
import { managementScope } from "../admin/body";
import type { OperationInput } from "../catalog-router";
import { operationKind, type ResourceKind, type ResourceWrite } from "./operation-kinds";
import { derive, digest } from "./security";
import type { CliContext, CliEnv, OperationRow } from "./types";

/** How long a browser step may take before its operation expires. */
export const BROWSER_TTL = 15 * 60_000;
/** How long a completed operation keeps its one-time secret for a CLI whose response was lost. */
export const SEALED_TTL = 15 * 60_000;
/** How long an operation with no browser step stays retryable, and its record readable. */
export const OPERATION_RETENTION = 90 * 86_400_000;
/** Browser steps an account may have open at once. */
const PENDING_BROWSER_STEPS = 10;

/**
 * How the CLI is told which deployment answered: its public identity, plus the
 * one thing about it a client behaves differently for.
 */
export function deploymentMeta(c: CliContext) {
  const deployment = c.get("deployment");
  return { ...deployment.identity(), mode: deployment.mode };
}

export function browserPath(id: string): string {
  return `/cli/approve/${encodeURIComponent(id)}`;
}

/** The operation a token names. */
export async function operationId(token: string): Promise<string> {
  return `op:${await digest(token)}`;
}

/** The browser's proof, derived from the token so the CLI never holds a second secret. */
async function browserToken(c: CliContext, token: string): Promise<string> {
  return derive(token, `browser:${deploymentMeta(c).id}`);
}

export async function cliAuthenticate(c: CliContext): Promise<void> {
  c.set("actor", await managementActor(await authState(c)));
}

export async function authState(c: CliContext, interactive = false) {
  const auth = await identityAuthFor(c, { suppressDefaultOrganization: true });
  await auth.middleware<CliEnv>({
    apiKeys: !interactive,
    syncCurrentOrganizationCookie: false,
  })(c, async () => {});
  return c.get("authState");
}

export async function operationRow(db: D1Database, id: string): Promise<OperationRow | null> {
  return db.prepare("SELECT * FROM mgmt_operation WHERE id=?").bind(id).first<OperationRow>();
}

/** The row an approval page addresses, which must be one that asks a browser for something. */
export async function browserOperation(c: CliContext): Promise<OperationRow> {
  const row = await operationRow(c.env.DB, c.req.param("id") ?? "");
  if (!row || row.browser_proof_hash === null) {
    throw new GatewayError(404, "not_found", "Operation was not found");
  }
  return row;
}

/**
 * The parts of an outcome that are stored: the result with any one-time secret
 * removed, and the whole of it sealed for {@link SEALED_TTL} where it carries
 * one.
 */
export async function storedOutcome(
  env: Env,
  row: Pick<OperationRow, "id">,
  result: Record<string, unknown>,
  redact: ((result: Record<string, unknown>) => Record<string, unknown>) | undefined,
  now: number,
): Promise<{ outcome: string; sealed: string | null; sealedUntil: number | null }> {
  if (!redact) return { outcome: JSON.stringify(result), sealed: null, sealedUntil: null };
  return {
    outcome: JSON.stringify(redact(result)),
    sealed: await sealSecret(env, "cliOperation", [row.id], JSON.stringify(result)),
    sealedUntil: now + SEALED_TTL,
  };
}

/**
 * The statement that completes a pending operation, recording what it achieved.
 *
 * `onlyIfPreviousChanged` ties completion to the statement before it in the
 * same batch: `changes()` is the previous statement's row count on the same
 * connection, and a D1 batch is one transaction on one connection, so the
 * operation completes exactly when the write it authorized changed exactly one
 * row. A write that matched nothing leaves the operation pending and
 * retryable.
 */
export function completeStatement(
  db: D1Database,
  row: Pick<OperationRow, "id">,
  stored: { outcome: string; sealed: string | null; sealedUntil: number | null },
  now: number,
  options: { onlyIfPreviousChanged?: boolean } = {},
): D1PreparedStatement {
  return db.prepare(
    `UPDATE mgmt_operation
     SET state='completed',outcome_json=?,sealed_outcome=?,sealed_until=?,updated_at=?
     WHERE id=? AND state='pending'${options.onlyIfPreviousChanged ? " AND changes()=1" : ""}`,
  ).bind(stored.outcome, stored.sealed, stored.sealedUntil, now, row.id);
}

/**
 * What a completed operation reports: the sealed whole while it lasts, and
 * the redacted record after, whose missing key is how the CLI that sent it
 * learns the recovery window has passed.
 */
async function completedResult(env: Env, row: OperationRow): Promise<CliOperationResult> {
  const redacted = (row.outcome_json ? JSON.parse(row.outcome_json) : {}) as CliOperationResult;
  if (row.sealed_outcome === null || (row.sealed_until ?? 0) <= Date.now()) return redacted;
  // A key revoked since it was minted is not handed over: the CLI would store a
  // credential that no longer works and report it as delivered. Without its
  // plaintext the answer reads as a key that can no longer be recovered.
  const keyId = redacted.api_key?.id;
  if (keyId !== undefined) {
    const key = await env.DB.prepare("SELECT status FROM app_api_key WHERE id=?")
      .bind(keyId)
      .first<{ status: string }>();
    if (key?.status !== "active") return redacted;
  }
  return JSON.parse(await openSecret(env, "cliOperation", [row.id], row.sealed_outcome)) as CliOperationResult;
}

/** Where an operation stands, as sending it and polling it both answer. */
export async function operationStatus(
  c: CliContext,
  row: OperationRow,
  token: string,
): Promise<CliOperation> {
  const now = Date.now();
  const meta = deploymentMeta(c);
  // A stored kind this deployment no longer knows is refused, not reported.
  operationKind(row.kind);
  const base = {
    id: row.id,
    kind: row.kind as CliOperation["kind"],
    expiresAt: new Date(row.expires_at).toISOString(),
    deployment: meta,
  };
  if (row.state !== "completed") {
    if (row.state !== "pending" || row.expires_at <= now) return { ...base, state: "expired" };
    return {
      ...base,
      state: "pending",
      ...(row.browser_proof_hash === null
        ? {}
        : { url: `${meta.consoleOrigin}${browserPath(row.id)}#${await browserToken(c, token)}` }),
    };
  }
  const result = await completedResult(c.env, row);
  const accountId = result.accountId ?? row.organization_id;
  return {
    ...base,
    state: "completed",
    result,
    ...(row.kind === "claim" || row.kind === "bootstrap"
      ? { account: accountId ? await accountLifecycle(c.env, accountId) : null }
      : {}),
  };
}

/**
 * Runs one resource write under its operation.
 *
 * The write may only land while the operation is still pending and inside its
 * deadline, and the operation completes in the same batch only if the write
 * did. A browser step's write also rechecks, inside that transaction, the
 * credential that opened it and the account's access, because a person may
 * approve it minutes after the CLI asked. Returns quietly when the operation
 * is already complete, whether this call or a concurrent twin completed it.
 */
export async function runResourceOperation(
  c: CliContext,
  row: OperationRow,
  kind: ResourceKind,
  write: ResourceWrite,
): Promise<void> {
  if (row.state !== "pending") return;
  const actor = actorFromOperation(row);
  const scope = managementScope(c);
  const browser = row.browser_proof_hash !== null;
  const now = Date.now();
  const conditions = [
    `EXISTS (SELECT 1 FROM mgmt_operation WHERE id=? AND state='pending' AND request_hash=?
      AND expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)))`,
  ];
  const parameters: unknown[] = [row.id, row.request_hash, now];
  if (browser) {
    await assertAccountAccess(scope.deployment, c.env, actor.organizationId, "setup");
    const { credentialAuthorityCondition } = await cfAuth();
    const liveCredential = credentialAuthorityCondition(mgmtAuthTables, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      credentialId: actor.credentialId!,
      allowedRoles: ["owner", "admin"],
      nowMs: now,
    });
    const accountAccess = accountAccessCondition(scope.deployment.mode, actor.organizationId, "setup", now);
    conditions.push(liveCredential.sql, accountAccess.sql);
    parameters.push(...liveCredential.params, ...accountAccess.params);
  }
  const settled = async () => (await operationRow(c.env.DB, row.id))?.state === "completed";
  const boundary: ResourceWriteBoundary = {
    condition: { sql: conditions.join(" AND "), params: parameters },
    async commit(statement, outcome) {
      const stored = await storedOutcome(c.env, row, kind.result(outcome), kind.redact, now);
      await c.env.DB.batch([
        ...(Array.isArray(statement) ? statement : [statement]),
        completeStatement(c.env.DB, row, stored, now, { onlyIfPreviousChanged: true }),
      ]);
      // Still pending means the write matched no row — the authority was
      // revoked, the revision moved, a cap refused it, or the deadline passed —
      // and nothing was written.
      if (await settled()) return;
      throw new GatewayError(409, "conflict", "The resource or its authorization changed; send a new operation");
    },
  };
  try {
    await write(scope, actor, boundary);
  } catch (error) {
    if (await settled()) return;
    throw error;
  }
}

/**
 * Sends an operation, or recovers the one its token already names.
 *
 * A kind that runs at once is run here and answers completed; one that owes a
 * browser step answers pending with the approval page's URL. A retry with the
 * same token must be the same request by the same user in the same account,
 * and is answered
 * with the same operation — rerun if its write never landed, reported if it
 * did.
 */
export async function createOperation(
  c: CliContext,
  { body: input, actor }: OperationInput<"createCliOperation">,
): Promise<CliOperation> {
  const kind = operationKind(input.kind);
  const meta = deploymentMeta(c);
  if (actor.credentialType === "session" && c.req.header("origin") !== meta.consoleOrigin) {
    throw new GatewayError(403, "forbidden", "Use the first-party console for browser operations");
  }
  if (actor.credentialId === null) {
    throw new GatewayError(403, "forbidden", "Account administration is required");
  }
  const account = await assertAccountAccess(c.get("deployment"), c.env, actor.organizationId, kind.open);
  if (kind.type === "claim" && account.claimed) {
    throw new GatewayError(409, "conflict", "Account is already claimed");
  }
  const browser = kind.type === "claim"
    || (kind.type === "resource"
      && (kind.browser === "always" || (kind.browser === "optional" && "browser" in input && input.browser === true)));
  // A browser step stores what its approver will review; anything else is
  // prepared now, so a payload its write would refuse is refused before the
  // operation is recorded. The request schema admits `browser` only for a kind
  // with a handoff.
  const handoff = kind.type === "resource" && browser ? kind.handoff : null;
  const payload = handoff ? parseRequest(handoff, input.payload) : {};
  const write = kind.type === "resource" && !browser
    ? kind.prepare({ payload: input.payload, secret: undefined })
    : null;
  const id = await operationId(input.token);
  const requestHash = await digest(JSON.stringify({ kind: input.kind, payload: input.payload, browser }));

  let row = await operationRow(c.env.DB, id);
  if (!row) {
    const now = Date.now();
    if (browser) await enforceEndpointRateLimit(c.env, "operation", actor.organizationId);
    // A browser step shows its payload to a person; nothing else needs it
    // stored, and an immediate write's payload may carry its secret.
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_operation(
         id,kind,state,organization_id,initiating_user_id,initiating_credential_id,
         request_json,request_hash,browser_proof_hash,expires_at,created_at,updated_at)
       SELECT ?,?,'pending',?,?,?,?,?,?,?,?,?
       WHERE ? OR (SELECT COUNT(*) FROM mgmt_operation
         WHERE organization_id=? AND state='pending' AND browser_proof_hash IS NOT NULL AND expires_at>?) < ?`,
    ).bind(
      id,
      input.kind,
      actor.organizationId,
      actor.userId,
      actor.credentialId,
      browser ? JSON.stringify(payload) : null,
      requestHash,
      browser ? await digest(await browserToken(c, input.token)) : null,
      now + (browser ? BROWSER_TTL : OPERATION_RETENTION),
      now,
      now,
      browser ? 0 : 1,
      actor.organizationId,
      now,
      PENDING_BROWSER_STEPS,
    ).run();
    row = await operationRow(c.env.DB, id);
    if (!row) throw new GatewayError(429, "rate_limited", "Too many pending operations");
  }
  // Judged on the row as stored, not as first read: two requests racing on one
  // token both find nothing, and the one whose insert was ignored must not go on
  // to run its own payload under the row the other one wrote.
  if (
    row.kind !== input.kind
    || row.organization_id !== actor.organizationId
    || row.initiating_user_id !== actor.userId
    || row.request_hash !== requestHash
  ) {
    throw new GatewayError(409, "conflict", "This operation token is already bound to a different request");
  }
  if (kind.type === "resource" && write && row.state === "pending") {
    await runResourceOperation(c, row, kind, write);
    row = (await operationRow(c.env.DB, id))!;
  }
  return operationStatus(c, row, input.token);
}

export async function pollOperation(c: CliContext): Promise<CliOperation> {
  const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  const id = c.req.param("id") ?? "";
  const row = await operationRow(c.env.DB, id);
  if (!row || !/^[A-Za-z0-9_-]{32,256}$/.test(token) || (await operationId(token)) !== id) {
    throw new GatewayError(403, "forbidden", "Invalid operation token");
  }
  // A bootstrap is recovered by sending it again, which is also what activates
  // the key it delivers; a poll could hand over a key that never works.
  if (row.kind === "bootstrap")
    throw new GatewayError(400, "invalid_request", "Recover a bootstrap by sending it again");
  return operationStatus(c, row, token);
}
