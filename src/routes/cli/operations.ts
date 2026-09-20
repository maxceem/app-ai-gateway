import { cliJson } from "./security";
import { requireOrganization } from "@maxceem/cf-auth";
import { createIdentityAuth } from "../../auth/identity";
import {
  assertAccountAccess,
  accountLifecycle,
} from "../../core/account-lifecycle";
import { GatewayError } from "../../core/errors";
import { enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { CliOperationRequestSchema } from "../../contracts/cli";
import { schemaBody } from "../../management/validation";
import { deployment } from "./bootstrap";
import {
  derive,
  digest,
  proofMatches,
  TTL,
} from "./security";
import type { HandoffRow, CliContext, CliEnv } from "./types";

/**
 * Where a human finishes a handoff: a console route, not a Worker-rendered
 * page. The proof is appended as a fragment by the only caller that has one,
 * because a fragment never reaches the server, a log or the browser's history.
 */
export function browserPath(id: string): string {
  return `/cli/approve/${encodeURIComponent(id)}`;
}

export async function authState(c: CliContext, interactive = false) {
  const auth = createIdentityAuth(c.env, c.req.url, {
    suppressDefaultOrganization: true,
  });
  await auth.middleware<CliEnv>({
    apiKeys: !interactive,
    syncCurrentOrganizationCookie: false,
  })(c, async () => {});
  return c.get("authState");
}
export async function challenge(c: CliContext): Promise<HandoffRow> {
  const row = await c.env.DB.prepare(
    "SELECT * FROM mgmt_handoff WHERE id=?",
  )
    .bind(c.req.param("id"))
    .first<HandoffRow>();
  if (!row) throw new GatewayError(404, "not_found", "Operation was not found");
  return row;
}
function nonSecretPayload(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) nonSecretPayload(item);
    return;
  }
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (/secret|password|token|api.?key/i.test(key))
        throw new GatewayError(
          400,
          "invalid_request",
          "Secrets must be submitted in the browser form",
        );
      nonSecretPayload(item);
    }
}
export async function createOperation(c: CliContext): Promise<Response> {
  const input = schemaBody(
    CliOperationRequestSchema,
    await cliJson(c.req.raw),
  );
  nonSecretPayload(input.payload);
  for (const field of ["__requestHash", "expectedRevision", "expectedGatewayRevision", "snapshot", "gatewaySnapshot"]) {
    if (Object.hasOwn(input.payload, field)) {
      throw new GatewayError(400, "invalid_request", `${field} is managed by the server`);
    }
  }
  if (
    input.payload.revision !== undefined &&
    (!Number.isInteger(input.payload.revision) || (input.payload.revision as number) <= 0)
  ) {
    throw new GatewayError(400, "invalid_request", "revision must be a positive integer");
  }
  const meta = deployment(c);
  const state = await authState(c);
  const resolved = requireOrganization(state);
    if (
      state.credentialType === "session" &&
      c.req.header("origin") !== meta.consoleOrigin
    )
      throw new GatewayError(
        403,
        "forbidden",
        "Use the first-party console for browser operations",
      );
    if (
      !state.actor ||
      (resolved.role !== "owner" && resolved.role !== "admin")
    )
      throw new GatewayError(
        403,
        "forbidden",
        "Account administration is required",
      );
    const organizationId = resolved.organization.id;
    const userId = state.actor.id;
    const credentialId = state.actor.credentialId;
    const account = await assertAccountAccess(
      c.env,
      organizationId,
      input.kind === "claim" ? "claim" : "setup",
    );
    if (input.kind === "claim" && account.claimed)
      throw new GatewayError(409, "conflict", "Account is already claimed");
  const pollHash = await digest(input.pollToken),
    id = `cli-operation:${pollHash}`;
  const requestHash = await digest(JSON.stringify(input.payload));
  let value = JSON.stringify({ ...input.payload, __requestHash: requestHash });
  let row = await c.env.DB.prepare(
    "SELECT * FROM mgmt_handoff WHERE id=?",
  )
    .bind(id)
    .first<HandoffRow>();
  if (
    row &&
    (row.kind !== input.kind ||
      row.organization_id !== organizationId ||
      row.initiating_user_id !== userId ||
      JSON.parse(row.request_json).__requestHash !== requestHash)
  )
    throw new GatewayError(
      409,
      "conflict",
      "Operation proof is already bound to a different request",
    );
  const submissionToken = await derive(input.pollToken, `browser:${meta.id}`);
  if (!row) {
    if (
      input.kind !== "claim" &&
      !input.kind.endsWith(".add")
    ) {
      if (typeof input.payload.id !== "string")
        throw new GatewayError(
          400,
          "invalid_request",
          "Resource ID is required",
        );
      const gateway = input.kind.startsWith("provider-gateway.");
      const snapshot = await c.env.DB.prepare(
        gateway
          ? "SELECT id,type,name,config_json AS config,status,revision AS expectedRevision FROM provider_gateway WHERE id=? AND organization_id=?"
          : "SELECT id,type,name,slug,base_url AS baseUrl,provider_gateway_id AS providerGatewayId,gateway_route_json AS gatewayRoute,status,revision AS expectedRevision FROM provider WHERE id=? AND organization_id=?",
      )
        .bind(input.payload.id, organizationId)
        .first<Record<string, unknown>>();
      if (!snapshot)
        throw new GatewayError(
          404,
          "not_found",
          "Resource was not found in this account",
        );
      if (
        input.payload.revision !== undefined &&
        input.payload.revision !== snapshot.expectedRevision
      ) {
        throw new GatewayError(409, "conflict", "The resource changed; fetch it and retry");
      }
      value = JSON.stringify({
        ...input.payload,
        revision: snapshot.expectedRevision,
        expectedRevision: snapshot.expectedRevision,
        snapshot,
        __requestHash: requestHash,
      });
    }
    if (input.kind.startsWith("provider.")) {
      const captured = JSON.parse(value) as Record<string, unknown>;
      const snapshot = captured.snapshot as Record<string, unknown> | undefined;
      const gatewayId = Object.hasOwn(input.payload, "providerGatewayId")
        ? input.payload.providerGatewayId
        : snapshot?.providerGatewayId;
      if (typeof gatewayId === "string") {
        const gatewaySnapshot = await c.env.DB.prepare(
          "SELECT id,type,name,config_json AS config,status,revision AS expectedRevision FROM provider_gateway WHERE id=? AND organization_id=?",
        )
          .bind(gatewayId, organizationId)
          .first<Record<string, unknown>>();
        if (!gatewaySnapshot)
          throw new GatewayError(
            404,
            "not_found",
            "Provider gateway was not found in this account",
          );
        value = JSON.stringify({
          ...captured,
          gatewaySnapshot,
          expectedGatewayRevision: gatewaySnapshot.expectedRevision,
        });
      }
    }
    await enforceEndpointRateLimit(c.env, "operation", organizationId);
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_handoff(id,kind,request_json,organization_id,initiating_user_id,initiating_credential_id,submission_proof_hash,poll_proof_hash,expires_at,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM mgmt_handoff WHERE organization_id = ? AND consumed_at IS NULL AND expires_at>?) < 10`,
    )
      .bind(
        id,
        input.kind,
        value,
        organizationId,
        userId,
        credentialId,
        await digest(submissionToken),
        pollHash,
        now + TTL,
        now,
        now,
        organizationId,
        now,
      )
      .run();
    row = await c.env.DB.prepare(
      "SELECT * FROM mgmt_handoff WHERE id=?",
    )
      .bind(id)
      .first<HandoffRow>();
    if (!row)
      throw new GatewayError(
        429,
        "rate_limited",
        "Too many pending operations",
      );
  }
  return c.json({
    id,
    url: `${meta.consoleOrigin}${browserPath(id)}#${submissionToken}`,
    expiresAt: new Date(row.expires_at).toISOString(),
    state: row.consumed_at
      ? "completed"
      : row.expires_at <= Date.now()
        ? "expired"
        : "pending",
    deployment: meta,
  });
}
export async function pollOperation(c: CliContext): Promise<Response> {
  const row = await challenge(c);
  const token = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (!(await proofMatches(token, row.poll_proof_hash)))
    throw new GatewayError(403, "forbidden", "Invalid polling proof");
  const base = {
    id: row.id,
    deployment: deployment(c),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
  if (row.expires_at <= Date.now())
    return c.json({ ...base, state: "expired" });
  if (!row.consumed_at) return c.json({ ...base, state: "pending" });
  const result = row.outcome ? JSON.parse(row.outcome) : {};
  const accountId = result.accountId ?? row.organization_id;
  const account = accountId ? await accountLifecycle(c.env, accountId) : null;
  return c.json({
    ...base,
    state: "completed",
    result,
    account,
  });
}
