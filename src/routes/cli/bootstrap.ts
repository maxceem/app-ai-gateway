import type { CfAuth, CfAuthOperations, OperationView } from "@maxceem/cf-auth";
import { and, eq, isNull, lte, not, or, sql } from "drizzle-orm";
import { requireActiveBilling } from "../../billing/gateway";
import { billingQuota } from "../../billing/quota";
import {
  accountLifecycle,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { clientAddress, enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { GatewayError } from "../../core/errors";
import { database } from "../../db";
import { mgmtOperation, mgmtOrganization, mgmtOrganizationUser, mgmtUser } from "../../db/schema";
import { guardedInsert, prepared } from "../../db/sql";
import type { CliOperation } from "../../contracts/cli";
import { unclaimedAccessDeadline } from "../../policy/accounts";
import { bootstrapDecision } from "../../policy/deployment";
import { emptyDeploymentCondition, humanOwnerCondition } from "../../policy/sql";
import {
  cliIdentity,
  deploymentMeta,
  engineRefused,
  operationEngine,
} from "./operations";
import { bootstrapRecord, kindOf, operationId, type BootstrapRecord } from "./operation-rows";
import { digest } from "./security";
import type { OperationInput } from "../catalog-router";
import type { CliContext } from "./types";

async function retireKey(
  identity: CfAuth,
  organizationId: string,
  apiKeyId: string,
): Promise<void> {
  await identity.service.revokeServiceApiKey({ apiKeyId, organizationId });
}

/**
 * Creates the account a CLI starts from, or answers again for the one its
 * token already created.
 *
 * A bootstrap is an operation like any other — opened with the engine under the
 * CLI's token — with an endpoint of its own because it is one of the two kinds
 * that need no credential. The account is created in the same batch that
 * completes it, so a bootstrap is either pending with no account or completed
 * with one; it then stays `completed` while the account is unclaimed, becomes
 * `retired` when a claim ends its authority, and `expired` once account cleanup
 * collected the account. That last record is kept for the rest of its
 * retention, so the same token cannot recreate an account the deadline removed.
 */
export async function bootstrap(
  c: CliContext,
  { body: input }: OperationInput<"bootstrapCliAccount">,
): Promise<CliOperation> {
  const deployment = c.get("deployment");
  const meta = deploymentMeta(c);
  const id = await operationId(input.token);
  const now = Date.now();
  const decision = bootstrapDecision(deployment, {
    deploymentId: meta.id,
    requestHash: await digest(input.token),
    nowMs: now,
  });
  const engine = await operationEngine(c);
  const existing = await engine.findByToken({ token: input.token });
  if (existing && kindOf(existing.kind).entry.type !== "bootstrap")
    throw new GatewayError(409, "conflict", "This operation token is already bound to a different request");

  if (!existing) {
    // A self-host belongs to whoever initializes it first, exactly as its first
    // console registration does. Once an account exists, neither door reopens.
    if (decision.requiresEmptyDeployment) {
      if (await prepared(c.env.DB, sql`SELECT 1 WHERE NOT ${emptyDeploymentCondition()}`).first())
        throw new GatewayError(409, "conflict", "This deployment has already been initialized");
    }
    // Cloud only, where an account costs this gateway's operator something and
    // anyone can ask for one.
    //
    // A self-host counts nothing, because the only thing counting could refuse
    // there is the race to be its first caller — and that race is the rule, not
    // a flaw in it: whoever initializes an empty deployment owns it. What a
    // limit here would reliably refuse instead is the owner's own installer
    // retrying a deployment whose storage has not come up yet. The 409 above is
    // the guard that matters, and it never expires.
    if (decision.rateLimited)
      await enforceEndpointRateLimit(c.env, "bootstrap", clientAddress(c.req.raw));
  }

  // Sending it again is answered as a poll would be: with the key the engine
  // still holds sealed, while its window lasts.
  let view = await engine.open({ id, kind: "bootstrap", token: input.token });
  if (view.state === "pending") {
    await createAccount(c, engine, id, decision);
    view = await engine.poll({ id, token: input.token });
    // The account this token's own already exists, so there was nothing to
    // create: the bootstrap is completed on it, as the answer to a resend is.
    if (view.state === "pending" && decision.accountPerToken) {
      await adoptAccount(c, engine, id, decision);
      view = await engine.poll({ id, token: input.token });
    }
    if (view.state === "pending")
      throw decision.accountPerToken
        ? new GatewayError(409, "conflict", "The account for this request could not be created; send it again")
        : new GatewayError(409, "conflict", "This deployment has already been initialized");
  }

  const record = view.state === "expired" ? null : bootstrapRecord(view.record);
  if (!record)
    throw new GatewayError(403, "account_expired", "The account recovery deadline has passed");
  const account = await assertAccountAccess(deployment, c.env, record.accountId, "read");
  if (account.claimed || view.state !== "completed")
    throw new GatewayError(403, "forbidden", "Bootstrap authority has been retired");

  const identity = await cliIdentity(c);
  const credential = await currentCredential(identity, input.token, view, record);

  // Issued inactive, activated only now: a key becomes usable once the record
  // that names it is committed, so a run that dies in between leaves a
  // credential nobody holds and nothing can authenticate with. Activation is
  // idempotent and refuses a revoked key, so repeating a request finishes an
  // interrupted run without resurrecting what a claim has already retired.
  await identity.service.enableServiceApiKey({
    apiKeyId: credential.id,
    organizationId: account.id,
  });

  let unclaimedAccess: { endsAt: string; limit?: number } | null = null;
  if (deployment.rules.accountDeadlines) {
    const deadline = unclaimedAccessDeadline(account.createdAt);
    if (deadline === null) {
      throw new GatewayError(
        403,
        "unclaimed_access_expired",
        "This unclaimed account's free access has ended; claim your account to continue",
      );
    }
    const quota = await billingQuota(deployment, c.env, account.id);
    requireActiveBilling(quota.access);
    unclaimedAccess = {
      endsAt: new Date(deadline).toISOString(),
      ...(quota.kind === "metered" ? { limit: quota.limit } : {}),
    };
  }
  return {
    id,
    kind: "bootstrap",
    state: "completed",
    expiresAt: view.expiresAt,
    deployment: meta,
    account: await accountLifecycle(c.env, account.id),
    result: { credential: { token: credential.token }, unclaimedAccess },
  };
}

/**
 * Creates the bootstrap's account in the batch that completes it.
 *
 * Every statement is guarded by the engine — the bootstrap is still pending —
 * and, on a deployment only its first caller may take, by emptiness. The
 * engine completes the operation only if the last of them, the owner
 * membership, was written, so of two tokens racing for an empty self-host the
 * one whose account landed completes and the other stays pending, unused. The
 * record names no key yet: a key needs the membership this batch creates, and
 * is issued, sealed and recorded next, the same way a later renewal is.
 */
async function createAccount(
  c: CliContext,
  engine: CfAuthOperations,
  id: string,
  decision: ReturnType<typeof bootstrapDecision>,
): Promise<void> {
  const { accountId, userId, createdAt, recoveryEndsAt } = decision;
  const guard = await engine.guard({ id });
  const empty = decision.requiresEmptyDeployment ? emptyDeploymentCondition() : sql`1`;
  const created = sql`EXISTS (
    SELECT 1 FROM mgmt_organization WHERE id=${accountId} AND created_by_user_id=${userId})`;
  const at = new Date(Date.parse(createdAt));
  const db = database(c.env.DB);
  const record: BootstrapRecord = { accountId, userId, credentialId: null };
  try {
    await engine.complete({
      id,
      outcome: record,
      statements: [
        guardedInsert(db, mgmtUser, {
          id: userId,
          name: "CLI service",
          email: null,
          emailVerified: false,
          kind: "service",
          createdAt: at,
          updatedAt: at,
        }, and(guard, empty)!).onConflictDoNothing(),
        guardedInsert(db, mgmtOrganization, {
          id: accountId,
          name: "My account",
          createdByUserId: userId,
          expiresAt: recoveryEndsAt,
          createdAt,
          updatedAt: createdAt,
        }, and(guard, empty)!).onConflictDoNothing(),
        guardedInsert(db, mgmtOrganizationUser, {
          id: `member-${accountId}`,
          organizationId: accountId,
          userId,
          role: "owner",
          status: "active",
          joinedAt: createdAt,
        }, and(guard, created)!).onConflictDoNothing(),
      ],
    });
  } catch (error) {
    // A twin completed it first, or another caller took an empty self-host:
    // the operation as it now stands says which.
    if (["conflict", "already_completed", "operation_expired"].some((code) => engineRefused(error, code))) return;
    throw error;
  }
}

/**
 * Completes a bootstrap whose account already exists: one whose token is the
 * only thing that could have created it, on a deployment that gives each token
 * an account of its own. Completion rides on a no-op touch of that account,
 * guarded by the engine and by the account still being this token's service
 * identity's creation, so it lands only on the account it names.
 */
async function adoptAccount(
  c: CliContext,
  engine: CfAuthOperations,
  id: string,
  decision: ReturnType<typeof bootstrapDecision>,
): Promise<void> {
  const { accountId, userId } = decision;
  const guard = await engine.guard({ id });
  const record: BootstrapRecord = { accountId, userId, credentialId: null };
  try {
    await engine.complete({
      id,
      outcome: record,
      statements: [
        database(c.env.DB)
          .update(mgmtOrganization)
          .set({ updatedAt: sql`${mgmtOrganization.updatedAt}` })
          .where(and(eq(mgmtOrganization.id, accountId), eq(mgmtOrganization.createdByUserId, userId), guard)),
      ],
    });
  } catch (error) {
    if (["conflict", "already_completed", "operation_expired"].some((code) => engineRefused(error, code))) return;
    throw error;
  }
}

/**
 * The management key the record names and its plaintext, which the engine
 * still holds sealed for the CLI to collect, issuing and sealing a new one when
 * there is none or the last one's window has passed.
 *
 * The record is the single durable account of which key this bootstrap stands
 * behind. Whichever key it does not name is retired, whether that is the one
 * this call lost a race with or the one it replaced.
 */
async function currentCredential(
  identity: CfAuth,
  token: string,
  view: OperationView,
  record: BootstrapRecord,
): Promise<{ id: string; token: string }> {
  const accountId = record.accountId;
  const sealed = view.outcome as { token?: unknown } | undefined;
  if (record.credentialId && typeof sealed?.token === "string") return { id: record.credentialId, token: sealed.token };
  // No expiry of its own: the account's `expires_at` is the one deadline, and
  // cf-auth refuses any key whose organization has passed it.
  const issued = await identity.service.issueServiceApiKey({
    userId: record.userId,
    organizationId: accountId,
    name: "CLI bootstrap",
    enabled: false,
    source: "bootstrap",
  });
  const now = Date.now();
  let landed: boolean;
  try {
    // Only while no key is held sealed — so of two renewals racing, one lands —
    // and never once a person owns the account.
    landed = await identity.operations.amend({
      id: view.id,
      outcome: { token: issued.plaintext },
      seal: true,
      record: { ...record, credentialId: issued.id } satisfies BootstrapRecord,
      condition: and(
        or(isNull(mgmtOperation.sealedUntil), lte(mgmtOperation.sealedUntil, new Date(now))),
        not(humanOwnerCondition(sql`${accountId}`)),
      ),
    });
  } catch (error) {
    // A failed RPC can still have committed, so ask the record who won before
    // retiring the key this call minted.
    const current = bootstrapRecord((await identity.operations.findByToken({ token }))?.record ?? null);
    if (current?.credentialId !== issued.id) await retireKey(identity, accountId, issued.id);
    throw error;
  }
  if (landed) {
    if (record.credentialId) await retireKey(identity, accountId, record.credentialId);
    return { id: issued.id, token: issued.plaintext };
  }
  await retireKey(identity, accountId, issued.id);
  const winner = await identity.operations.poll({ id: view.id, token });
  const current = winner.state === "completed" ? bootstrapRecord(winner.record) : null;
  const held = winner.outcome as { token?: unknown } | undefined;
  if (!current?.credentialId || typeof held?.token !== "string")
    throw new GatewayError(403, "forbidden", "Bootstrap authority has been retired");
  return { id: current.credentialId, token: held.token };
}
