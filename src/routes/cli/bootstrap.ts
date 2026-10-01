import type { CfAuth, OperationView } from "@maxceem/cf-auth";
import { and, isNull, lte, not, or, sql } from "drizzle-orm";
import { requireActiveBilling } from "../../billing/gateway";
import { billingQuota } from "../../billing/quota";
import {
  accountLifecycle,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { clientAddress } from "../../core/endpoint-rate-limit";
import { GatewayError } from "../../core/errors";
import { deploymentMeta } from "../../management/deployment-meta";
import {
  admitUnclaimedAccount,
  provisionUnclaimedAccount,
  unclaimedAccountDecision,
  unclaimedAccountRecord,
  type UnclaimedAccountRecord,
} from "../../management/provisioning";
import { managementScope } from "../admin/body";
import { mgmtOperation } from "../../db/schema";
import type { CliOperation } from "../../contracts/cli";
import { unclaimedAccessDeadline } from "../../policy/accounts";
import { humanOwnerCondition } from "../../policy/sql";
import { cliIdentity, operationEngine } from "./operations";
import { kindOf, operationId } from "../../management/operation-kinds";
import { digest } from "./security";
import type { OperationInput } from "../../management/executor";
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
  const scope = managementScope(c);
  const deployment = scope.deployment;
  const meta = deploymentMeta(deployment);
  const id = await operationId(input.token);
  const decision = unclaimedAccountDecision(scope, {
    requestHash: await digest(input.token),
    nowMs: Date.now(),
  });
  const engine = await operationEngine(c);
  const existing = await engine.findByToken({ token: input.token });
  if (existing && kindOf(existing.kind).entry.type !== "bootstrap")
    throw new GatewayError(409, "conflict", "This operation token is already bound to a different request");

  // A resend is not a new account, so it is neither refused as one nor counted.
  if (!existing) await admitUnclaimedAccount(scope, decision, clientAddress(c.req.raw));

  // Sending it again is answered as a poll would be: with the key the engine
  // still holds sealed, while its window lasts.
  let view: OperationView = await engine.open({ id, kind: "bootstrap", token: input.token });
  if (view.state === "pending") {
    view = await provisionUnclaimedAccount(
      scope,
      engine,
      { id, view: () => engine.poll({ id, token: input.token }) },
      decision,
    );
  }

  const record = view.state === "expired" ? null : unclaimedAccountRecord(view.record);
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
  record: UnclaimedAccountRecord,
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
      record: { ...record, credentialId: issued.id } satisfies UnclaimedAccountRecord,
      condition: and(
        or(isNull(mgmtOperation.sealedUntil), lte(mgmtOperation.sealedUntil, new Date(now))),
        not(humanOwnerCondition(sql`${accountId}`)),
      ),
    });
  } catch (error) {
    // A failed RPC can still have committed, so ask the record who won before
    // retiring the key this call minted.
    const current = unclaimedAccountRecord((await identity.operations.findByToken({ token }))?.record ?? null);
    if (current?.credentialId !== issued.id) await retireKey(identity, accountId, issued.id);
    throw error;
  }
  if (landed) {
    if (record.credentialId) await retireKey(identity, accountId, record.credentialId);
    return { id: issued.id, token: issued.plaintext };
  }
  await retireKey(identity, accountId, issued.id);
  const winner = await identity.operations.poll({ id: view.id, token });
  const current = winner.state === "completed" ? unclaimedAccountRecord(winner.record) : null;
  const held = winner.outcome as { token?: unknown } | undefined;
  if (!current?.credentialId || typeof held?.token !== "string")
    throw new GatewayError(403, "forbidden", "Bootstrap authority has been retired");
  return { id: current.credentialId, token: held.token };
}
