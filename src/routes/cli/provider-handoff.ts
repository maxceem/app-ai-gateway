import { assertAccountAccess } from "../../core/account-lifecycle";
import { actorFromHandoff } from "../../management/actor";
import { managementScope } from "../admin/body";
import { cfAuth } from "../../auth/identity";
import { GatewayError } from "../../core/errors";
import { mgmtAuthTables } from "../../db/schema";
import type { ResourceWriteBoundary } from "../../management/write-boundary";
import { consumeHandoffStatement, handoffKind, type HandoffSubmission } from "./handoff-kinds";
import type { HandoffRow, CliContext } from "./types";
import { accountAccessCondition } from "../../policy/sql";

export async function completeProviderSubmission(
  c: CliContext,
  row: HandoffRow,
  secret: unknown,
): Promise<void> {
  if (row.consumed_at && row.outcome) return;
  const kind = handoffKind(row.kind);
  if (kind.type !== "resource")
    throw new GatewayError(400, "invalid_request", "Unsupported provider submission purpose");
  // A row a Worker that predates the pin columns wrote, while migrations ran
  // ahead of its replacement: it pins nothing, so nothing it says is approvable.
  if (row.request_hash === null)
    throw new GatewayError(409, "conflict", "This request was opened by an earlier version; run the command again");
  const { write } = kind;
  const actor = actorFromHandoff(row);
  const scope = managementScope(c);
  await assertAccountAccess(scope.deployment, c.env, actor.organizationId, "setup");
  // The row a targeted kind edits is named by the pin, not by the payload, so
  // `id` and the revision the CLI read are dropped from what the write takes.
  const { id: _id, revision: _revision, ...payload } =
    JSON.parse(row.request_json) as Record<string, unknown>;
  if (secret !== undefined && (typeof secret !== "string" || !secret.trim())) {
    throw new GatewayError(400, "invalid_request", "A nonempty credential is required");
  }
  if (kind.secret === "required" && typeof secret !== "string")
    throw new GatewayError(400, "invalid_request", "A provider credential is required");
  const submission: HandoffSubmission = {
    payload,
    secret: typeof secret === "string" ? secret : undefined,
    target:
      row.target_id !== null && row.target_revision !== null
        ? { id: row.target_id, revision: row.target_revision }
        : null,
  };
  const now = Date.now();
  // Authority is rechecked in the mutation transaction, not merely when the
  // URL was issued. Product lifecycle conditions are appended below.
  const { credentialAuthorityCondition } = await cfAuth();
  const liveCredential = credentialAuthorityCondition(mgmtAuthTables, {
    organizationId: row.organization_id,
    userId: row.initiating_user_id,
    credentialId: row.initiating_credential_id,
    allowedRoles: ["owner", "admin"],
    nowMs: now,
  });
  const accountAccess = accountAccessCondition(
    scope.deployment.mode,
    row.organization_id,
    "setup",
    now,
  );
  // The resource write may only land while this handoff is still pending, and
  // the statement that consumes it lands only if the resource write did. The
  // clock is the later of the caller's and SQLite's, so a stale caller cannot
  // extend a deadline.
  const conditions = [
    `EXISTS (SELECT 1 FROM mgmt_handoff WHERE id=? AND kind=? AND organization_id=?
      AND initiating_user_id=? AND initiating_credential_id=? AND submission_proof_hash=?
      AND consumed_at IS NULL
      AND expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)))`,
    liveCredential.sql,
    accountAccess.sql,
  ];
  const parameters: unknown[] = [
    row.id,
    row.kind,
    row.organization_id,
    row.initiating_user_id,
    row.initiating_credential_id,
    row.submission_proof_hash,
    now,
    ...liveCredential.params,
    ...accountAccess.params,
  ];
  if (row.gateway_id !== null) {
    if (row.gateway_revision === null)
      throw new GatewayError(409, "conflict", "The gateway binding is missing");
    conditions.push(
      "EXISTS (SELECT 1 FROM provider_gateway WHERE id=? AND organization_id=? AND revision=?)",
    );
    parameters.push(row.gateway_id, row.organization_id, row.gateway_revision);
  }
  const boundary: ResourceWriteBoundary = {
    condition: { sql: conditions.join(" AND "), params: parameters },
    async commit(statement, outcome) {
      await c.env.DB.batch([
        ...(Array.isArray(statement) ? statement : [statement]),
        consumeHandoffStatement(c.env.DB, row, outcome, now, {
          onlyIfPreviousChanged: true,
        }),
      ]);
      const settled = await c.env.DB.prepare(
        "SELECT consumed_at,outcome FROM mgmt_handoff WHERE id=?",
      )
        .bind(row.id)
        .first<{ consumed_at: number | null; outcome: string | null }>();
      // Consumed with an outcome is the answer, whether this submission wrote
      // it or a concurrent twin did. Still pending means the resource write
      // matched no row — the authority was revoked, the revision moved, or a
      // cap refused it — and nothing was written, so a fresh request is the
      // only way forward.
      if (settled?.consumed_at && settled.outcome) return;
      throw new GatewayError(
        409,
        "conflict",
        "The resource or its authorization changed; start a new submission",
      );
    },
  };
  try {
    await write(scope, actor, submission, boundary);
  } catch (error) {
    const completed = await c.env.DB.prepare(
      "SELECT consumed_at,outcome FROM mgmt_handoff WHERE id=?",
    )
      .bind(row.id)
      .first<{ consumed_at: number | null; outcome: string | null }>();
    if (completed?.consumed_at && completed.outcome) return;
    throw error;
  }
}
