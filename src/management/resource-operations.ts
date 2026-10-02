/**
 * One management write, run under one operation of cf-auth's engine, from
 * whichever transport asked for it.
 *
 * Three ways in, one write each. The CLI sends an operation under a token it
 * saved, which runs at once or waits for a browser step; an MCP tool reserves
 * a create and executes it with the handle the reservation gave out; and an
 * MCP tool opens a browser step with a token the server makes and discards.
 * In every case the management service runs as it always does — its plan
 * caps, its sealing of a provider secret, its refusals — under the engine's
 * guard, and where it would commit the engine commits instead, completing the
 * operation in the same batch only if the write landed.
 *
 * Nothing here knows which transport it serves: the CLI's routes and the MCP
 * tools are adapters over these functions.
 */

import type {
  AuthState,
  OperationApproveResult,
  OperationBrowserCredential,
  OperationView,
} from "@maxceem/cf-auth";
import { and, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { engineRefused } from "../auth/identity";
import {
  engineKindName,
  parseResourceEnvelope,
  reservedKindName,
  stageApproval,
  type ReservedOperationKind,
} from "../auth/operation-kinds";
import type { CliOperation, CliOperationKind, CliOperationResult, CliRequestedOperationKind } from "../contracts/cli";
import { accountLifecycle, assertAccountAccess } from "../core/account-lifecycle";
import { enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import { GatewayError } from "../core/errors";
import { database } from "../db";
import { mgmtApiKey, mgmtOperation } from "../db/schema";
import { accountAccessCondition } from "../policy/sql";
import type { Actor, AdminActor } from "./actor";
import { deploymentMeta } from "./deployment-meta";
import { digest as sha256 } from "./digest";
import { authorizeOperation } from "./executor";
import {
  kindOf,
  operationId,
  requestDigest,
  requestPayloadSchema,
  resourceKind,
  resultRecord,
  type OperationKind,
  type ResourceKind,
  type ResourceWrite,
} from "./operation-kinds";
import { approvalUrl } from "./operation-links";
import type { ManagementScope } from "./scope";
import { parseRequest } from "./validation";
import type { ResourceWriteBoundary } from "./write-boundary";

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

/**
 * Whether this caller may open an operation of this kind: the policy of the
 * catalog operation that opens one — an owner or admin, with the `manage`
 * grant, on an account with read access — and then the account access the
 * kind itself asks for. The one check every door to an operation applies: the
 * CLI's through its catalog entry, which the executor has already run, and an
 * MCP tool's here.
 *
 * Answers the credential the operation will be bound to; a caller that holds
 * none administers no account.
 */
export async function authorizeKind(
  scope: ManagementScope,
  auth: { state: AuthState; actor: AdminActor },
  kind: OperationKind,
): Promise<string> {
  await authorizeOperation("createCliOperation", { scope, auth }, { params: {}, query: {} });
  return assertKindAccess(scope, auth.actor, kind);
}

/** The half of {@link authorizeKind} a caller the executor has already authorized still owes. */
export async function assertKindAccess(scope: ManagementScope, actor: Actor, kind: OperationKind): Promise<string> {
  if (actor.credentialId === null) {
    throw new GatewayError(403, "forbidden", "Account administration is required");
  }
  await assertAccountAccess(scope.deployment, scope.env, actor.organizationId, kind.open);
  return actor.credentialId;
}

// ---------------------------------------------------------------------------
// Running one write under the engine's boundary
// ---------------------------------------------------------------------------

/** One resource write, and how it is completed. */
export interface ResourceRun {
  id: string;
  actor: Actor;
  entry: ResourceKind;
  write: ResourceWrite;
  /**
   * The approval link's proof and the secret the page collected, for a step
   * whoever holds the link approves; null for a write that runs at once.
   */
  browser: { credential: OperationBrowserCredential; secret: string | undefined } | null;
  /** Whether the operation has completed, by this call or a concurrent twin. */
  settled(): Promise<boolean>;
}

/** What one write leaves the engine to complete with: its result, sealed when it carries a key. */
function completion(entry: ResourceKind, outcome: Record<string, unknown>): OperationApproveResult {
  const result = entry.result(outcome);
  return entry.redact ? { outcome: result, seal: true, record: entry.redact(result) } : { outcome: result };
}

/**
 * Runs one resource write under its operation.
 *
 * The engine's guard holds only while the operation is pending and inside its
 * deadline and the credential that sent it is still live with its role. Where
 * the service would commit, the engine commits instead: `complete` for a
 * write that runs at once, and `approve` with the link's proof for a browser
 * step, whose kind hands the staged statements back to the engine. A browser
 * step's write also rechecks the account's access inside that transaction,
 * because a person may approve it minutes after it was asked for. Returns
 * quietly when the operation is already complete, whether this call or a
 * concurrent twin completed it.
 */
export async function runResourceOperation(scope: ManagementScope, run: ResourceRun): Promise<void> {
  const { actor, entry } = run;
  const identity = await scope.identity();
  const engine = identity.operations;
  let condition: SQL = await engine.guard({ id: run.id });
  if (run.browser) {
    await assertAccountAccess(scope.deployment, scope.env, actor.organizationId, "setup");
    condition = and(
      condition,
      accountAccessCondition(scope.deployment.rules, actor.organizationId, "setup", Date.now()),
    )!;
  }
  const boundary: ResourceWriteBoundary = {
    condition,
    async commit(statements, outcome) {
      const completed = completion(entry, outcome);
      try {
        if (run.browser) {
          const unstage = stageApproval(identity, run.id, { ...completed, statements });
          try {
            await engine.approve({
              id: run.id,
              ...run.browser.credential,
              input: run.browser.secret === undefined ? {} : { secret: run.browser.secret },
            });
          } finally {
            unstage();
          }
        } else {
          await engine.complete({ id: run.id, ...completed, statements });
        }
      } catch (error) {
        if (await run.settled()) return;
        // The engine refused the completion because the write matched no row —
        // the authority was revoked, the revision moved, a cap refused it, or
        // the deadline passed — and nothing was written.
        if (engineRefused(error, "conflict") || engineRefused(error, "operation_expired"))
          throw new GatewayError(409, "conflict", "The resource or its authorization changed; send a new operation");
        throw error;
      }
    },
  };
  try {
    await run.write(scope, actor, boundary);
  } catch (error) {
    if (await run.settled()) return;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Opening one under a token: the CLI, and an MCP browser step
// ---------------------------------------------------------------------------

/**
 * Sends a resource operation under a token, or recovers the one the token
 * already names.
 *
 * One that runs at once is run here and answers completed; one that owes a
 * browser step answers pending, and its view carries the proof for the
 * approval link. The engine binds a token to its request — kind, payload,
 * sender and account — so a retry with the same token is answered as a poll
 * of the same operation, rerun if its write never landed, and anything else
 * under it is refused.
 *
 * `payload` is already parsed by {@link requestPayloadSchema}, and `digest` is
 * {@link requestDigest} of it. The caller has authorized the kind.
 */
export async function openResourceOperation(
  scope: ManagementScope,
  actor: Actor,
  state: AuthState,
  input: {
    kind: CliRequestedOperationKind;
    payload: Record<string, unknown>;
    browser: boolean;
    token: string;
    id: string;
    digest: string;
  },
): Promise<OperationView> {
  const entry = resourceKind(input.kind);
  const credentialId = actor.credentialId;
  if (credentialId === null) throw new GatewayError(403, "forbidden", "Account administration is required");
  const { browser, token, id } = input;
  // A browser step stores what its approver will review; anything else is
  // prepared now, so a payload its write would refuse is refused before the
  // operation is recorded.
  const handoff = browser ? entry.handoff : null;
  if (browser && !handoff) throw new GatewayError(400, "invalid_request", "This operation has no browser step");
  const review = handoff ? parseRequest(handoff, input.payload) : null;
  const write = browser ? null : entry.prepare({ payload: input.payload, secret: undefined });
  const engine = (await scope.identity()).operations;

  if (browser && !(await engine.findByToken({ token })))
    await enforceEndpointRateLimit(scope.env, "operation", actor.organizationId);
  let view = await engine.open({
    id,
    kind: engineKindName(input.kind, browser),
    token,
    // The digest of the whole request, which is what binds a retry to it —
    // the request itself may carry the secret — and, for a browser step, what
    // its approver reviews and who sent it.
    payload: {
      requestHash: input.digest,
      ...(review === null ? {} : { review, sender: { userId: actor.userId, credentialId } }),
    },
    opener: state,
  });
  if (write && view.state === "pending") {
    await runResourceOperation(scope, {
      id,
      actor: { organizationId: actor.organizationId, userId: actor.userId, credentialId },
      entry,
      write,
      browser: null,
      settled: async () => (await engine.findByToken({ token }))?.state === "completed",
    });
    view = await engine.poll({ id, token });
  }
  return view;
}

/**
 * A token for an operation whose opener never polls it: 32 random bytes in
 * base64url, as cf-auth makes one. It proves nothing after the operation is
 * opened, so nothing keeps it.
 */
export function newOperationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** A browser step an MCP tool opened: the operation, and the link a person approves it on. */
export interface OpenedBrowserStep {
  view: OperationView;
  url: string;
  /** An identical request this account made within the hour, if any. */
  recent: RecentOperation | null;
}

/**
 * Opens a write whose secret a person enters in a browser, for a caller that
 * holds no token of its own: an MCP tool. The secret is never part of the
 * request; the payload is the reviewable rest, which the approval page shows.
 */
export async function openBrowserOperation(
  scope: ManagementScope,
  actor: Actor,
  state: AuthState,
  { kind, payload: raw }: { kind: CliRequestedOperationKind; payload: unknown },
): Promise<OpenedBrowserStep> {
  const entry = resourceKind(kind);
  if (!entry.handoff) throw new GatewayError(400, "invalid_request", "This operation has no browser step");
  const payload = parseRequest(entry.handoff, raw);
  const digest = await requestDigest(kind, payload, true);
  const recent = await recentOperation(scope, actor, kind, digest);
  const token = newOperationToken();
  const view = await openResourceOperation(scope, actor, state, {
    kind,
    payload,
    browser: true,
    token,
    id: await operationId(token),
    digest,
  });
  const url = approvalUrl(scope.deployment, view);
  if (url === null) throw new GatewayError(500, "internal_error", "A browser step opened without its approval link");
  return { view, url, recent };
}

// ---------------------------------------------------------------------------
// Reservations: a create an agent may retry, made once
// ---------------------------------------------------------------------------

/** An operation of the same request, made by this account within the hour. */
export interface RecentOperation {
  id: string;
  state: "pending" | "completed";
  createdAt: string;
}

/** How long an identical request is remembered for the notice beside a new one. */
const RECENT_REQUEST_MS = 3_600_000;

/**
 * The newest operation of this account, of this kind under any of the names
 * the engine knows it by, whose stored request digest is `digest` and which
 * was opened within the hour and is pending or completed — a completed one
 * before any pending one, since that is the one that changed something.
 *
 * Reported beside a new request so an agent that lost an answer can find what
 * it already did. Never merged with it and never authorizing anything: the
 * new request runs, or is reserved, exactly as it would otherwise. One query
 * on the engine's table, which its index on account, state and deadline
 * serves.
 */
export async function recentOperation(
  scope: ManagementScope,
  actor: Actor,
  kind: CliOperationKind,
  digest: string,
): Promise<RecentOperation | null> {
  const now = Date.now();
  const row = await database(scope.env.DB)
    .select({ id: mgmtOperation.id, state: mgmtOperation.state, createdAt: mgmtOperation.createdAt })
    .from(mgmtOperation)
    .where(and(
      eq(mgmtOperation.organizationId, actor.organizationId),
      inArray(mgmtOperation.kind, [kind, `${kind}.browser`, `${kind}.reserved`]),
      sql`(${mgmtOperation.state} = 'completed' OR (${mgmtOperation.state} = 'pending' AND ${mgmtOperation.expiresAt} > ${now}))`,
      gt(mgmtOperation.createdAt, new Date(now - RECENT_REQUEST_MS)),
      sql`json_extract(${mgmtOperation.payload}, '$.requestHash') = ${digest}`,
    ))
    // One that completed first: it is the one that changed something.
    .orderBy(sql`${mgmtOperation.state} = 'completed' DESC`, desc(mgmtOperation.createdAt))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    id: row.id,
    state: row.state === "completed" ? "completed" : "pending",
    createdAt: row.createdAt.toISOString(),
  };
}

/** A reservation: what executes it, when it lapses, and an identical request made recently. */
export interface ReservedOperation {
  /** The operation's id, which `getOperation` reads. */
  id: string;
  /** What executes it, once. Only its holder may. */
  handle: string;
  expiresAt: string;
  recent: RecentOperation | null;
}

/**
 * Reserves a create without making it.
 *
 * The payload is judged now as the write will judge it — parsed by its own
 * schema, and checked against the account as it stands — so a request that
 * would be refused is refused before anything is recorded. Then the engine
 * records the reservation, bound to the caller's credential, account and
 * kind, holding the request's digest and nothing of the request itself.
 */
export async function reserveResourceOperation(
  scope: ManagementScope,
  actor: Actor,
  state: AuthState,
  { kind, payload: raw }: { kind: ReservedOperationKind; payload: unknown },
): Promise<ReservedOperation> {
  const entry = resourceKind(kind);
  const payload = parseRequest(requestPayloadSchema(kind), raw) as Record<string, unknown>;
  entry.prepare({ payload, secret: undefined });
  await entry.precheck?.(scope, actor, payload);
  const digest = await requestDigest(kind, payload, false);
  const recent = await recentOperation(scope, actor, kind, digest);
  // Counted as every operation an account starts is, so a loop that reserves
  // and never executes is held to the same pace as one that creates.
  await enforceEndpointRateLimit(scope.env, "operation", actor.organizationId);
  const engine = (await scope.identity()).operations;
  const reservation = await engine.reserve({
    kind: reservedKindName(kind),
    opener: state,
    input: { requestHash: digest },
  });
  return { id: reservation.id, handle: reservation.handle, expiresAt: reservation.expiresAt, recent };
}

/** What executing a reservation answers: what it created, never a key's value. */
export interface ExecutedReservation {
  id: string;
  /** Whether this answer repeats an execution that already ran. */
  replayed: boolean;
  /** What the write created, with any key it minted reduced to its metadata. */
  result: Record<string, unknown>;
  /** Whether a key it minted is still waiting to be revealed by a person. */
  revealable: boolean;
}

function mismatch(): GatewayError {
  return new GatewayError(
    409,
    "operation_mismatch",
    "This handle was reserved for a different request; reserve again for this one",
  );
}

/**
 * Refuses a handle sent with another request than the one it reserved —
 * another kind, another account, other input — before the engine is asked to
 * execute it, so the answer is `operation_mismatch` whatever the reservation's
 * state: while another call is executing it, and after it completed, alike.
 *
 * Read by the handle's digest, which is how the engine stores the handle; an
 * unknown handle is left to the engine, which answers it as unknown. The
 * execution itself compares the digest again inside the engine's guard, and a
 * repeat compares the record it answers: this check decides nothing the engine
 * does not hold to as well.
 */
async function assertReservedFor(
  scope: ManagementScope,
  actor: Actor,
  { kind, handle, digest }: { kind: ReservedOperationKind; handle: string; digest: string },
): Promise<void> {
  const row = await database(scope.env.DB)
    .select({ kind: mgmtOperation.kind, organizationId: mgmtOperation.organizationId, payload: mgmtOperation.payload })
    .from(mgmtOperation)
    .where(eq(mgmtOperation.pollTokenHash, await sha256(handle)))
    .get();
  if (!row) return;
  if (row.kind !== reservedKindName(kind) || row.organizationId !== actor.organizationId) throw mismatch();
  let reserved: string;
  try {
    reserved = parseResourceEnvelope(JSON.parse(row.payload ?? "null")).requestHash;
  } catch {
    throw mismatch();
  }
  if (reserved !== digest) throw mismatch();
}

/**
 * The engine's refusals of an execution, in the gateway's words. Each says
 * whether the handle can be sent again or a new reservation is needed.
 */
function executionRefusal(error: unknown): unknown {
  if (engineRefused(error, "operation_not_found"))
    return new GatewayError(404, "operation_not_found", "No reservation answers to this handle");
  if (engineRefused(error, "operation_mismatch")) return mismatch();
  if (engineRefused(error, "operation_expired"))
    return new GatewayError(410, "operation_expired", "This reservation lapsed before it was executed");
  if (engineRefused(error, "already_completed"))
    return new GatewayError(
      409,
      "already_completed",
      "This reservation was executed too long ago for its result to be repeated",
    );
  if (engineRefused(error, "conflict"))
    return new GatewayError(
      409,
      "conflict",
      "Another call is executing this reservation, or the credential's authority changed while it ran; nothing was written",
    );
  return error;
}

/**
 * Executes a reservation: the write, once.
 *
 * The request sent with the handle has to be the one reserved — its digest is
 * compared with the one the reservation holds before anything is written — and
 * the write runs under the engine's guard, which holds only while the
 * reservation is pending, this call holds it, and the credential that
 * reserved it is still live with its role and grant, and under the account's
 * setup access, rechecked in the same statement. The engine seals what the
 * write created and keeps its redacted record, beside the request's digest.
 *
 * A repeat inside the replay window answers the same record without running
 * anything. Neither answer carries a key's value: the engine hands the sealed
 * outcome to this call, and it goes no further than here.
 */
export async function executeReservedOperation(
  scope: ManagementScope,
  actor: Actor,
  state: AuthState,
  { kind, payload: raw, handle }: { kind: ReservedOperationKind; payload: unknown; handle: string },
): Promise<ExecutedReservation> {
  const entry = resourceKind(kind);
  const payload = parseRequest(requestPayloadSchema(kind), raw) as Record<string, unknown>;
  const write = entry.prepare({ payload, secret: undefined });
  const digest = await requestDigest(kind, payload, false);
  await assertReservedFor(scope, actor, { kind, handle, digest });
  await assertAccountAccess(scope.deployment, scope.env, actor.organizationId, "setup");
  const engine = (await scope.identity()).operations;

  // The service commits through the boundary, and the engine commits after
  // the function returns, so the two are joined here: the function answers
  // with the statements the service hands its boundary, and the service waits
  // on the engine's verdict as it would on a commit of its own — and refuses
  // in its own words, the plan's cap for one, when the engine refused.
  let writing: Promise<unknown> | undefined;
  let settle!: (error: unknown) => void;
  const landed = new Promise<void>((resolve, reject) => {
    settle = (error) => (error === undefined ? resolve() : reject(error));
  });
  // Awaited only by a write that got as far as committing.
  landed.catch(() => undefined);
  let executed: Awaited<ReturnType<typeof engine.execute>>;
  try {
    executed = await engine.execute(
      { handle, kind: reservedKindName(kind), opener: state },
      (context) => new Promise<OperationApproveResult>((complete, refuse) => {
        if (parseResourceEnvelope(context.input).requestHash !== digest) {
          refuse(mismatch());
          return;
        }
        const boundary: ResourceWriteBoundary = {
          condition: and(
            context.guard,
            accountAccessCondition(scope.deployment.rules, actor.organizationId, "setup", context.now),
          )!,
          async commit(statements, outcome) {
            const result = entry.result(outcome);
            const record = entry.redact ? entry.redact(result) : result;
            complete({ outcome: result, record: { ...record, requestHash: digest }, statements });
            await landed;
          },
        };
        writing = write(scope, actor, boundary);
        writing.then(
          () => refuse(new Error("A reserved write finished without committing")),
          refuse,
        );
      }),
    );
    settle(undefined);
  } catch (error) {
    settle(error);
    const refused = writing ? await writing.then(() => undefined, (failure: unknown) => failure) : undefined;
    throw executionRefusal(refused ?? error);
  }
  if (writing) await writing;

  const { requestHash, ...result } = resultRecord(executed.record) ?? {};
  // A repeat runs nothing, so it is the record that says what was reserved.
  if (requestHash !== digest) throw mismatch();
  return {
    id: executed.id,
    replayed: executed.replayed,
    result,
    revealable: carriesKey(result) && (!executed.replayed || await outcomeHeld(scope, executed.id)),
  };
}

/** Whether a result names a key whose value was sealed beside it. */
function carriesKey(result: Record<string, unknown>): boolean {
  return typeof result.api_key === "object" && result.api_key !== null;
}

/**
 * Whether the engine still holds an operation's sealed outcome: not yet
 * revealed, and inside its window. Read only after the engine has shown the
 * operation to this caller.
 */
export async function outcomeHeld(scope: ManagementScope, id: string): Promise<boolean> {
  const row = await database(scope.env.DB)
    .select({ held: sql<number>`${mgmtOperation.sealedOutcome} IS NOT NULL AND ${mgmtOperation.sealedUntil} > ${Date.now()}` })
    .from(mgmtOperation)
    .where(eq(mgmtOperation.id, id))
    .get();
  return Boolean(row?.held);
}

// ---------------------------------------------------------------------------
// The CLI's view of an operation
// ---------------------------------------------------------------------------

/**
 * What a completed claim or resource write reports to the CLI: the whole of
 * it, one-time key included, on an answer the engine hands the sealed outcome
 * to — every answer inside the recovery window — and the redacted record
 * after, whose missing key is how the CLI that sent it learns the window has
 * passed.
 */
async function completedResult(env: Env, view: OperationView): Promise<CliOperationResult> {
  const record = (resultRecord(view.record) ?? {}) as CliOperationResult;
  const whole = resultRecord(view.outcome) as CliOperationResult | null;
  if (whole === null) return record;
  // A key revoked since it was minted is not handed over: the CLI would store a
  // credential that no longer works and report it as delivered. Without its
  // plaintext the answer reads as a key that can no longer be recovered.
  const keyId = whole.api_key?.id;
  if (keyId !== undefined) {
    const key = await env.DB.prepare("SELECT status FROM app_api_key WHERE id=?")
      .bind(keyId)
      .first<{ status: string }>();
    if (key?.status !== "active") return record;
  }
  return whole;
}

/**
 * A login's result: the key on the one answer the engine hands it to, and
 * after that only the account it landed in.
 */
function loginResult(view: OperationView): { result: CliOperationResult; accountId: string | null } {
  const outcome = view.outcome as { credential?: { token: string }; organizationId?: string } | undefined;
  const record = view.record as { organizationId?: string } | null;
  const accountId = outcome?.organizationId ?? record?.organizationId ?? view.organizationId;
  return {
    result: {
      ...(outcome?.credential ? { credential: { token: outcome.credential.token } } : {}),
      ...(accountId ? { accountId } : {}),
    },
    accountId: accountId ?? null,
  };
}

/** Whether the key a completed login minted can still authenticate. */
async function loginKeyLive(env: Env, view: OperationView): Promise<boolean> {
  const apiKeyId = (view.record as { apiKeyId?: unknown } | null)?.apiKeyId;
  if (typeof apiKeyId !== "string") return false;
  const key = await database(env.DB)
    .select({ enabled: mgmtApiKey.enabled, revokedAt: mgmtApiKey.revokedAt })
    .from(mgmtApiKey)
    .where(eq(mgmtApiKey.id, apiKeyId))
    .get();
  return key !== undefined && key.enabled && key.revokedAt === null;
}

/**
 * Where an operation stands, from the engine's view of it, as the CLI's
 * sending it and polling it both answer.
 */
export async function operationStatus(scope: ManagementScope, view: OperationView): Promise<CliOperation> {
  const { kind, entry } = kindOf(view.kind);
  const deployment = scope.deployment;
  const meta = deploymentMeta(deployment);
  const base = { id: view.id, kind, expiresAt: view.expiresAt, deployment: meta };
  switch (view.state) {
    case "pending": {
      const url = approvalUrl(deployment, view);
      return { ...base, state: "pending", ...(url === null ? {} : { url }) };
    }
    case "denied":
      return { ...base, state: "expired", denied: true };
    case "expired":
    case "retired":
      return { ...base, state: "expired" };
    case "completed":
      break;
  }
  if (entry.type === "login") {
    const { result, accountId } = loginResult(view);
    // Its key was withdrawn — revoked before this CLI collected it, or since —
    // so the login no longer stands for anything the CLI could use.
    if (!result.credential && !(await loginKeyLive(scope.env, view))) return { ...base, state: "expired" };
    return {
      ...base,
      state: "completed",
      result,
      ...(accountId ? { account: await accountLifecycle(scope.env, accountId) } : {}),
    };
  }
  const result = await completedResult(scope.env, view);
  const accountId = result.accountId ?? view.organizationId;
  return {
    ...base,
    state: "completed",
    result,
    ...(entry.reportsAccount && accountId ? { account: await accountLifecycle(scope.env, accountId) } : {}),
  };
}
