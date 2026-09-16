import { assertAccountAccess } from "../../core/account-lifecycle";
import { GatewayError } from "../../core/errors";
import type { ProviderWriteBoundary } from "../../core/provider-writes";
import { createProvider, updateProvider } from "../admin/providers";
import { createProviderGateway, rotateProviderGateway } from "../admin/provider-gateways";
import { databaseErrorMatches } from "../admin/provider-shared";
import type { HandoffRow, CliContext } from "./types";

/** Authority is rechecked in the mutation transaction, not merely when the URL was issued. */
const liveCredential = `EXISTS (
  SELECT 1 FROM mgmt_organization_user m JOIN mgmt_user u ON u.id=m.user_id
  WHERE m.organization_id=? AND m.user_id=? AND m.status='active' AND m.role IN ('owner','admin')
  AND (
    EXISTS (SELECT 1 FROM mgmt_api_key k WHERE k.id=? AND k.user_id=u.id AND k.organization_id=m.organization_id
      AND k.enabled=1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)))
    )
    OR (u.kind='human' AND EXISTS (SELECT 1 FROM mgmt_user_session s WHERE s.id=? AND s.user_id=u.id AND s.expires_at>MAX(?,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))))
  )
)`;

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
    expectedUpdatedAt,
    snapshot: _snapshot,
    __requestHash: _requestHash,
    gatewaySnapshot,
    expectedGatewayUpdatedAt,
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
  const transition = crypto.randomUUID();
  const marker = JSON.stringify({ transition });
  const conditions = [
    "EXISTS (SELECT 1 FROM mgmt_handoff WHERE id=? AND consumed_at=? AND outcome=?)",
    liveCredential,
    `EXISTS (SELECT 1 FROM mgmt_organization o WHERE id=? AND (
      EXISTS (SELECT 1 FROM mgmt_organization_user m JOIN mgmt_user u ON u.id=m.user_id
        WHERE m.organization_id=o.id AND m.role='owner' AND u.kind='human')
      OR expires_at IS NULL OR expires_at>MAX(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))))`,
  ];
  const parameters: unknown[] = [
    row.id,
    now,
    marker,
    row.organization_id,
    row.initiating_user_id,
    row.initiating_credential_id,
    now,
    row.initiating_credential_id,
    now,
    row.organization_id,
    new Date(now).toISOString(),
  ];
  if (c.env.BILLING)
    conditions.push(
      `EXISTS (SELECT 1 FROM mgmt_organization o WHERE id=? AND (
        EXISTS (SELECT 1 FROM mgmt_organization_user m JOIN mgmt_user u ON u.id=m.user_id
          WHERE m.organization_id=o.id AND m.role='owner' AND u.kind='human')
        OR expires_at IS NULL OR julianday(created_at)+30>julianday('now')))`,
    );
  if (c.env.BILLING) parameters.push(row.organization_id);
  if (typeof expectedGatewayUpdatedAt === "string") {
    const gatewayId = (gatewaySnapshot as { id?: unknown } | undefined)?.id;
    if (typeof gatewayId !== "string")
      throw new GatewayError(409, "conflict", "The gateway binding is missing");
    conditions.push(
      "EXISTS (SELECT 1 FROM provider_gateway WHERE id=? AND organization_id=? AND updated_at=?)",
    );
    parameters.push(gatewayId, row.organization_id, expectedGatewayUpdatedAt);
  }
  const boundary: ProviderWriteBoundary = {
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
      if (typeof id !== "string" || typeof expectedUpdatedAt !== "string")
        throw new GatewayError(409, "conflict", "The provider binding is missing");
      await updateProvider(c.env, actor, id, { ...payload, secret }, boundary, expectedUpdatedAt);
    } else if (kind === "provider-gateway.add") {
      await createProviderGateway(c.env, actor, { ...payload, token: secret }, boundary);
    } else if (kind === "provider-gateway.rotate-key") {
      if (typeof id !== "string" || typeof expectedUpdatedAt !== "string")
        throw new GatewayError(409, "conflict", "The gateway binding is missing");
      await rotateProviderGateway(
        c.env,
        actor,
        id,
        { ...payload, token: secret },
        boundary,
        expectedUpdatedAt,
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
