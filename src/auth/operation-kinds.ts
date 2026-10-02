/**
 * The CLI's operation kinds as cf-auth's operation engine knows them.
 *
 * cf-auth owns the `mgmt_operation` table and its state machine: opening an
 * operation idempotently under the CLI's token and the id the CLI knows it by,
 * pinning it to its opener, capping how many may wait, approving it in a
 * browser, completing it under a guard, sealing and delivering what it
 * produced, and sweeping it. The engine has to know every kind before a
 * request reaches it, so they are registered in `createIdentityAuth` from this
 * module. What each kind *does* is the gateway's, in
 * `src/management/operation-kinds.ts`; this is only what the engine is told.
 *
 * Loaded on every identity build, so it imports nothing but types and drizzle's
 * `sql`, which the database layer has loaded already: no zod, no contract
 * schema and no cf-auth value, which would put all three on a proxied
 * request's cold path.
 */

import { sql } from "drizzle-orm";
import type {
  AuthState,
  CfAuth,
  OperationApproveResult,
  OperationKind,
} from "@maxceem/cf-auth";
import type { CliApprovalRefusal, CliOperationKind } from "../contracts/cli";

/**
 * How long an operation's record is kept, counted from when it was opened, and
 * so how long the same token keeps answering for it. The CLI never resends a
 * record older than this, since a token whose row is gone would be taken for a
 * new request and repeat work that already landed.
 */
export const OPERATION_RECORD_TTL_MS = 90 * 86_400_000;

/**
 * How long a bootstrap's record is kept: past the account's own ninety-day
 * recovery deadline *and* the CLI's ninety days of resending, so the tombstone
 * account cleanup leaves when it collects the account outlives every token
 * that could still ask for it. A record that went first would let a resent
 * token recreate the account the deadline removed, with a fresh free window.
 */
export const BOOTSTRAP_RECORD_TTL_MS = 180 * 86_400_000;

/**
 * How many operations may wait at once, per account and per opener — the
 * signed-in sender, or for a login the network address it came from.
 */
export const OPERATION_LIMITS = { pendingPerOrganization: 10, pendingPerOpener: 10 } as const;

/**
 * The kinds that run one management write, and whether each runs at once,
 * only after a browser step, or either way.
 */
export const RESOURCE_OPERATION_KINDS = {
  "app.add": "never",
  "app.key.add": "never",
  "provider.add": "optional",
  "provider.update": "always",
  "provider.rotate-key": "always",
  "provider-gateway.add": "optional",
  "provider-gateway.rotate-key": "always",
} as const satisfies Partial<Record<CliOperationKind, "never" | "optional" | "always">>;

export type ResourceOperationKind = keyof typeof RESOURCE_OPERATION_KINDS;

/**
 * The creates an agent makes under a reservation: one call reserves, a second
 * executes it once, and a repeat is answered with what the first did. Each is
 * a kind of its own to the engine — `app.add.reserved` beside the CLI's
 * `app.add` — because the two deliver the key they mint differently: the CLI
 * collects it by polling, and an agent never sees it at all, so a person
 * reveals it on a page.
 */
export const RESERVED_OPERATION_KINDS = ["app.add", "app.key.add"] as const satisfies readonly ResourceOperationKind[];

export type ReservedOperationKind = (typeof RESERVED_OPERATION_KINDS)[number];

const RESERVED_SUFFIX = ".reserved";

/** The engine's name for a reserved create; see {@link RESERVED_OPERATION_KINDS}. */
export function reservedKindName(kind: ReservedOperationKind): string {
  return `${kind}${RESERVED_SUFFIX}`;
}

/** Whether an engine kind is a reserved create, whose key only a person may reveal. */
export function isReservedKindName(engineKind: string): boolean {
  return engineKind.endsWith(RESERVED_SUFFIX);
}

/**
 * The engine's name for a resource write: the CLI's own kind when it runs at
 * once, and that kind with `.browser` when it owes a browser step. They are two
 * kinds to the engine because one is completed by the gateway and the other by
 * whoever holds the approval link, and a token opened as one is never taken
 * for the other.
 */
export function engineKindName(kind: CliOperationKind, browser: boolean): string {
  return browser && kind in RESOURCE_OPERATION_KINDS ? `${kind}.browser` : kind;
}

/** The CLI's kind for an engine kind; see {@link engineKindName} and {@link reservedKindName}. */
export function cliKindName(engineKind: string): string {
  if (engineKind.endsWith(".browser")) return engineKind.slice(0, -".browser".length);
  if (isReservedKindName(engineKind)) return engineKind.slice(0, -RESERVED_SUFFIX.length);
  return engineKind;
}

