/**
 * One CLI operation, from the request that sends it to the answer that
 * reports it.
 *
 * Every kind — a bootstrap, a login, a claim, a resource write — is one
 * operation of cf-auth's engine, opened under the token the CLI saved before
 * sending and the id the CLI derives from it. A retry with that token is
 * answered as the engine answers a poll, so a lost response is recovered
 * rather than repeated. A resource write runs under the engine's guard as its
 * transaction boundary: the write lands only while the operation is pending and
 * the credential that sent it is still live with its role, and the engine
 * completes it in the same batch only if the write did.
 */

import { and, eq, type SQL } from "drizzle-orm";
import type { CfAuthOperations, OperationBrowserCredential, OperationView } from "@maxceem/cf-auth";
import { identityAuthFor, isCfAuthError } from "../../auth/identity";
import { engineKindName, stageApproval } from "../../auth/operation-kinds";
import {
  accountLifecycle,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { GatewayError } from "../../core/errors";
import type { CliOperation, CliOperationResult } from "../../contracts/cli";
import { database } from "../../db";
import { mgmtApiKey } from "../../db/schema";
import type { Actor } from "../../management/actor";
import { deploymentMeta } from "../../management/deployment-meta";
import { parseRequest } from "../../management/validation";
import type { ResourceWriteBoundary } from "../../management/write-boundary";
import { managementActor } from "../../middleware/admin";
import { accountAccessCondition } from "../../policy/sql";
import { managementScope } from "../admin/body";
import type { OperationInput } from "../../management/executor";
import { operationKind, type ResourceKind, type ResourceWrite } from "./operation-kinds";
import { kindOf, operationId, resultRecord } from "./operation-rows";
import { digest } from "./security";
import type { CliContext, CliEnv } from "./types";

export function browserPath(id: string): string {
  return `/cli/approve/${encodeURIComponent(id)}`;
}

/** The identity instance every CLI route shares: it never provisions an account as a side effect. */
export function cliIdentity(c: CliContext) {
  return identityAuthFor(c, { suppressDefaultOrganization: true });
}

/** cf-auth's operation engine, for this request. */
export async function operationEngine(c: CliContext): Promise<CfAuthOperations> {
  return (await cliIdentity(c)).operations;
}

/** Whether a failure is the engine refusing with `code`. */
export function engineRefused(error: unknown, code: string): boolean {
  return isCfAuthError(error) && error.code === code;
}

export async function cliAuthenticate(c: CliContext): Promise<void> {
  c.set("actor", await managementActor(await authState(c)));
}

export async function authState(c: CliContext, interactive = false) {
  const auth = await cliIdentity(c);
  await auth.middleware<CliEnv>({
    apiKeys: !interactive,
    syncCurrentOrganizationCookie: false,
  })(c, async () => {});
  return c.get("authState");
}

/**
 * What a completed claim or resource write reports: the whole of it, one-time
 * key included, on an answer the engine hands the sealed outcome to — every
 * answer inside the recovery window — and the redacted record after, whose
 * missing key is how the CLI that sent it learns the window has passed.
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

/** Where an operation stands, from the engine's view of it, as sending it and polling it both answer. */
export async function operationStatus(c: CliContext, view: OperationView): Promise<CliOperation> {
  const { kind, entry } = kindOf(view.kind);
  const meta = deploymentMeta(c.get("deployment"));
  const base = { id: view.id, kind, expiresAt: view.expiresAt, deployment: meta };
  switch (view.state) {
    case "pending":
      return {
        ...base,
        state: "pending",
        ...(view.browserProof === null
          ? {}
          : { url: `${meta.consoleOrigin}${browserPath(view.id)}#${view.browserProof}` }),
      };
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
    if (!result.credential && !(await loginKeyLive(c.env, view))) return { ...base, state: "expired" };
    return {
      ...base,
      state: "completed",
      result,
      ...(accountId ? { account: await accountLifecycle(c.env, accountId) } : {}),
    };
  }
  const result = await completedResult(c.env, view);
  const accountId = result.accountId ?? view.organizationId;
  return {
    ...base,
    state: "completed",
    result,
    ...(entry.reportsAccount && accountId ? { account: await accountLifecycle(c.env, accountId) } : {}),
  };
}

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

/**
 * Runs one resource write under its operation.
 *
 * The management service runs as it always does — its plan caps, its sealing
 * of a provider secret, its refusals — under the engine's guard, which holds
 * only while the operation is pending and inside its deadline and the
 * credential that sent it is still live with its role. Where it would commit,
 * the engine commits instead: `complete` for a write that runs at once, and
 * `approve` with the link's proof for a browser step, whose kind hands the
 * staged statements back to the engine. Either way the engine completes the
 * operation in the same batch only if the write changed a row, and holds any
 * one-time key sealed for the recovery window. A browser step's write also
 * rechecks the account's access inside that transaction, because a person may
 * approve it minutes after the CLI asked. Returns quietly when the operation is
 * already complete, whether this call or a concurrent twin completed it.
 */
export async function runResourceOperation(c: CliContext, run: ResourceRun): Promise<void> {
  const { actor, entry: kind } = run;
  const scope = managementScope(c);
  const identity = await cliIdentity(c);
  const engine = identity.operations;
  let condition: SQL = await engine.guard({ id: run.id });
  if (run.browser) {
    await assertAccountAccess(scope.deployment, c.env, actor.organizationId, "setup");
    condition = and(
      condition,
      accountAccessCondition(scope.deployment.rules, actor.organizationId, "setup", Date.now()),
    )!;
  }
  const boundary: ResourceWriteBoundary = {
    condition,
    async commit(statements, outcome) {
      const result = kind.result(outcome);
      const completion = kind.redact ? { outcome: result, seal: true, record: kind.redact(result) } : { outcome: result };
      try {
        if (run.browser) {
          const unstage = stageApproval(identity, run.id, { ...completion, statements });
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
          await engine.complete({ id: run.id, ...completion, statements });
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

/**
 * Sends an operation, or recovers the one its token already names.
 *
 * A kind that runs at once is run here and answers completed; one that owes a
 * browser step answers pending with the approval page's URL. The engine binds
 * a token to its request — kind, payload, sender and account — so a retry
 * with the same token is answered as a poll of the same operation, rerun if its
 * write never landed, and anything else under it is refused.
 */
export async function createOperation(
  c: CliContext,
  { body: input, actor }: OperationInput<"createCliOperation">,
): Promise<CliOperation> {
  const kind = operationKind(input.kind);
  const meta = deploymentMeta(c.get("deployment"));
  if (actor.credentialType === "session" && c.req.header("origin") !== meta.consoleOrigin) {
    throw new GatewayError(403, "forbidden", "Use the first-party console for browser operations");
  }
  const credentialId = actor.credentialId;
  if (credentialId === null) {
    throw new GatewayError(403, "forbidden", "Account administration is required");
  }
  const account = await assertAccountAccess(c.get("deployment"), c.env, actor.organizationId, kind.open);
  if (kind.type === "claim" && account.claimed) {
    throw new GatewayError(409, "conflict", "Account is already claimed");
  }
  if (kind.type !== "claim" && kind.type !== "resource")
    throw new GatewayError(400, "invalid_request", "Unsupported operation kind");
  const browser = kind.type === "claim"
    || (kind.browser === "always" || (kind.browser === "optional" && "browser" in input && input.browser === true));
  // A browser step stores what its approver will review; anything else is
  // prepared now, so a payload its write would refuse is refused before the
  // operation is recorded. The request schema admits `browser` only for a kind
  // with a handoff.
  const handoff = kind.type === "resource" && browser ? kind.handoff : null;
  const review = handoff ? parseRequest(handoff, input.payload) : null;
  const write = kind.type === "resource" && !browser
    ? kind.prepare({ payload: input.payload, secret: undefined })
    : null;
  const id = await operationId(input.token);
  const engine = await operationEngine(c);

  if (browser && !(await engine.findByToken({ token: input.token })))
    await enforceEndpointRateLimit(c.env, "operation", actor.organizationId);
  let view = await engine.open({
    id,
    kind: engineKindName(input.kind, browser),
    token: input.token,
    // A claim takes nothing. A resource write stores the digest of its whole
    // request, which is what binds a retry to it — the request itself may
    // carry the secret — and, for a browser step, what its approver reviews
    // and who sent it.
    ...(kind.type === "claim"
      ? {}
      : {
          payload: {
            requestHash: await digest(JSON.stringify({ kind: input.kind, payload: input.payload, browser })),
            ...(review === null ? {} : { review, sender: { userId: actor.userId, credentialId } }),
          },
        }),
    opener: c.get("authState"),
  });
  if (kind.type === "resource" && write && view.state === "pending") {
    await runResourceOperation(c, {
      id,
      actor: { organizationId: actor.organizationId, userId: actor.userId, credentialId },
      entry: kind,
      write,
      browser: null,
      settled: async () => (await engine.findByToken({ token: input.token }))?.state === "completed",
    });
    view = await engine.poll({ id, token: input.token });
  }
  return operationStatus(c, view);
}

/**
 * The operation a poll or a redeem proves itself on: the token must hash to
 * the id in the path before anything about the operation is read, so nothing
 * reaches a caller that does not hold it.
 */
export async function provenOperation(
  c: CliContext,
  id: string,
): Promise<{ view: OperationView; token: string }> {
  const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  const view = /^[A-Za-z0-9_-]{32,256}$/.test(token) && (await operationId(token)) === id
    ? await (await operationEngine(c)).findByToken({ token })
    : null;
  if (!view) throw new GatewayError(403, "forbidden", "Invalid operation token");
  return { view, token };
}

export async function pollOperation(
  c: CliContext,
  { params }: OperationInput<"pollCliOperation">,
): Promise<CliOperation> {
  const { view, token } = await provenOperation(c, params.id);
  // A bootstrap is recovered by sending it again, which is also what activates
  // the key it delivers; a poll could hand over a key that never works.
  if (kindOf(view.kind).entry.type === "bootstrap")
    throw new GatewayError(400, "invalid_request", "Recover a bootstrap by sending it again");
  const engine = await operationEngine(c);
  try {
    return await operationStatus(c, await engine.poll({ id: view.id, token }));
  } catch (error) {
    // The engine withdrew what it held — a login's key revoked before anyone
    // collected it — and the CLI is told the operation is over, in its own
    // vocabulary, rather than given an error for a question it asked rightly.
    if (!engineRefused(error, "operation_expired")) throw error;
    return operationStatus(c, { ...view, state: "expired" });
  }
}
