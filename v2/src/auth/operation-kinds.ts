/**
 * The operation kinds this gateway registers with cf-auth's operation engine
 * (v1's `src/auth/operation-kinds.ts`, cut to what v2 has).
 *
 * cf-auth owns the `mgmt_operation` table and every state a row moves through,
 * and the guards that make opening, approving, executing and revealing each
 * one write. This module only tells the engine which kinds exist. What each
 * write does is `../admin/handoffs.ts`.
 *
 * Two families:
 *
 * - **Browser steps** (`provider.add.browser`, `provider.rotate-key.browser`):
 *   an agent opens one with what can be reviewed, and a person enters the key
 *   on the console page the link opens. The link is the whole authority
 *   (`approver: "proof"`), and the write runs as the credential that opened
 *   it, which the engine rechecks when it commits. The key is the approval's
 *   `input`, which the engine never stores.
 * - **Reserved creates** (`app.add.reserved`, `app.key.add.reserved`): one call
 *   reserves, a second executes it once, and a repeat answers what the first
 *   did. A key one creates reaches nobody but a person on the reveal page.
 *
 * Imports nothing at run time but drizzle's `sql`, which the database layer
 * has loaded already.
 */
import { sql } from "drizzle-orm";
import type { CfAuth, OperationApproveResult, OperationKind } from "@maxceem/cf-auth";

/** The writes whose key a person enters in a browser. */
export const BROWSER_KINDS = ["provider.add", "provider.rotate-key"] as const;
export type BrowserKind = (typeof BROWSER_KINDS)[number];

/** The creates an agent makes under a reservation. */
export const RESERVED_KINDS = ["app.add", "app.key.add"] as const;
export type ReservedKind = (typeof RESERVED_KINDS)[number];

const BROWSER_SUFFIX = ".browser";
const RESERVED_SUFFIX = ".reserved";

/** The engine's name for a browser step. */
export const browserKindName = (kind: BrowserKind): string => `${kind}${BROWSER_SUFFIX}`;
/** The engine's name for a reserved create. */
export const reservedKindName = (kind: ReservedKind): string => `${kind}${RESERVED_SUFFIX}`;

/** The browser step an engine kind names, or null. */
export function browserKindOf(engineKind: string): BrowserKind | null {
  const kind = engineKind.endsWith(BROWSER_SUFFIX) ? engineKind.slice(0, -BROWSER_SUFFIX.length) : null;
  return (BROWSER_KINDS as readonly string[]).includes(kind ?? "") ? (kind as BrowserKind) : null;
}

/** Whether an engine kind is a reserved create, whose key only a person may reveal. */
export function isReservedKindName(engineKind: string): boolean {
  return RESERVED_KINDS.some((kind) => reservedKindName(kind) === engineKind);
}

/** How long an operation's record is kept, so a repeat or a status read still finds it. */
export const OPERATION_RECORD_TTL_MS = 90 * 86_400_000;

/** How many operations may wait at once, per account and per opener (v1's numbers). */
export const OPERATION_LIMITS = { pendingPerOrganization: 10, pendingPerOpener: 10 } as const;

/**
 * What an operation stores as its payload. `requestHash` binds a repeat to the
 * same request, since the request itself may not be stored. A browser step
 * also stores what its approver reviews, never its key. The write runs as the
 * operation's opener, which the engine records itself.
 */
export interface OperationEnvelope {
  requestHash: string;
  review?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HEX_DIGEST = /^[0-9a-f]{64}$/u;

/** A stored or sent envelope, or a refusal. */
export function parseEnvelope(value: unknown): OperationEnvelope {
  if (!isRecord(value) || typeof value.requestHash !== "string" || !HEX_DIGEST.test(value.requestHash)) {
    throw new Error("An operation's payload must carry its request digest");
  }
  const { requestHash, review } = value;
  if (review !== undefined && !isRecord(review)) throw new Error("A reviewed payload must be an object");
  return { requestHash, ...(review === undefined ? {} : { review }) };
}

/** The longest key a person may enter on the page, as `createProvider` takes it. */
export const MAX_SECRET_LENGTH = 4096;

/** What the approval page submits: the key it collected. Never stored. */
function parseSecretInput(value: unknown): { secret: string } {
  if (!isRecord(value) || typeof value.secret !== "string" || !/\S/u.test(value.secret) || value.secret.length > MAX_SECRET_LENGTH) {
    throw new Error("A browser step's input must be a non-blank key");
  }
  return { secret: value.secret };
}

/**
 * The write a browser step's approval commits, staged by the gateway just
 * before it asks the engine to approve, per cf-auth instance (one per
 * request). The kind's `approve` hands it back, and the engine commits its
 * statements in the batch that completes the operation.
 */
const staged = new WeakMap<CfAuth, Map<string, OperationApproveResult>>();

export function stageApproval(identity: CfAuth, id: string, approval: OperationApproveResult): () => void {
  let byId = staged.get(identity);
  if (byId === undefined) staged.set(identity, (byId = new Map()));
  byId.set(id, approval);
  return () => byId.delete(id);
}

function stagedApproval(identity: CfAuth, id: string): OperationApproveResult {
  const approval = staged.get(identity)?.get(id);
  if (approval === undefined) throw new Error("A browser step is approved only with the write the gateway staged for it");
  staged.get(identity)!.delete(id);
  return approval;
}

/**
 * Every kind this gateway registers. `identity` is the instance being built,
 * read lazily: a browser step's approval is the write staged on it.
 */
export function gatewayOperationKinds(identity: () => CfAuth): OperationKind[] {
  const browser = BROWSER_KINDS.map((kind): OperationKind => ({
    name: browserKindName(kind),
    payload: parseEnvelope,
    // What the page shows: what the opener asked for, never who sent it.
    showPayload: (payload: OperationEnvelope | null) => payload?.review ?? {},
    input: parseSecretInput,
    open: { minRole: "admin" },
    browser: true,
    // The link is the whole authority: the step only collects the key, and the
    // write runs as the credential that opened it.
    approver: "proof",
    recordTtlMs: OPERATION_RECORD_TTL_MS,
    approve: ({ operation }) => stagedApproval(identity(), operation.id),
  }));
  const reserved = RESERVED_KINDS.map((kind): OperationKind => ({
    name: reservedKindName(kind),
    payload: parseEnvelope,
    open: { minRole: "admin" },
    browser: false,
    // The key it minted reaches nobody but a person on the reveal page: not the
    // agent that executed it, and not whoever holds the handle.
    deliver: "reveal",
    recordTtlMs: OPERATION_RECORD_TTL_MS,
    // A key revoked before anyone revealed it is not revealed: it would be a
    // key that no longer works, shown as though it did. An outcome with no
    // key is refused before the engine is asked (`revealOperation`).
    deliverable: ({ record }) => {
      const keyId = (record as { api_key?: { id?: unknown } | null } | null)?.api_key?.id;
      return typeof keyId === "string" ? sql`exists (select 1 from app_key where id = ${keyId} and status = 'active')` : undefined;
    },
  }));
  return [...browser, ...reserved];
}
