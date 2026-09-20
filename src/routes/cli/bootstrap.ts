import type { CfAuth } from "@maxceem/cf-auth";
import { createIdentityAuth, rethrowCfAuthError } from "../../auth/identity";
import { billingBinding } from "../../billing/gateway";
import { resolveBillingQuota } from "../../billing/quota";
import {
  accountLifecycle,
  accountTrialEnd,
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { clientAddress, enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { GatewayError } from "../../core/errors";
import { CliBootstrapRequestSchema } from "../../contracts/cli";
import { providerSchemaBody } from "../admin/provider-shared";
import {
  cliJson,
  digest,
  openCredential,
  proofMatches,
  protectCredential,
  TTL,
} from "./security";
import type { CliContext } from "./types";

interface BootstrapReceiptRow {
  id: string;
  organization_id: string | null;
  initiating_user_id: string | null;
  proof_hash: string;
  outcome: string | null;
  protected_credential: string | null;
  protected_credential_expires_at: number | null;
  consumed_at: number | null;
  expires_at: number;
}

const humanOwner = (organizationExpression: string) => `EXISTS (
  SELECT 1 FROM mgmt_organization_user m JOIN mgmt_user u ON u.id=m.user_id
  WHERE m.organization_id=${organizationExpression} AND m.role='owner' AND u.kind='human'
)`;

/** The management key this receipt's committed outcome names, if it has one yet. */
function committedCredentialId(row: BootstrapReceiptRow): string | null {
  if (!row.outcome) return null;
  const { credentialId } = JSON.parse(row.outcome) as { credentialId?: string };
  return credentialId ?? null;
}

async function retireKey(
  identity: CfAuth,
  organizationId: string,
  apiKeyId: string,
): Promise<void> {
  try {
    await identity.service.revokeServiceApiKey({ apiKeyId, organizationId });
  } catch (error) {
    rethrowCfAuthError(error);
  }
}

export function deployment(c: CliContext) {
  const id = c.env.DEPLOYMENT_ID;
  if (!id)
    throw new GatewayError(503, "invalid_request", "Deployment identity is not configured");
  const configuredOrigin = new URL(c.env.CLI_CONSOLE_ORIGIN ?? c.req.url);
  const loopback =
    configuredOrigin.hostname === "localhost" ||
    configuredOrigin.hostname.endsWith(".localhost") ||
    configuredOrigin.hostname === "127.0.0.1";
  if (
    (configuredOrigin.protocol !== "https:" &&
      !(configuredOrigin.protocol === "http:" && loopback)) ||
    configuredOrigin.username ||
    configuredOrigin.password
  )
    throw new GatewayError(503, "invalid_request", "Configure a secure console origin");
  const consoleOrigin = configuredOrigin.origin;
  return {
    id,
    mode: billingBinding(c.env) ? ("cloud" as const) : ("self_hosted" as const),
    apiUrl: c.env.PUBLIC_API_URL ?? consoleOrigin,
    consoleOrigin,
  };
}

async function receipt(c: CliContext, id: string): Promise<BootstrapReceiptRow | null> {
  return c.env.DB.prepare("SELECT * FROM mgmt_resource_receipt WHERE id=? AND kind='bootstrap'")
    .bind(id)
    .first<BootstrapReceiptRow>();
}

export async function bootstrap(c: CliContext): Promise<Response> {
  const input = providerSchemaBody(CliBootstrapRequestSchema, await cliJson(c.req.raw));
  const meta = deployment(c);
  const hash = await digest(input.idempotencyKey);
  const proofHash = await digest(input.pollToken);
  const id = `cli-bootstrap:${meta.id}:${hash}`;
  let row = await receipt(c, id);
  if (row && !(await proofMatches(input.pollToken, row.proof_hash)))
    throw new GatewayError(403, "forbidden", "Bootstrap proof does not match");
  if (row?.outcome === '{"expired":true}')
    throw new GatewayError(403, "account_expired", "The account recovery deadline has passed");

  // A self-host belongs to whoever initializes it first, exactly as its first
  // console registration does. Once an account exists, neither door reopens.
  if (!row && meta.mode === "self_hosted") {
    if (await c.env.DB.prepare("SELECT id FROM mgmt_organization LIMIT 1").first())
      throw new GatewayError(409, "conflict", "This deployment has already been initialized");
  }

  const now = Date.now();
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
    if (meta.mode === "cloud")
      await enforceEndpointRateLimit(c.env, "bootstrap", clientAddress(c.req.raw));
    const accountId = meta.mode === "self_hosted" ? `private-${meta.id}` : `account-${hash}`;
    const userId = `service-${accountId}`;
    const createdAt = new Date(now).toISOString();
    const expiresAt =
      meta.mode === "cloud" ? new Date(now + 90 * 86_400_000).toISOString() : null;
    const guard =
      meta.mode === "self_hosted"
        ? "NOT EXISTS (SELECT 1 FROM mgmt_organization)"
        : "1";
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO mgmt_user(id,name,email,email_verified,kind,created_at,updated_at)
         SELECT ?,'CLI service',NULL,0,'service',?,? WHERE ${guard}`,
      ).bind(userId, now, now),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO mgmt_organization(id,name,created_by_user_id,expires_at,created_at,updated_at)
         SELECT ?,'My account',?,?,?,? WHERE ${guard}`,
      ).bind(accountId, userId, expiresAt, createdAt, createdAt),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO mgmt_organization_user(id,organization_id,user_id,role,status,joined_at)
         SELECT ?,?,?,'owner','active',? WHERE EXISTS (
           SELECT 1 FROM mgmt_organization WHERE id=? AND created_by_user_id=?)`,
      ).bind(`member-${accountId}`, accountId, userId, createdAt, accountId, userId),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO mgmt_resource_receipt(
           id,kind,organization_id,initiating_user_id,proof_hash,request_hash,expires_at,created_at,updated_at)
         SELECT ?,'bootstrap',?,?,?,'{}',?,?,? WHERE EXISTS (
           SELECT 1 FROM mgmt_organization WHERE id=? AND created_by_user_id=?)
         ${meta.mode === "self_hosted" ? "AND NOT EXISTS (SELECT 1 FROM mgmt_resource_receipt WHERE kind='bootstrap')" : ""}`,
      ).bind(
        id,
        accountId,
        userId,
        proofHash,
        meta.mode === "cloud" ? now + 90 * 86_400_000 : 8_640_000_000_000_000,
        now,
        now,
        accountId,
        userId,
      ),
    ]);
    row = await receipt(c, id);
    if (!row)
      throw new GatewayError(409, "conflict", "This deployment has already been initialized");
    if (!(await proofMatches(input.pollToken, row.proof_hash)))
      throw new GatewayError(403, "forbidden", "Bootstrap proof does not match");
  }

  if (!row.organization_id || !row.initiating_user_id)
    throw new GatewayError(403, "account_expired", "The account recovery deadline has passed");
  const account = await assertAccountAccess(c.env, row.organization_id, "read");
  if (account.claimed || row.consumed_at)
    throw new GatewayError(403, "forbidden", "Bootstrap authority has been retired");

  const identity = createIdentityAuth(c.env, c.req.url);

  if (!row.protected_credential || (row.protected_credential_expires_at ?? 0) <= now) {
    // No expiry of its own: the account's `expires_at` is the one deadline, and
    // cf-auth refuses any key whose organization has passed it. A second copy
    // here could only go stale, which is exactly what a claim would make it do.
    const issued = await identity.service.issueServiceApiKey({
      userId: row.initiating_user_id,
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
    const previousCredentialId = committedCredentialId(row);
    await c.env.DB.prepare(
      `UPDATE mgmt_resource_receipt
       SET protected_credential=?,protected_credential_expires_at=?,outcome=?,updated_at=?
       WHERE id=? AND consumed_at IS NULL
         AND (protected_credential IS NULL OR protected_credential_expires_at<=?)
         AND NOT ${humanOwner("mgmt_resource_receipt.organization_id")}`,
    )
      .bind(encrypted, now + TTL, JSON.stringify({ credentialId: issued.id }), now, id, now)
      .run()
      .catch(async (error) => {
        // A failed RPC can still have committed, so ask the receipt who won
        // before retiring the key this call minted.
        const committed = await receipt(c, id);
        if (!committed || committedCredentialId(committed) !== issued.id)
          await retireKey(identity, account.id, issued.id);
        throw error;
      });
    row = (await receipt(c, id))!;

    // The receipt is the single durable record of which key this bootstrap
    // stands behind. Whichever key it does not name is retired, whether that is
    // the one this call lost a race with or the one it replaced.
    const committed = committedCredentialId(row);
    if (committed !== issued.id) await retireKey(identity, account.id, issued.id);
    else if (previousCredentialId) await retireKey(identity, account.id, previousCredentialId);
  }
  if (row.consumed_at || !row.protected_credential)
    throw new GatewayError(403, "forbidden", "Bootstrap authority has been retired");

  // Issued inactive, activated only now: a key becomes usable once the receipt
  // that names it is committed, so a run that dies in between leaves a
  // credential nobody holds and nothing can authenticate with. Activation is
  // idempotent and refuses a revoked key, so repeating a poll finishes an
  // interrupted run without resurrecting what a claim has already retired.
  const credentialId = committedCredentialId(row);
  if (!credentialId)
    throw new GatewayError(403, "forbidden", "Bootstrap authority has been retired");
  try {
    await identity.service.enableServiceApiKey({
      apiKeyId: credentialId,
      organizationId: account.id,
    });
  } catch (error) {
    rethrowCfAuthError(error);
  }

  const quota = meta.mode === "cloud" ? await resolveBillingQuota(c.env, account.id) : null;
  return c.json({
    deployment: meta,
    account: await accountLifecycle(c.env, account.id),
    credential: await openCredential(c.env, id, proofHash, row.protected_credential),
    trial:
      meta.mode === "cloud"
        ? {
            endsAt: accountTrialEnd(account),
            ...(quota?.limit === undefined ? {} : { limit: quota.limit }),
          }
        : null,
  });
}
