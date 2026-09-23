import type { CfAuth } from "@maxceem/cf-auth";
import { identityAuthFor } from "../../auth/identity";
import { resolveBillingQuota } from "../../billing/quota";
import {
  accountLifecycle,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { clientAddress, enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { GatewayError } from "../../core/errors";
import { CliBootstrapRequestSchema } from "../../contracts/cli";
import type { CliBootstrapResponse } from "../../contracts/cli";
import { schemaBody } from "../../management/validation";
import { unclaimedAccessDeadline } from "../../policy/accounts";
import { bootstrapDecision } from "../../policy/deployment";
import { emptyDeploymentCondition, humanOwnerCondition } from "../../policy/sql";
import {
  cliJson,
  digest,
  openCredential,
  proofMatches,
  protectCredential,
  TTL,
} from "./security";
import type { CliContext } from "./types";

/**
 * How the CLI is told which deployment answered: its public identity, plus the
 * one thing about it a client behaves differently for.
 */
export function deploymentMeta(c: CliContext) {
  const deployment = c.get("deployment");
  return { ...deployment.identity(), mode: deployment.mode };
}

/** A `mgmt_bootstrap` row; see the table's own description for what each state means. */
interface BootstrapRow {
  id: string;
  state: "active" | "retired" | "expired";
  organization_id: string | null;
  service_user_id: string | null;
  proof_hash: string;
  credential_id: string | null;
  protected_credential: string | null;
  protected_credential_expires_at: number | null;
}

async function retireKey(
  identity: CfAuth,
  organizationId: string,
  apiKeyId: string,
): Promise<void> {
  await identity.service.revokeServiceApiKey({ apiKeyId, organizationId });
}

async function bootstrapRow(c: CliContext, id: string): Promise<BootstrapRow | null> {
  return c.env.DB.prepare("SELECT * FROM mgmt_bootstrap WHERE id=?")
    .bind(id)
    .first<BootstrapRow>();
}

export async function bootstrap(c: CliContext): Promise<CliBootstrapResponse> {
  const input = schemaBody(CliBootstrapRequestSchema, await cliJson(c.req.raw));
  const deployment = c.get("deployment");
  const meta = deploymentMeta(c);
  const hash = await digest(input.idempotencyKey);
  const proofHash = await digest(input.pollToken);
  const id = `cli-bootstrap:${meta.id}:${hash}`;
  const now = Date.now();
  const decision = bootstrapDecision(deployment, {
    deploymentId: meta.id,
    requestHash: hash,
    nowMs: now,
  });
  let row = await bootstrapRow(c, id);
  if (row && !(await proofMatches(input.pollToken, row.proof_hash)))
    throw new GatewayError(403, "forbidden", "Bootstrap proof does not match");
  if (row?.state === "expired")
    throw new GatewayError(403, "account_expired", "The account recovery deadline has passed");

  // A self-host belongs to whoever initializes it first, exactly as its first
  // console registration does. Once an account exists, neither door reopens.
  if (!row && decision.requiresEmptyDeployment) {
    if (await c.env.DB.prepare(
      `SELECT 1 WHERE NOT (${emptyDeploymentCondition()})`,
    ).first())
      throw new GatewayError(409, "conflict", "This deployment has already been initialized");
  }

  if (!row) {
    // Cloud only, where an account costs this gateway's operator something and
    // anyone can ask for one.
    //
    // A self-host counts nothing, because the only thing counting could refuse
    // there is the race to be its first caller — and that race is the rule, not
    // a flaw in it: whoever initializes an empty deployment owns it. Nobody
    // else is racing for one anyway. The address is not published, the
    // deployment is empty until its owner arrives, and the person who does own
    // it owns the infrastructure under it, so the answer to losing the race is
    // to destroy the deployment and install again.
    //
    // What a limit here would reliably refuse instead is the owner's own
    // installer retrying a deployment whose storage has not come up yet — three
    // attempts in a few seconds, and then a day of refusals on a deployment
    // nobody has ever owned. The 409 above is the guard that matters, and it
    // never expires.
    if (decision.rateLimited)
      await enforceEndpointRateLimit(c.env, "bootstrap", clientAddress(c.req.raw));
    const {
      accountId,
      userId,
      createdAt,
      recoveryEndsAt,
    } = decision;
    const guard = decision.requiresEmptyDeployment ? emptyDeploymentCondition() : "1";
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO mgmt_user(id,name,email,email_verified,kind,created_at,updated_at)
         SELECT ?,'CLI service',NULL,0,'service',?,? WHERE ${guard}`,
      ).bind(userId, now, now),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO mgmt_organization(id,name,created_by_user_id,expires_at,created_at,updated_at)
         SELECT ?,'My account',?,?,?,? WHERE ${guard}`,
      ).bind(accountId, userId, recoveryEndsAt, createdAt, createdAt),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO mgmt_organization_user(id,organization_id,user_id,role,status,joined_at)
         SELECT ?,?,?,'owner','active',? WHERE EXISTS (
           SELECT 1 FROM mgmt_organization WHERE id=? AND created_by_user_id=?)`,
      ).bind(`member-${accountId}`, accountId, userId, createdAt, accountId, userId),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO mgmt_bootstrap(
           id,state,organization_id,service_user_id,proof_hash,created_at,updated_at)
         SELECT ?,'active',?,?,?,?,? WHERE EXISTS (
           SELECT 1 FROM mgmt_organization WHERE id=? AND created_by_user_id=?)
         -- One bootstrap per account: a second proof never attaches to an
         -- account another bootstrap already holds.
         AND NOT EXISTS (SELECT 1 FROM mgmt_bootstrap WHERE organization_id=?)
         ${decision.requiresEmptyDeployment ? "AND NOT EXISTS (SELECT 1 FROM mgmt_bootstrap)" : ""}`,
      ).bind(
        id,
        accountId,
        userId,
        proofHash,
        now,
        now,
        accountId,
        userId,
        accountId,
      ),
    ]);
    row = await bootstrapRow(c, id);
    if (!row)
      throw new GatewayError(409, "conflict", "This deployment has already been initialized");
    if (!(await proofMatches(input.pollToken, row.proof_hash)))
      throw new GatewayError(403, "forbidden", "Bootstrap proof does not match");
  }

  if (!row.organization_id || !row.service_user_id)
    throw new GatewayError(403, "account_expired", "The account recovery deadline has passed");
  const account = await assertAccountAccess(deployment, c.env, row.organization_id, "read");
  if (account.claimed || row.state !== "active")
    throw new GatewayError(403, "forbidden", "Bootstrap authority has been retired");

  const identity = await identityAuthFor(c);

  if (!row.protected_credential || (row.protected_credential_expires_at ?? 0) <= now) {
    // No expiry of its own: the account's `expires_at` is the one deadline, and
    // cf-auth refuses any key whose organization has passed it. A second copy
    // here could only go stale, which is exactly what a claim would make it do.
    const issued = await identity.service.issueServiceApiKey({
      userId: row.service_user_id,
      organizationId: account.id,
      name: "CLI bootstrap",
      enabled: false,
    });
    const encrypted = await protectCredential(c.env, id, proofHash, {
      token: issued.plaintext,
    }).catch(async (error) => {
      await retireKey(identity, account.id, issued.id);
      throw error;
    });
    const previousCredentialId = row.credential_id;
    await c.env.DB.prepare(
      `UPDATE mgmt_bootstrap
       SET protected_credential=?,protected_credential_expires_at=?,credential_id=?,updated_at=?
       WHERE id=? AND state='active'
         AND (protected_credential IS NULL OR protected_credential_expires_at<=?)
         AND NOT ${humanOwnerCondition("mgmt_bootstrap.organization_id")}`,
    )
      .bind(encrypted, now + TTL, issued.id, now, id, now)
      .run()
      .catch(async (error) => {
        // A failed RPC can still have committed, so ask the row who won before
        // retiring the key this call minted.
        const committed = await bootstrapRow(c, id);
        if (!committed || committed.credential_id !== issued.id)
          await retireKey(identity, account.id, issued.id);
        throw error;
      });
    row = (await bootstrapRow(c, id))!;

    // The row is the single durable record of which key this bootstrap stands
    // behind. Whichever key it does not name is retired, whether that is the
    // one this call lost a race with or the one it replaced.
    if (row.credential_id !== issued.id) await retireKey(identity, account.id, issued.id);
    else if (previousCredentialId) await retireKey(identity, account.id, previousCredentialId);
  }
  if (row.state !== "active" || !row.protected_credential)
    throw new GatewayError(403, "forbidden", "Bootstrap authority has been retired");

  // Issued inactive, activated only now: a key becomes usable once the row that
  // names it is committed, so a run that dies in between leaves a
  // credential nobody holds and nothing can authenticate with. Activation is
  // idempotent and refuses a revoked key, so repeating a poll finishes an
  // interrupted run without resurrecting what a claim has already retired.
  const credentialId = row.credential_id;
  if (!credentialId)
    throw new GatewayError(403, "forbidden", "Bootstrap authority has been retired");
  await identity.service.enableServiceApiKey({
    apiKeyId: credentialId,
    organizationId: account.id,
  });

  let unclaimedAccess: { endsAt: string; limit?: number } | null = null;
  if (deployment.mode === "cloud") {
    const deadline = unclaimedAccessDeadline(account.createdAt);
    if (deadline === null) {
      throw new GatewayError(
        403,
        "unclaimed_access_expired",
        "This unclaimed account's free access has ended; claim your account to continue",
      );
    }
    const quota = await resolveBillingQuota(deployment, c.env, account.id);
    unclaimedAccess = {
      endsAt: new Date(deadline).toISOString(),
      ...(quota.limit === undefined ? {} : { limit: quota.limit }),
    };
  }
  return {
    deployment: meta,
    account: await accountLifecycle(c.env, account.id),
    credential: await openCredential(c.env, id, proofHash, row.protected_credential),
    unclaimedAccess,
  };
}
