import { assertAccountAccess } from "../../core/account-lifecycle";
import { credentialAuthorityCondition } from "@maxceem/cf-auth";
import { GatewayError } from "../../core/errors";
import { mgmtAuthTables } from "../../db/schema";
import { createProvider, updateProvider } from "../../management/providers";
import { createProviderGateway, rotateProviderGateway } from "../../management/provider-gateways";
import { databaseErrorMatches } from "../../management/validation";
import type { ResourceWriteBoundary } from "../../management/write-boundary";
import type { HandoffRow, CliContext } from "./types";
import { deploymentPolicy } from "../../policy/deployment";
import { accountAccessCondition } from "../../policy/sql";

export async function completeProviderSubmission(
  c: CliContext,
  row: HandoffRow,
  secret: unknown,
): Promise<void> {
  if (row.consumed_at && row.outcome) return;
  if (!row.organization_id || !row.initiating_user_id || !row.initiating_credential_id) {
    throw new GatewayError(403, "forbidden", "This operation has no management identity binding");
  }
  await assertAccountAccess(c.env, row.organization_id, "setup");
  const parsed = JSON.parse(row.request_json) as Record<string, unknown>;
  const {
    id,
    expectedRevision,
    snapshot: _snapshot,
    __requestHash: _requestHash,
    gatewaySnapshot,
    expectedGatewayRevision,
    ...payload
  } = parsed;
  const kind = row.kind;
  if (secret !== undefined && (typeof secret !== "string" || !secret.trim())) {
    throw new GatewayError(400, "invalid_request", "A nonempty credential is required");
  }
  if (kind === "provider.rotate-key" && typeof secret !== "string")
    throw new GatewayError(400, "invalid_request", "A provider credential is required");
  const actor = { organizationId: row.organization_id, userId: row.initiating_user_id };
  const now = Date.now();
  // Authority is rechecked in the mutation transaction, not merely when the
  // URL was issued. Product lifecycle conditions are appended below.
  const liveCredential = credentialAuthorityCondition(mgmtAuthTables, {
    organizationId: row.organization_id,
    userId: row.initiating_user_id,
    credentialId: row.initiating_credential_id,
    allowedRoles: ["owner", "admin"],
    nowMs: now,
  });
  const transition = crypto.randomUUID();
  const marker = JSON.stringify({ transition });
  const accountAccess = accountAccessCondition(
    deploymentPolicy(c.env),
    row.organization_id,
    "setup",
    now,
  );
  const conditions = [
    "EXISTS (SELECT 1 FROM mgmt_handoff WHERE id=? AND consumed_at=? AND outcome=?)",
    liveCredential.sql,
    accountAccess.sql,
  ];
  const parameters: unknown[] = [
    row.id,
    now,
    marker,
    ...liveCredential.params,
    ...accountAccess.params,
  ];
  if (typeof expectedGatewayRevision === "number") {
    const gatewayId = (gatewaySnapshot as { id?: unknown } | undefined)?.id;
    if (typeof gatewayId !== "string")
      throw new GatewayError(409, "conflict", "The gateway binding is missing");
    conditions.push(
      "EXISTS (SELECT 1 FROM provider_gateway WHERE id=? AND organization_id=? AND revision=?)",
    );
    parameters.push(gatewayId, row.organization_id, expectedGatewayRevision);
  }
  const boundary: ResourceWriteBoundary = {
    condition: { sql: conditions.join(" AND "), params: parameters },
    async commit(statement, outcome) {
      try {
        await c.env.DB.batch([
          c.env.DB.prepare(
            `UPDATE mgmt_handoff SET consumed_at=?,outcome=?,updated_at=?
            WHERE id=? AND kind=? AND organization_id=? AND initiating_user_id=? AND initiating_credential_id=?
            AND submission_proof_hash=? AND consumed_at IS NULL AND expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))`,
          ).bind(
            now,
            marker,
            now,
            row.id,
            row.kind,
            row.organization_id,
            row.initiating_user_id,
            row.initiating_credential_id,
            row.submission_proof_hash,
            now,
          ),
          statement,
          // A failed CAS must roll back consumption too, keeping the operation retryable.
          c.env.DB.prepare(
            "SELECT json(CASE WHEN changes()=1 THEN 'null' ELSE 'agw_resource_conflict' END)",
          ),
          c.env.DB.prepare(
            "UPDATE mgmt_handoff SET outcome=? WHERE id=? AND outcome=?",
          ).bind(JSON.stringify(outcome), row.id, marker),
        ]);
      } catch (error) {
        const completed = await c.env.DB.prepare(
          "SELECT consumed_at,outcome FROM mgmt_handoff WHERE id=?",
        )
          .bind(row.id)
          .first<{ consumed_at: number | null; outcome: string | null }>();
        if (completed?.consumed_at && completed.outcome && completed.outcome !== marker) return;
        if (databaseErrorMatches(error, /malformed JSON/iu)) {
          throw new GatewayError(
            409,
            "conflict",
            "The resource or its authorization changed; start a new submission",
          );
        }
        throw error;
      }
    },
  };
  try {
    if (kind === "provider.add") {
      await createProvider(
        c.env,
        actor,
        { ...payload, ...(secret === undefined ? {} : { secret }) },
        boundary,
      );
    } else if (kind === "provider.rotate-key" || kind === "provider.update") {
      if (typeof id !== "string" || typeof expectedRevision !== "number")
        throw new GatewayError(409, "conflict", "The provider binding is missing");
      await updateProvider(c.env, actor, id, { ...payload, revision: expectedRevision, secret }, boundary);
    } else if (kind === "provider-gateway.add") {
      await createProviderGateway(c.env, actor, { ...payload, token: secret }, boundary);
    } else if (kind === "provider-gateway.rotate-key") {
      if (typeof id !== "string" || typeof expectedRevision !== "number")
        throw new GatewayError(409, "conflict", "The gateway binding is missing");
      await rotateProviderGateway(
        c.env,
        actor,
        id,
        { ...payload, revision: expectedRevision, token: secret },
        boundary,
      );
    } else {
      throw new GatewayError(400, "invalid_request", "Unsupported provider submission purpose");
    }
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