/**
 * What a resource write stores as its payload.
 *
 * `requestHash` binds a retry with the same token to the same request — the
 * engine binds the payload it stores, and the request itself may carry a
 * secret that must not be stored. A write with a browser step also stores what
 * its approver reviews, never its secret, and who sent it: that step is
 * approved by whoever holds its link, and the write runs as its sender.
 */
export interface ResourceEnvelope {
  requestHash: string;
  review?: Record<string, unknown>;
  sender?: { userId: string; credentialId: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HEX_DIGEST = /^[0-9a-f]{64}$/u;

/** A stored or sent envelope, or a refusal. The engine runs it on open, and the routes on read. */
export function parseResourceEnvelope(value: unknown): ResourceEnvelope {
  if (!isRecord(value) || typeof value.requestHash !== "string" || !HEX_DIGEST.test(value.requestHash))
    throw new Error("A resource operation's payload must carry its request digest");
  const { requestHash, review, sender } = value;
  if (review !== undefined && !isRecord(review)) throw new Error("A reviewed payload must be an object");
  if (
    sender !== undefined
    && (!isRecord(sender) || typeof sender.userId !== "string" || typeof sender.credentialId !== "string")
  )
    throw new Error("A browser step names the user and the credential that sent it");
  if ((review === undefined) !== (sender === undefined))
    throw new Error("A browser step stores both what it shows and who sent it");
  return {
    requestHash,
    ...(review === undefined ? {} : { review }),
    ...(sender === undefined ? {} : { sender: { userId: sender.userId as string, credentialId: sender.credentialId as string } }),
  };
}

/** What an approval page may submit with a resource step: the secret it collected, if the kind takes one. */
export interface ResourceInput {
  secret?: string;
}

/**
 * Reads a page's submission for a resource step. The request schema has
 * already refused a blank or oversized secret; this is the engine's own
 * reading of the same value, which it never stores.
 */
function parseResourceInput(value: unknown): ResourceInput {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error("A browser step's input must be an object");
  const { secret } = value;
  if (secret === undefined) return {};
  if (typeof secret !== "string" || !/\S/u.test(secret) || secret.length > 16384)
    throw new Error("A browser step's secret must be a non-blank string");
  return { secret };
}

/**
 * The write a resource step's approval commits, staged by the gateway just
 * before it asks the engine to approve.
 *
 * The write is a management service's own — its plan caps, its sealing of a
 * provider secret, its refusals and the caches it clears — so the gateway runs
 * it as it runs every other, under the engine's guard, and stops where it would
 * commit. The kind's `approve` then hands those statements to the engine, which
 * commits them in the batch that completes the operation. Staged per identity
 * instance, which lives for one request.
 */
const staged = new WeakMap<CfAuth, Map<string, OperationApproveResult>>();

export function stageApproval(identity: CfAuth, id: string, approval: OperationApproveResult): () => void {
  let byId = staged.get(identity);
  if (!byId) staged.set(identity, (byId = new Map()));
  byId.set(id, approval);
  return () => byId.delete(id);
}

function stagedApproval(identity: CfAuth, id: string): OperationApproveResult {
  const approval = staged.get(identity)?.get(id);
  if (!approval) throw new Error("A resource step is approved only with the write the gateway staged for it");
  staged.get(identity)!.delete(id);
  return approval;
}

/**
 * What has to happen before this browser may claim `organizationId`, or null
 * when nothing does.
 *
 * Asked of memberships rather than of the session, because the three cases that
 * decide it are all about what a person already owns: Google consent can sign
 * someone in as a person who exists already, a person with no membership at all
 * (registered for a claim that then expired) may legitimately go on and claim,
 * and a claim that already landed has to stay re-approvable, which is why the
 * account being claimed is excluded from the count.
 *
 * The answer names a remedy rather than a cause, because it is the whole of
 * what the approval page is told. Registering is the remedy for having no
 * session here, not signing in: a claim is taken by a person who does not have
 * an account yet, so the door that admits people who already have one is the
 * door this rule exists to shut.
 */
export function claimRefusal(
  state: AuthState | null,
  organizationId: string,
): CliApprovalRefusal | null {
  if (
    !state
    || state.assurance !== "interactive"
    || state.user?.kind !== "human"
    || !state.actor?.credentialId
  )
    return "registration_required";
  if (state.memberships.some((member) => member.organization.id !== organizationId))
    return "sign_out_required";
  return null;
}

/**
 * Every kind this gateway registers, the built-in `login` aside.
 *
 * `identity` is the instance being built, read lazily: a claim's approval is
 * cf-auth's own `claimOrganization`, run on the same instance that approves it,
 * and a resource step's approval is the write staged on it.
 */
export function gatewayOperationKinds(identity: () => CfAuth): OperationKind[] {
  const bootstrap: OperationKind = {
    name: "bootstrap",
    // It is how a CLI with no credential gets its first account.
    open: "public",
    browser: false,
    // Its key is handed to every retry until its window closes, because
    // sending the bootstrap again is how a CLI whose answer was lost recovers.
    deliver: "window",
    // Its record is what stops the same token recreating an account the
    // recovery deadline already removed; see BOOTSTRAP_RECORD_TTL_MS.
    recordTtlMs: BOOTSTRAP_RECORD_TTL_MS,
    // It waits as long as it is kept. One whose account batch failed stays
    // pending, and the same token finishes it whenever it is sent again —
    // it never reads as expired, which is what an account the deadline
    // removed reads as.
    pendingTtlMs: BOOTSTRAP_RECORD_TTL_MS,
  };
  const claim: OperationKind = {
    name: "claim",
    open: { minRole: "admin" },
    browser: true,
    // Whoever approves a claim belongs to no account yet: it is how they get
    // one. Who may is `claimRefusal`, not a role.
    approverMinRole: null,
    recordTtlMs: OPERATION_RECORD_TTL_MS,
    refusal: ({ operation, viewer }) => claimRefusal(viewer, operation.organizationId ?? ""),
    // Every row this moves — the owner membership, the account's deadline, the
    // service identity's key — belongs to cf-auth, so cf-auth builds the
    // statements, guarded by its own re-read of the approving session and of
    // the CLI credential that asked for the claim, and by the operation's guard
    // besides. The engine commits them in the batch that completes the claim,
    // riding on the last of them, which changes a row exactly when the
    // approver ends up owner: a claim lands exactly when its operation
    // completes, and a claim that was declined, or approved by somebody else,
    // first leaves no owner behind.
    approve: ({ operation, actor, user, guard }) => {
      const organizationId = operation.organizationId!;
      const claim = identity().service.claimOrganizationStatements({
        actor: actor!,
        organizationId,
        condition: guard,
        provisioning: {
          userId: operation.openerUserId!,
          credentialId: operation.openerCredentialId!,
          // A claim never retires the CLI that asked for it: the person
          // approving is at their terminal mid-command, and an approval that
          // logged them out of it would be a worse answer than anything it
          // could protect against. Retiring that access is the console's job,
          // afterwards.
          revokeAccess: false,
        },
      });
      return { outcome: { accountId: organizationId, approvedBy: user!.id }, ...claim };
    },
  };
  const resources = Object.entries(RESOURCE_OPERATION_KINDS).flatMap(([name, browser]): OperationKind[] => {
    const kind = name as ResourceOperationKind;
    const common = {
      payload: parseResourceEnvelope,
      open: { minRole: "admin" },
      // A one-time key it minted is handed to every retry until its window
      // closes, however many race for it.
      deliver: "window",
      recordTtlMs: OPERATION_RECORD_TTL_MS,
    } as const;
    const immediate: OperationKind = {
      ...common,
      name: engineKindName(kind, false),
      browser: false,
      // No person is waited for: it stays pending only when its write failed,
      // and the same token reruns that write for as long as the CLI will send
      // it again, which is as long as it is kept.
      pendingTtlMs: OPERATION_RECORD_TTL_MS,
    };
    const approved: OperationKind = {
      ...common,
      name: engineKindName(kind, true),
      browser: true,
      // The link is the whole authority: the step only collects what the CLI
      // sent its person there for, and the write runs as the CLI that sent it,
      // whose credential the engine rechecks when it commits.
      approver: "proof",
      input: parseResourceInput,
      approve: ({ operation }) => stagedApproval(identity(), operation.id),
    };
    return browser === "never" ? [immediate] : browser === "always" ? [approved] : [immediate, approved];
  });
  const reserved = RESERVED_OPERATION_KINDS.map((kind): OperationKind => ({
    name: reservedKindName(kind),
    payload: parseResourceEnvelope,
    open: { minRole: "admin" },
    browser: false,
    // The key it minted reaches nobody but a person on the reveal page: not
    // the agent that executed it, and not whoever holds the handle and polls.
    deliver: "reveal",
    recordTtlMs: OPERATION_RECORD_TTL_MS,
    // A key revoked before anyone revealed it is not revealed: it would be a
    // credential that no longer works, shown as though it did.
    deliverable: ({ record }) => {
      const keyId = (record as { api_key?: { id?: unknown } | null } | null)?.api_key?.id;
      return typeof keyId === "string"
        ? sql`exists (select 1 from app_api_key where id = ${keyId} and status = 'active')`
        : undefined;
    },
  }));
  return [bootstrap, claim, ...resources, ...reserved];
}
