/**
 * The `mgmt_operation` table as the CLI routes see it: one parsed shape per
 * family, read in one place, and the statements that move a row between
 * states. The scheduled cleanup, which collects rows in bulk, keeps its own in
 * `core/account-lifecycle.ts`.
 */

import type { CliOperationKind } from "../../contracts/cli";
import { GatewayError } from "../../core/errors";
import type { Actor } from "../../management/actor";
import {
  knownKind,
  OPERATION_KINDS,
  type BootstrapKind,
  type ClaimKind,
  type ResourceKind,
} from "./operation-kinds";

/** One `mgmt_operation` row, as SQL returns it; see the table's own description. */
interface OperationColumns {
  id: string;
  kind: string;
  state: OperationState;
  organization_id: string | null;
  initiating_user_id: string | null;
  initiating_credential_id: string | null;
  request_json: string | null;
  request_hash: string;
  browser_proof_hash: string | null;
  outcome_json: string | null;
  sealed_outcome: string | null;
  sealed_until: number | null;
  credential_id: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

export type OperationState = "pending" | "completed" | "retired" | "expired";

/** Who sent an operation that needs a credential: the actor, holding that credential. */
export type OperationActor = Actor & { credentialId: string };

/** What a browser step owes: the digest of its proof, and the payload its approver reviews. */
export interface BrowserStep {
  proofHash: string;
  request: Record<string, unknown>;
}

/** A completed outcome's whole, sealed under the operation's id until `until`. */
export interface SealedOutcome {
  value: string;
  until: number;
}

interface OperationBase {
  id: string;
  kind: CliOperationKind;
  state: OperationState;
  requestHash: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  /** What the operation achieved, with any one-time secret removed. */
  outcome: string | null;
  sealed: SealedOutcome | null;
}

/**
 * One operation, told apart by its kind's family. A bootstrap names the
 * account it created and, once one is sealed, the key it stands behind, until
 * cleanup collects that account and leaves only its tombstone; a claim always owes a
 * browser step; a resource write owes one or runs at once. Both of the latter
 * were sent by a credential, which the actor carries.
 */
export type Operation =
  | (OperationBase & { family: "bootstrap"; entry: BootstrapKind; state: "expired" })
  | (OperationBase & {
      family: "bootstrap";
      entry: BootstrapKind;
      state: "completed" | "retired";
      organizationId: string;
      initiatingUserId: string;
      credentialId: string | null;
    })
  | (OperationBase & { family: "claim"; entry: ClaimKind; actor: OperationActor; browser: BrowserStep })
  | (OperationBase & { family: "resource"; entry: ResourceKind; actor: OperationActor; browser: BrowserStep | null });

export type BootstrapOperation = Extract<Operation, { family: "bootstrap" }>;
export type ClaimOperation = Extract<Operation, { family: "claim" }>;
export type ResourceOperation = Extract<Operation, { family: "resource" }>;
/** Every operation a credential sent, which is every one but a bootstrap. */
export type ActorOperation = ClaimOperation | ResourceOperation;

/**
 * A stored row that breaks its family's rules. Every write to the table
 * states those rules, and the nightly cleanup is the only path that deletes an
 * account — expiring its bootstraps and deleting its other operations first, so
 * the foreign key's `ON DELETE set null` never fires — so a row that fails them
 * means the deployment has moved under its own data.
 */
function malformed(): GatewayError {
  return new GatewayError(500, "internal_error", "A stored operation does not match its kind");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationActor(raw: OperationColumns): OperationActor | null {
  const { organization_id: organizationId, initiating_user_id: userId, initiating_credential_id: credentialId } = raw;
  return organizationId && userId && credentialId ? { organizationId, userId, credentialId } : null;
}

function browserStep(raw: OperationColumns): BrowserStep | null {
  if (raw.browser_proof_hash === null) return null;
  let request: unknown;
  try {
    request = raw.request_json === null ? null : JSON.parse(raw.request_json);
  } catch {
    throw malformed();
  }
  if (!isRecord(request)) throw malformed();
  return { proofHash: raw.browser_proof_hash, request };
}

function parseOperation(raw: OperationColumns): Operation {
  const kind = knownKind(raw.kind);
  const base = {
    id: raw.id,
    kind,
    requestHash: raw.request_hash,
    expiresAt: raw.expires_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    outcome: raw.outcome_json,
    sealed: raw.sealed_outcome !== null && raw.sealed_until !== null
      ? { value: raw.sealed_outcome, until: raw.sealed_until }
      : null,
  };
  const entry = OPERATION_KINDS[kind];
  switch (entry.type) {
    case "bootstrap": {
      // Cleanup clears the identities along with the account; the tombstone
      // keeps nothing but the id.
      if (raw.state === "expired") return { ...base, family: "bootstrap", entry, state: raw.state };
      if ((raw.state === "completed" || raw.state === "retired") && raw.organization_id && raw.initiating_user_id) {
        return {
          ...base,
          family: "bootstrap",
          entry,
          state: raw.state,
          organizationId: raw.organization_id,
          initiatingUserId: raw.initiating_user_id,
          credentialId: raw.credential_id,
        };
      }
      break;
    }
    case "claim": {
      const actor = operationActor(raw);
      const browser = browserStep(raw);
      if (actor && browser) return { ...base, family: "claim", entry, state: raw.state, actor, browser };
      break;
    }
    case "resource": {
      const actor = operationActor(raw);
      if (actor) return { ...base, family: "resource", entry, state: raw.state, actor, browser: browserStep(raw) };
      break;
    }
  }
  throw malformed();
}

/** The operation stored under `id`, parsed once for everything that reads it. */
export async function operationRow(db: D1Database, id: string): Promise<Operation | null> {
  const raw = await db.prepare("SELECT * FROM mgmt_operation WHERE id=?").bind(id).first<OperationColumns>();
  return raw ? parseOperation(raw) : null;
}

/**
 * The statement that completes a pending operation, recording what it achieved.
 *
 * `onlyIfPreviousChanged` ties completion to the statement before it in the
 * same batch: `changes()` is the previous statement's row count on the same
 * connection, and a D1 batch is one transaction on one connection, so the
 * operation completes exactly when the write it authorized changed exactly one
 * row. A write that matched nothing leaves the operation pending and
 * retryable.
 */
export function completeStatement(
  db: D1Database,
  row: { id: string },
  stored: { outcome: string; sealed: string | null; sealedUntil: number | null },
  now: number,
  options: { onlyIfPreviousChanged?: boolean } = {},
): D1PreparedStatement {
  return db.prepare(
    `UPDATE mgmt_operation
     SET state='completed',outcome_json=?,sealed_outcome=?,sealed_until=?,updated_at=?
     WHERE id=? AND state='pending'${options.onlyIfPreviousChanged ? " AND changes()=1" : ""}`,
  ).bind(stored.outcome, stored.sealed, stored.sealedUntil, now, row.id);
}

/**
 * The statement that ends an account's bootstrap authority once a claim has
 * settled it: the sealed credential the CLI could otherwise collect goes with
 * it.
 */
export function retireBootstrapsStatement(
  db: D1Database,
  organizationId: string,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `UPDATE mgmt_operation SET state='retired',sealed_outcome=NULL,sealed_until=NULL,updated_at=?
     WHERE kind='bootstrap' AND organization_id=? AND state='completed'`,
  ).bind(now, organizationId);
}
