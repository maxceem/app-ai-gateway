/**
 * Unclaimed accounts: an account owned by a service identity, created without
 * a person, living under the deployment's bootstrap rule and — on a hosted
 * deployment — expiring unless a person claims it.
 *
 * Two doors lead here and neither owns the concept: the CLI's bootstrap, and
 * the "continue without an account" choice an OAuth connection's consent page
 * offers. Both decide with {@link unclaimedAccountDecision}, admit a new
 * account with {@link admitUnclaimedAccount} — the admission, then the rate
 * limit — and create it with {@link unclaimedAccountStatements} in the batch
 * that completes an operation of their own, so one rule, one rate limit and
 * one guarded write decide what either may create. What each door then hands
 * its caller — the CLI's management key, a connection's grant — is the door's
 * own, and so is the name of the service identity that owns the account: it
 * is issued for the `userId` and `accountId` the decision names.
 */

import type { CfAuthOperations, OperationView } from "@maxceem/cf-auth";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { engineRefused } from "../auth/identity";
import { enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import { GatewayError } from "../core/errors";
import { database } from "../db";
import { mgmtOrganization, mgmtOrganizationUser, mgmtUser } from "../db/schema";
import { guardedInsert, prepared, type WriteStatement } from "../db/sql";
import { bootstrapDecision, type BootstrapDecision } from "../policy/deployment";
import { emptyDeploymentCondition } from "../policy/sql";
import type { ManagementScope } from "./scope";

/**
 * What the operation that created an unclaimed account records: the account,
 * the service identity that owns it, and the one credential the operation
 * stands behind — null until the door that opened it has issued one.
 */
export interface UnclaimedAccountRecord {
  accountId: string;
  userId: string;
  credentialId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored record as {@link UnclaimedAccountRecord}, or null where the
 * operation holds none. The engine stores what this gateway handed it, so one
 * that breaks the shape means the deployment has moved under its own data.
 */
export function unclaimedAccountRecord(raw: unknown): UnclaimedAccountRecord | null {
  if (raw === null || raw === undefined) return null;
  if (
    !isRecord(raw)
    || typeof raw.accountId !== "string"
    || typeof raw.userId !== "string"
    || (raw.credentialId !== null && typeof raw.credentialId !== "string")
  )
    throw new GatewayError(500, "internal_error", "A stored operation does not match its kind");
  return { accountId: raw.accountId, userId: raw.userId, credentialId: raw.credentialId };
}

/**
 * Which account an operation would create and under what rule, chosen once
 * from the deployment's bootstrap rule. `requestHash` is the digest of the
 * secret the opening client holds, which is what the account id is derived
 * from where each request gets an account of its own.
 */
export function unclaimedAccountDecision(
  scope: ManagementScope,
  input: { requestHash: string; nowMs: number },
): BootstrapDecision {
  return bootstrapDecision(scope.deployment, {
    deploymentId: scope.deployment.identity().id,
    requestHash: input.requestHash,
    nowMs: input.nowMs,
  });
}

/** What the deployment's rule says about admitting a new unclaimed account, whichever account it would be. */
type AdmissionRule = Pick<BootstrapDecision, "requiresEmptyDeployment" | "rateLimited">;

/** The deployment's rule for a new unclaimed account, before any account is named. */
export function unclaimedAccountRule(scope: ManagementScope): AdmissionRule {
  const { requiresEmptyDeployment, rateLimited } = scope.deployment.rules.bootstrap;
  return { requiresEmptyDeployment, rateLimited };
}

async function deploymentEmpty(scope: ManagementScope): Promise<boolean> {
  return !(await prepared(scope.env.DB, sql`SELECT 1 WHERE NOT ${emptyDeploymentCondition()}`).first());
}

/**
 * Whether a new unclaimed account could be admitted now, read without a side
 * effect: nothing is counted. A page that offers the choice asks this, so it
 * offers it exactly where choosing it would get past the admission — the rate
 * limit aside, which only answers once it is spent.
 */
export async function unclaimedAccountAvailable(scope: ManagementScope): Promise<boolean> {
  return !unclaimedAccountRule(scope).requiresEmptyDeployment || deploymentEmpty(scope);
}

/**
 * The admission alone: refuses a new unclaimed account the deployment's rule
 * does not allow now, and answers the condition the batch that creates it must
 * still hold, or null where it needs none. Never counts anything, so a refusal
 * here spends no allowance.
 */
export async function admitUnclaimedAccountCondition(
  scope: ManagementScope,
  rule: AdmissionRule,
): Promise<SQL | null> {
  // A self-host belongs to whoever initializes it first, exactly as its first
  // console registration does. Once an account exists, neither door reopens.
  if (!rule.requiresEmptyDeployment) return null;
  if (!(await deploymentEmpty(scope)))
    throw new GatewayError(409, "conflict", "This deployment has already been initialized");
  return emptyDeploymentCondition();
}

/**
 * The rate limit alone, after the admission: `address` is the network address
 * of whoever asked — the CLI's, or the browser's at consent — and is counted
 * only where the deployment's rule says so, under the one bootstrap counter
 * both doors share.
 */
export async function limitUnclaimedAccounts(
  scope: ManagementScope,
  rule: AdmissionRule,
  address: string,
): Promise<void> {
  // Cloud only, where an account costs this gateway's operator something and
  // anyone can ask for one.
  //
  // A self-host counts nothing, because the only thing counting could refuse
  // there is the race to be its first caller — and that race is the rule, not
  // a flaw in it: whoever initializes an empty deployment owns it. What a
  // limit here would reliably refuse instead is the owner's own installer
  // retrying a deployment whose storage has not come up yet. The admission's
  // 409 is the guard that matters, and it never expires.
  if (rule.rateLimited) await enforceEndpointRateLimit(scope.env, "bootstrap", address);
}

/**
 * Whether a new unclaimed account may be asked for at all, checked before the
 * operation that would create it is opened: the admission, then the rate
 * limit, so a refused admission spends nothing.
 */
export async function admitUnclaimedAccount(
  scope: ManagementScope,
  decision: BootstrapDecision,
  address: string,
): Promise<void> {
  await admitUnclaimedAccountCondition(scope, decision);
  await limitUnclaimedAccounts(scope, decision, address);
}

/**
 * The rows an unclaimed account is: its service identity, named by the door
 * that asked (`serviceName`), the account with its deadline, and the owner
 * membership — as builders for the batch that completes the door's operation.
 *
 * Every row is guarded by `guard`, the operation's own. `admission` is the
 * condition the admission answered, carried by the identity and the account
 * only: the membership is guarded instead by the account being this identity's
 * creation, since the account it follows is exactly what makes an emptiness
 * rule false. A door whose engine judges the admission once, up front, passes
 * none.
 */
export function unclaimedAccountStatements(
  scope: ManagementScope,
  decision: BootstrapDecision,
  options: { guard: SQL; admission: SQL | null; serviceName: string },
): WriteStatement[] {
  const { accountId, userId, createdAt, recoveryEndsAt } = decision;
  const { guard, admission, serviceName } = options;
  const create = admission === null ? guard : and(guard, admission)!;
  const created = sql`EXISTS (
    SELECT 1 FROM mgmt_organization WHERE id=${accountId} AND created_by_user_id=${userId})`;
  const at = new Date(Date.parse(createdAt));
  const db = database(scope.env.DB);
  return [
    guardedInsert(db, mgmtUser, {
      id: userId,
      name: serviceName,
      email: null,
      emailVerified: false,
      kind: "service",
      createdAt: at,
      updatedAt: at,
    }, create).onConflictDoNothing(),
    guardedInsert(db, mgmtOrganization, {
      id: accountId,
      name: "My account",
      createdByUserId: userId,
      expiresAt: recoveryEndsAt,
      createdAt,
      updatedAt: createdAt,
    }, create).onConflictDoNothing(),
    guardedInsert(db, mgmtOrganizationUser, {
      id: `member-${accountId}`,
      organizationId: accountId,
      userId,
      role: "owner",
      status: "active",
      joinedAt: createdAt,
    }, and(guard, created)!).onConflictDoNothing(),
  ];
}

/**
 * Creates the account an open, pending operation stands for, in the batch that
 * completes it, and answers with the operation as it then stands.
 *
 * `view` reads the operation back the way its door reads it — the CLI polls
 * with its token. A door whose account already exists — one per request, and
 * this request's created it before its answer was lost — completes on it
 * instead. An operation still pending after both means another caller took the
 * one account the deployment has, or the write lost a race worth sending
 * again, and is refused as such.
 */
export async function provisionUnclaimedAccount(
  scope: ManagementScope,
  engine: CfAuthOperations,
  operation: { id: string; view: () => Promise<OperationView> },
  decision: BootstrapDecision,
  serviceName: string,
): Promise<OperationView> {
  await createAccount(scope, engine, operation.id, decision, serviceName);
  let view = await operation.view();
  // The account this token's own already exists, so there was nothing to
  // create: the operation is completed on it, as the answer to a resend is.
  if (view.state === "pending" && decision.accountPerToken) {
    await adoptAccount(scope, engine, operation.id, decision);
    view = await operation.view();
  }
  if (view.state === "pending")
    throw decision.accountPerToken
      ? new GatewayError(409, "conflict", "The account for this request could not be created; send it again")
      : new GatewayError(409, "conflict", "This deployment has already been initialized");
  return view;
}

/** The refusals that mean a twin, or another caller, settled the operation first. */
function settledElsewhere(error: unknown): boolean {
  return ["conflict", "already_completed", "operation_expired"].some((code) => engineRefused(error, code));
}

/**
 * Creates the account in the batch that completes its operation.
 *
 * Every statement is guarded by the engine — the operation is still pending —
 * and, on a deployment only its first caller may take, by emptiness. The
 * engine completes the operation only if the last of them, the owner
 * membership, was written, so of two tokens racing for an empty self-host the
 * one whose account landed completes and the other stays pending, unused. The
 * record names no credential yet: one needs the membership this batch creates,
 * and is issued, sealed and recorded next by the door that asked.
 */
async function createAccount(
  scope: ManagementScope,
  engine: CfAuthOperations,
  id: string,
  decision: BootstrapDecision,
  serviceName: string,
): Promise<void> {
  const { accountId, userId } = decision;
  const guard = await engine.guard({ id });
  const record: UnclaimedAccountRecord = { accountId, userId, credentialId: null };
  try {
    await engine.complete({
      id,
      outcome: record,
      statements: unclaimedAccountStatements(scope, decision, {
        guard,
        admission: decision.requiresEmptyDeployment ? emptyDeploymentCondition() : null,
        serviceName,
      }),
    });
  } catch (error) {
    // A twin completed it first, or another caller took an empty self-host:
    // the operation as it now stands says which.
    if (settledElsewhere(error)) return;
    throw error;
  }
}

/**
 * Completes an operation whose account already exists: one whose token is the
 * only thing that could have created it, on a deployment that gives each token
 * an account of its own. Completion rides on a no-op touch of that account,
 * guarded by the engine and by the account still being this token's service
 * identity's creation, so it lands only on the account it names.
 */
async function adoptAccount(
  scope: ManagementScope,
  engine: CfAuthOperations,
  id: string,
  decision: BootstrapDecision,
): Promise<void> {
  const { accountId, userId } = decision;
  const guard = await engine.guard({ id });
  const record: UnclaimedAccountRecord = { accountId, userId, credentialId: null };
  try {
    await engine.complete({
      id,
      outcome: record,
      statements: [
        database(scope.env.DB)
          .update(mgmtOrganization)
          .set({ updatedAt: sql`${mgmtOrganization.updatedAt}` })
          .where(and(eq(mgmtOrganization.id, accountId), eq(mgmtOrganization.createdByUserId, userId), guard)),
      ],
    });
  } catch (error) {
    if (settledElsewhere(error)) return;
    throw error;
  }
}
