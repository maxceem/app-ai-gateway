/**
 * The caller's own access: who they are, their accounts, and the credentials
 * that act for the account (management keys, CLI logins, MCP connections).
 *
 * Every rule is cf-auth's: these handlers only turn HTTP into its service
 * calls. Listing accounts, switching, and anything about credentials needs a
 * person signed in to the console (`requireConsoleSession`): a key that could
 * mint keys would hand over more than itself.
 */
import type { ApiKeySummary, AuthState, OrganizationMembership } from "@maxceem/cf-auth";
import type { Context } from "hono";
import { z } from "zod";
import { CLI_CLIENT_ID } from "../auth/identity.ts";
import { AccountSelectRequestSchema, CredentialSchema, ManagementKeyCreateRequestSchema } from "../contracts/access.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { emailVerificationRequired, readAccountPending } from "../core/account-standing.ts";
import { APP_TRAFFIC_BILLING_DEADLINE_MS, getAppTrafficBillingAccess } from "../billing/access.ts";
import { billingBinding } from "../billing/contract.ts";
import type { SessionBilling } from "../contracts/billing.ts";
import { withDeadline } from "../core/background.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { planAllowance } from "./billing.ts";
import { GatewayError } from "../core/errors.ts";
import { requireConsoleSession, type AdminActor, type AdminVariables } from "./actor.ts";
import { parseBody } from "./apps.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;
type Credential = z.output<typeof CredentialSchema>;

/** The accounts a person may act in: their active memberships. */
export function activeAccounts(memberships: readonly OrganizationMembership[]): { id: string; name: string; role: AdminActor["role"] }[] {
  return memberships
    .filter((membership) => membership.status === "active")
    .map(({ organization, role }) => ({ id: organization.id, name: organization.name, role }));
}

/**
 * Whether the account's apps are refused for its owner's unverified email:
 * only where the deployment verifies addresses, and only while the account is
 * waiting: every active owner's address marked and not verified.
 */
async function verificationPending(env: Env, accountId: string): Promise<boolean> {
  return emailVerificationRequired(env) && (await readAccountPending(env, accountId));
}

/**
 * The account's plan and this period's allowance, for `account status`. Only
 * where the deployment has billing. It never fails or holds up the session:
 * the plan and the count share one budget, the app-traffic deadline (Sol 7b-8),
 * and a read that cannot finish in it shows as no figure.
 */
async function sessionBilling(c: AdminContext, accountId: string): Promise<SessionBilling | undefined> {
  if (billingBinding(c.env) === null) return undefined;
  const started = Date.now();
  const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
  const access = await getAppTrafficBillingAccess(c.env, accountId, waitUntil);
  if (access.state !== "billed") return { state: "unavailable", planName: null, allowance: null };
  let allowance: SessionBilling["allowance"] = null;
  const left = APP_TRAFFIC_BILLING_DEADLINE_MS - (Date.now() - started);
  try {
    if (left <= 0) throw new Error("no time left for the allowance");
    const reading = await withDeadline(planAllowance(c.env, accountId, access), left, "reading the allowance");
    if (reading !== null) allowance = { used: reading.used, limit: reading.limit, resetAt: reading.resetAt };
  } catch (error) {
    log("warn", "billing_allowance_unreadable", { account: accountId, error: errorFacts(error) });
  }
  return { state: "billed", planName: access.plan?.planName ?? null, allowance };
}

function sessionPayload(
  state: AuthState,
  actor: AdminActor,
  pending: boolean,
  billing?: SessionBilling,
): OperationResponse<"getAdminSession">["session"] {
  const user = state.user!;
  const accounts = actor.credentialType === "session"
    ? activeAccounts(state.memberships)
    : [{ id: actor.accountId, name: state.organization?.name ?? "", role: actor.role }];
  return {
    user: { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified },
    // Written only when true, so a client that does not know it meets it only then.
    account: { id: actor.accountId, name: state.organization?.name ?? "", ...(pending ? { verificationPending: true } : {}) },
    role: actor.role,
    grant: actor.grant,
    credentialType: actor.credentialType,
    accounts,
    ...(billing === undefined ? {} : { billing }),
  };
}

export async function getAdminSession(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const [pending, billing] = await Promise.all([verificationPending(c.env, actor.accountId), sessionBilling(c, actor.accountId)]);
  return c.json({ session: sessionPayload(c.get("authState"), actor, pending, billing) } satisfies OperationResponse<"getAdminSession">);
}

export async function listAccounts(c: AdminContext): Promise<Response> {
  const state = requireConsoleSession(c.get("authState"));
  const memberships = await (await c.get("identity")).service.listOrganizations(state);
  return c.json({ accounts: activeAccounts(memberships) } satisfies OperationResponse<"listAccounts">);
}

export async function selectAccount(c: AdminContext): Promise<Response> {
  const state = requireConsoleSession(c.get("authState"));
  const { accountId } = await parseBody(c, AccountSelectRequestSchema);
  const identity = await c.get("identity");
  const selected = await identity.service.selectOrganization(state, accountId);
  await identity.currentOrganizationCookie.write(c, accountId);
  const actor: AdminActor = {
    ...c.get("actor"),
    accountId: selected.organization?.id ?? accountId,
    role: selected.role ?? c.get("actor").role,
  };
  const pending = await verificationPending(c.env, actor.accountId);
  return c.json({ session: sessionPayload(selected, actor, pending) } satisfies OperationResponse<"selectAccount">);
}

/** A key or an OAuth sign-in as the access page shows it. */
export function credentialOf(key: ApiKeySummary): Credential {
  const oauth = key.credentialType === "oauth";
  return {
    id: key.id,
    kind: !oauth ? "management_key" : key.clientId === CLI_CLIENT_ID ? "cli" : "mcp",
    name: key.name,
    grant: key.grant,
    hint: oauth ? null : key.tokenHint,
    clientId: oauth ? key.clientId : null,
    userId: key.userId,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
  };
}

export async function listCredentials(c: AdminContext): Promise<Response> {
  const state = requireConsoleSession(c.get("authState"));
  const keys = await (await c.get("identity")).service.listApiKeys({ actor: state, organizationId: c.get("actor").accountId });
  const credentials = keys
    .filter((key) => key.enabled || key.revokedAt !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(credentialOf);
  return c.json({ credentials } satisfies OperationResponse<"listCredentials">);
}

export async function createManagementKey(c: AdminContext): Promise<Response> {
  const state = requireConsoleSession(c.get("authState"));
  const body = await parseBody(c, ManagementKeyCreateRequestSchema);
  if (body.accountId !== undefined && body.accountId !== c.get("actor").accountId) {
    throw new GatewayError(409, "account_changed", "The console now acts in another account. Reload the page, then try again");
  }
  const created = await (await c.get("identity")).service.createApiKey({
    actor: state,
    organizationId: c.get("actor").accountId,
    name: body.name,
    grant: body.grant,
    source: "console",
  });
  const { plaintext, ...summary } = created;
  return c.json({ credential: credentialOf(summary), key: plaintext } satisfies OperationResponse<"createManagementKey">, 201);
}

export async function revokeCredential(c: AdminContext): Promise<Response> {
  const state = requireConsoleSession(c.get("authState"));
  const revoked = await (await c.get("identity")).service.revokeApiKey({
    actor: state,
    organizationId: c.get("actor").accountId,
    apiKeyId: c.req.param("id") ?? "",
  });
  if (revoked === null) throw new GatewayError(404, "not_found", "No management key or sign-in has this id in this account");
  return c.json({ credential: credentialOf(revoked) } satisfies OperationResponse<"revokeCredential">);
}
