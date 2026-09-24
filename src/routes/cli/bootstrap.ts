import type { CfAuth } from "@maxceem/cf-auth";
import { sql } from "drizzle-orm";
import { identityAuthFor } from "../../auth/identity";
import { requireActiveBilling } from "../../billing/gateway";
import { billingQuota } from "../../billing/quota";
import {
  accountLifecycle,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { clientAddress, enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { GatewayError } from "../../core/errors";
import { prepared } from "../../db/sql";
import type { CliOperation } from "../../contracts/cli";
import { ACCOUNT_RECOVERY_MS, unclaimedAccessDeadline } from "../../policy/accounts";
import { bootstrapDecision } from "../../policy/deployment";
import { emptyDeploymentCondition, humanOwnerCondition } from "../../policy/sql";
import { openSecret, sealSecret } from "../../vault/secrets";
import {
  deploymentMeta,
  operationId,
  operationRow,
  SEALED_TTL,
} from "./operations";
import { digest } from "./security";
import type { OperationInput } from "../catalog-router";
import type { CliContext, OperationRow } from "./types";

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
 * A bootstrap is an operation like any other — one `mgmt_operation` row whose
 * id is the digest of the CLI's token — with an endpoint of its own because it
 * is the one kind that needs no credential. Its row stays `completed` while
 * the account is unclaimed, becomes `retired` when a claim ends its authority,
 * and `expired` once account cleanup collected the account; that last row is
 * kept, so the same token cannot recreate an account the deadline removed.
 */
export async function bootstrap(
  c: CliContext,
  { body: input }: OperationInput<"bootstrapCliAccount">,
): Promise<CliOperation> {
  const deployment = c.get("deployment");
  const meta = deploymentMeta(c);
  const id = await operationId(input.token);
  const hash = await digest(input.token);
  const now = Date.now();
  const decision = bootstrapDecision(deployment, {
    deploymentId: meta.id,
    requestHash: hash,
    nowMs: now,
  });
  let row = await operationRow(c.env.DB, id);
  if (row && row.kind !== "bootstrap")
    throw new GatewayError(409, "conflict", "This operation token is already bound to a different request");
  if (row?.state === "expired")
    throw new GatewayError(403, "account_expired", "The account recovery deadline has passed");

  // A self-host belongs to whoever initializes it first, exactly as its first
  // console registration does. Once an account exists, neither door reopens.
  if (!row && decision.requiresEmptyDeployment) {
    if (await prepared(c.env.DB, sql`SELECT 1 WHERE NOT ${emptyDeploymentCondition()}`).first())
      throw new GatewayError(409, "conflict", "This deployment has already been initialized");
  }

  if (!row) {
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
    const { accountId, userId, createdAt, recoveryEndsAt } = decision;
    const guard = decision.requiresEmptyDeployment ? emptyDeploymentCondition() : sql`1`;
    const created = sql`EXISTS (
      SELECT 1 FROM mgmt_organization WHERE id=${accountId} AND created_by_user_id=${userId})`;
    await c.env.DB.batch([
      prepared(c.env.DB, sql`INSERT OR IGNORE INTO mgmt_user(id,name,email,email_verified,kind,created_at,updated_at)
         SELECT ${userId},'CLI service',NULL,0,'service',${now},${now} WHERE ${guard}`),
      prepared(c.env.DB, sql`INSERT OR IGNORE INTO mgmt_organization(id,name,created_by_user_id,expires_at,created_at,updated_at)
         SELECT ${accountId},'My account',${userId},${recoveryEndsAt},${createdAt},${createdAt} WHERE ${guard}`),
      prepared(c.env.DB, sql`INSERT OR IGNORE INTO mgmt_organization_user(id,organization_id,user_id,role,status,joined_at)
         SELECT ${`member-${accountId}`},${accountId},${userId},'owner','active',${createdAt} WHERE ${created}`),
      prepared(c.env.DB, sql`INSERT OR IGNORE INTO mgmt_operation(
           id,kind,state,organization_id,initiating_user_id,request_hash,
           expires_at,created_at,updated_at)
         SELECT ${id},'bootstrap','completed',${accountId},${userId},${hash},${now + ACCOUNT_RECOVERY_MS},${now},${now}
         WHERE ${created}
         -- One bootstrap per account: a second token never attaches to an
         -- account another bootstrap already holds.
         AND NOT EXISTS (SELECT 1 FROM mgmt_operation WHERE kind='bootstrap' AND organization_id=${accountId})
         ${decision.requiresEmptyDeployment ? sql`AND NOT EXISTS (SELECT 1 FROM mgmt_operation WHERE kind='bootstrap')` : sql.empty()}`),
    ]);
    row = await operationRow(c.env.DB, id);
    if (!row)
      throw new GatewayError(409, "conflict", "This deployment has already been initialized");
  }

  if (!row.organization_id || !row.initiating_user_id)
    throw new GatewayError(403, "account_expired", "The account recovery deadline has passed");
  const account = await assertAccountAccess(deployment, c.env, row.organization_id, "read");
  if (account.claimed || row.state !== "completed")
    throw new GatewayError(403, "forbidden", "Bootstrap authority has been retired");

  const identity = await identityAuthFor(c);
  row = await currentCredential(c, identity, row, account.id, now);

  // Issued inactive, activated only now: a key becomes usable once the row that
  // names it is committed, so a run that dies in between leaves a credential
  // nobody holds and nothing can authenticate with. Activation is idempotent
  // and refuses a revoked key, so repeating a request finishes an interrupted
  // run without resurrecting what a claim has already retired.
  await identity.service.enableServiceApiKey({
    apiKeyId: row.credential_id!,
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
  const credential = JSON.parse(
    await openSecret(c.env, "cliOperation", [row.id], row.sealed_outcome!),
  ) as { token: string };
  return {
    id: row.id,
    kind: "bootstrap",
    state: "completed",
    expiresAt: new Date(row.expires_at).toISOString(),
    deployment: meta,
    account: await accountLifecycle(c.env, account.id),
    result: { credential, unclaimedAccess },
  };
}

/**
 * The row with a sealed management key the CLI can still collect, issuing and
 * sealing a new one when there is none or the last one's window has passed.
 *
 * The row is the single durable record of which key this bootstrap stands
 * behind. Whichever key it does not name is retired, whether that is the one
 * this call lost a race with or the one it replaced.
 */
async function currentCredential(
  c: CliContext,
  identity: CfAuth,
  row: OperationRow,
  accountId: string,
  now: number,
): Promise<OperationRow> {
  if (row.sealed_outcome && (row.sealed_until ?? 0) > now && row.credential_id) return row;
  // No expiry of its own: the account's `expires_at` is the one deadline, and
  // cf-auth refuses any key whose organization has passed it.
  const issued = await identity.service.issueServiceApiKey({
    userId: row.initiating_user_id!,
    organizationId: accountId,
    name: "CLI bootstrap",
    enabled: false,
  });
  const sealed = await sealSecret(c.env, "cliOperation", [row.id], JSON.stringify({ token: issued.plaintext }))
    .catch(async (error) => {
      await retireKey(identity, accountId, issued.id);
      throw error;
    });
  const previous = row.credential_id;
  await prepared(c.env.DB, sql`UPDATE mgmt_operation
     SET sealed_outcome=${sealed},sealed_until=${now + SEALED_TTL},credential_id=${issued.id},updated_at=${now}
     WHERE id=${row.id} AND state='completed'
       AND (sealed_outcome IS NULL OR sealed_until<=${now})
       AND NOT ${humanOwnerCondition(sql.raw("mgmt_operation.organization_id"))}`)
    .run()
    .catch(async (error) => {
      // A failed RPC can still have committed, so ask the row who won before
      // retiring the key this call minted.
      const committed = await operationRow(c.env.DB, row.id);
      if (!committed || committed.credential_id !== issued.id)
        await retireKey(identity, accountId, issued.id);
      throw error;
    });
  const current = (await operationRow(c.env.DB, row.id))!;
  if (current.credential_id !== issued.id) await retireKey(identity, accountId, issued.id);
  else if (previous) await retireKey(identity, accountId, previous);
  if (current.state !== "completed" || !current.sealed_outcome || !current.credential_id)
    throw new GatewayError(403, "forbidden", "Bootstrap authority has been retired");
  return current;
}
