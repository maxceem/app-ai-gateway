import type { CliHandoffContinuation, CliOperationKind } from "../../contracts/cli";
import { GatewayError } from "../../core/errors";
import type { Actor } from "../../management/actor";
import {
  createProviderGateway,
  rotateProviderGateway,
} from "../../management/provider-gateways";
import { createProvider, updateProvider } from "../../management/providers";
import type { ManagementScope } from "../../management/scope";
import type { ResourceWriteBoundary } from "../../management/write-boundary";
import type { AccountAccessMode } from "../../policy/accounts";
import type { HandoffRow } from "./types";

/**
 * What every CLI browser handoff kind means, in one table.
 *
 * Every decision a kind makes is a field here, and adding a kind is an entry in
 * this table. Nothing outside this module may test a kind's text, so a seventh
 * kind is one entry rather than a search for every place the text is matched.
 *
 * Two families, told apart by `type` rather than by which optional fields an
 * entry happens to carry: the account claim, which settles an identity and is
 * completed by cf-auth, and the resource handoffs, each of which approves one
 * resource write under the handoff's transaction boundary.
 */
export type HandoffKind = ClaimHandoffKind | ResourceHandoffKind;

interface HandoffKindBase {
  /** Account access the initiator needs to open a handoff of this kind. */
  readonly open: AccountAccessMode;
  /** Account access the approving browser needs to view and submit it. */
  readonly view: AccountAccessMode;
  /** Where the person goes afterwards. */
  readonly continueTo: CliHandoffContinuation;
}

/**
 * The account claim: it takes an unowned account for the person approving it,
 * so it is the one kind that asks anything of whoever holds the browser, the
 * one that may register a sign-in, and the one that leaves its approver in the
 * console.
 */
export interface ClaimHandoffKind extends HandoffKindBase {
  readonly type: "claim";
}

/** A handoff that approves one resource write, and whose secret the browser supplies. */
export interface ResourceHandoffKind extends HandoffKindBase {
  readonly type: "resource";
  /**
   * The existing row the payload's `id` names, snapshotted at creation for the
   * approval page and pinned by revision; null for creates.
   */
  readonly target: HandoffTargetTable | null;
  /**
   * Whether a payload of this kind may name a provider gateway whose revision
   * must also be pinned.
   */
  readonly pinsGateway: boolean;
  /** What the browser must send as the secret. */
  readonly secret: "required" | "optional";
  /** The one service call approving this kind makes. */
  readonly write: HandoffWrite;
}

/** The two tables a handoff can be bound to an existing row in. */
export type HandoffTargetTable = "provider" | "provider_gateway";

/** The pinned row a targeted kind writes to: its id, and the revision reviewed. */
export interface HandoffTarget {
  id: string;
  revision: number;
}

/** What the browser approved, in the shape a write takes it. */
export interface HandoffSubmission {
  /** The reviewed payload, with every server-managed field removed. */
  payload: Record<string, unknown>;
  /** The secret the browser sent, already checked against the kind's rule. */
  secret: string | undefined;
  /** The row the handoff was bound to at creation, or null when it named none. */
  target: HandoffTarget | null;
}

export type HandoffWrite = (
  scope: ManagementScope,
  actor: Actor,
  submission: HandoffSubmission,
  boundary: ResourceWriteBoundary,
) => Promise<unknown>;

/**
 * How the row a targeted kind names is read when the handoff is created.
 *
 * The approval page is shown this, and its `revision` is what the submission
 * is pinned to, so the columns are the reviewable configuration and nothing
 * else: no sealed secret, and nothing a browser has no business seeing.
 */
export const TARGET_SNAPSHOTS: Record<HandoffTargetTable, string> = {
  provider:
    "SELECT id,type,name,slug,base_url AS baseUrl,provider_gateway_id AS providerGatewayId,gateway_route_json AS gatewayRoute,status,revision AS expectedRevision FROM provider WHERE id=? AND organization_id=?",
  provider_gateway:
    "SELECT id,type,name,config_json AS config,status,revision AS expectedRevision FROM provider_gateway WHERE id=? AND organization_id=?",
};

/**
 * The pinned row a targeted write operates on.
 *
 * The one place a missing binding is refused: a kind whose `target` is set was
 * created against a row that existed, so a stored payload that no longer names
 * one is a handoff that cannot be completed, not a write to guess at.
 */
function pinned(submission: HandoffSubmission): HandoffTarget {
  if (!submission.target)
    throw new GatewayError(409, "conflict", "The resource binding is missing");
  return submission.target;
}

/**
 * Both provider edits are one write: the reviewed payload carries whatever
 * changed and the pinned revision decides whether it may still land, so a
 * rotation is an update whose changed field happens to be the secret.
 */
const writeProviderUpdate: HandoffWrite = (scope, actor, submission, boundary) => {
  const target = pinned(submission);
  return updateProvider(
    scope,
    actor,
    target.id,
    { ...submission.payload, revision: target.revision, secret: submission.secret },
    boundary,
  );
};

/**
 * The claim's kind text, for the one query that has to name it in SQL: the
 * OAuth callback's check that a claim is still pending.
 */
export const CLAIM_KIND = "claim" satisfies CliOperationKind;

export const HANDOFF_KINDS: Record<CliOperationKind, HandoffKind> = {
  /**
   * Read access on both sides: an unclaimed account whose free window has
   * closed can still be claimed, and claiming is what reopens it.
   */
  [CLAIM_KIND]: {
    type: "claim",
    open: "read",
    view: "read",
    continueTo: "console",
  },
  "provider.add": {
    type: "resource",
    open: "setup",
    view: "read",
    target: null,
    pinsGateway: true,
    secret: "optional",
    continueTo: "cli",
    write: (scope, actor, { payload, secret }, boundary) =>
      createProvider(
        scope,
        actor,
        { ...payload, ...(secret === undefined ? {} : { secret }) },
        boundary,
      ),
  },
  "provider.update": {
    type: "resource",
    open: "setup",
    view: "read",
    target: "provider",
    pinsGateway: true,
    secret: "optional",
    continueTo: "cli",
    write: writeProviderUpdate,
  },
  "provider.rotate-key": {
    type: "resource",
    open: "setup",
    view: "read",
    target: "provider",
    pinsGateway: true,
    secret: "required",
    continueTo: "cli",
    write: writeProviderUpdate,
  },
  "provider-gateway.add": {
    type: "resource",
    open: "setup",
    view: "read",
    target: null,
    pinsGateway: false,
    secret: "required",
    continueTo: "cli",
    write: (scope, actor, { payload, secret }, boundary) =>
      createProviderGateway(scope, actor, { ...payload, token: secret }, boundary),
  },
  "provider-gateway.rotate-key": {
    type: "resource",
    open: "setup",
    view: "read",
    target: "provider_gateway",
    pinsGateway: false,
    secret: "required",
    continueTo: "cli",
    write: (scope, actor, submission, boundary) => {
      const target = pinned(submission);
      return rotateProviderGateway(
        scope,
        actor,
        target.id,
        { ...submission.payload, revision: target.revision, token: submission.secret },
        boundary,
      );
    },
  },
};

/**
 * The entry for a kind, whether it arrived in a request or out of a stored row.
 *
 * A stored kind this deployment no longer knows is refused rather than guessed
 * at, because every rule that would govern it — the secret it takes, the row it
 * is pinned to, who may approve it — lives in the entry.
 */
export function handoffKind(kind: string): HandoffKind {
  const entry = Object.hasOwn(HANDOFF_KINDS, kind)
    ? HANDOFF_KINDS[kind as CliOperationKind]
    : undefined;
  if (!entry)
    throw new GatewayError(400, "invalid_request", "Unsupported operation kind");
  return entry;
}

export type HandoffState = "pending" | "completed" | "expired";

/**
 * Where a handoff row stands, for the CLI that opened it.
 *
 * Consumption wins over the deadline: a handoff that was approved holds the
 * result of a write that landed, and a TTL that lapsed afterwards does not
 * unland it. Read in both the creating and the polling answer, so the two can
 * never describe the same row differently.
 */
export function handoffState(
  row: Pick<HandoffRow, "consumed_at" | "expires_at">,
  now = Date.now(),
): HandoffState {
  if (row.consumed_at) return "completed";
  return row.expires_at <= now ? "expired" : "pending";
}

/**
 * The statement that consumes a handoff, recording what it achieved.
 *
 * `onlyIfPreviousChanged` ties consumption to the statement before it in the
 * same batch: `changes()` is the previous statement's row count on the same
 * connection, and a D1 batch is one transaction on one connection, so the
 * handoff is consumed exactly when the resource write it authorized changed
 * exactly one row. A resource write that matched nothing leaves the handoff
 * pending and retryable, with no marker row and no deliberate error to make
 * that happen.
 */
export function consumeHandoffStatement(
  db: D1Database,
  row: Pick<HandoffRow, "id" | "kind">,
  outcome: Record<string, unknown>,
  now: number,
  options: { onlyIfPreviousChanged?: boolean } = {},
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE mgmt_handoff SET consumed_at=?,outcome=?,updated_at=?
       WHERE id=? AND kind=? AND consumed_at IS NULL AND expires_at>?${
         options.onlyIfPreviousChanged ? " AND changes()=1" : ""
       }`,
    )
    .bind(now, JSON.stringify(outcome), now, row.id, row.kind, now);
}
