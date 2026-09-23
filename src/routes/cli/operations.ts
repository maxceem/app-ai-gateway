import { cliJson } from "./security";
import { cfAuth, identityAuthFor } from "../../auth/identity";
import {
  assertAccountAccess,
  accountLifecycle,
} from "../../core/account-lifecycle";
import { GatewayError } from "../../core/errors";
import { enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { CliOperationRequestSchema } from "../../contracts/cli";
import type {
  CliOperationResponse,
  CliOperationResult,
  CliPollResponse,
} from "../../contracts/cli";
import { schemaBody } from "../../management/validation";
import { deploymentMeta } from "./bootstrap";
import {
  handoffKind,
  handoffState,
  TARGET_SNAPSHOTS,
  type ResourceHandoffKind,
} from "./handoff-kinds";
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
  const auth = await identityAuthFor(c, { suppressDefaultOrganization: true });
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
/** The rows a resource handoff was pinned to when it was opened, and what the approver is shown of them. */
interface HandoffPins {
  targetId: string | null;
  targetRevision: number | null;
  gatewayId: string | null;
  gatewayRevision: number | null;
  /** `{ target?, gateway? }` as the approval page shows them, or null when nothing is pinned. */
  snapshot: { target?: Record<string, unknown>; gateway?: Record<string, unknown> } | null;
}

const NO_PINS: HandoffPins = {
  targetId: null,
  targetRevision: null,
  gatewayId: null,
  gatewayRevision: null,
  snapshot: null,
};

/** A snapshot row split into what the page shows and the revision the write is pinned to. */
function pinnedSnapshot(row: Record<string, unknown>): { shown: Record<string, unknown>; revision: number } {
  const { expectedRevision, ...shown } = row;
  if (typeof expectedRevision !== "number")
    throw new GatewayError(500, "internal_error", "A pinned row has no revision");
  return { shown, revision: expectedRevision };
}

/**
 * Reads and pins the rows a resource handoff names: the row a targeted kind
 * edits, and the provider gateway a provider will route through. Each is
 * snapshotted for the approval page and pinned by revision, so what is
 * approved is what is written or nothing is.
 */
async function pinRows(
  db: D1Database,
  kind: ResourceHandoffKind,
  payload: Record<string, unknown>,
  organizationId: string,
): Promise<HandoffPins> {
  const pins: HandoffPins = { ...NO_PINS, snapshot: {} };
  let target: Record<string, unknown> | undefined;
  if (kind.target !== null) {
    if (typeof payload.id !== "string")
      throw new GatewayError(400, "invalid_request", "Resource ID is required");
    const row = await db.prepare(TARGET_SNAPSHOTS[kind.target])
      .bind(payload.id, organizationId)
      .first<Record<string, unknown>>();
    if (!row)
      throw new GatewayError(404, "not_found", "Resource was not found in this account");
    const pinned = pinnedSnapshot(row);
    if (payload.revision !== undefined && payload.revision !== pinned.revision)
      throw new GatewayError(409, "conflict", "The resource changed; fetch it and retry");
    target = pinned.shown;
    pins.targetId = payload.id;
    pins.targetRevision = pinned.revision;
    pins.snapshot = { target };
  }
  if (kind.pinsGateway) {
    const gatewayId = Object.hasOwn(payload, "providerGatewayId")
      ? payload.providerGatewayId
      : target?.providerGatewayId;
    if (typeof gatewayId === "string") {
      const row = await db.prepare(TARGET_SNAPSHOTS.provider_gateway)
        .bind(gatewayId, organizationId)
        .first<Record<string, unknown>>();
      if (!row)
        throw new GatewayError(404, "not_found", "Provider gateway was not found in this account");
      const pinned = pinnedSnapshot(row);
      pins.gatewayId = gatewayId;
      pins.gatewayRevision = pinned.revision;
      pins.snapshot = { ...pins.snapshot, gateway: pinned.shown };
    }
  }
  return pins.targetId === null && pins.gatewayId === null ? NO_PINS : pins;
}

export async function createOperation(c: CliContext): Promise<CliOperationResponse> {
  // Each kind's payload has its own strict schema, which takes no secret and
  // no server-managed field: those are refused here, before the handoff exists.
  const input = schemaBody(
    CliOperationRequestSchema,
    await cliJson(c.req.raw),
  );
  const meta = deploymentMeta(c);
  const kind = handoffKind(input.kind);
  const state = await authState(c);
  const resolved = (await cfAuth()).requireOrganization(state);
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
    c.get("deployment"),
    c.env,
    organizationId,
    kind.open,
  );
  // The claim takes an unowned account, so an owner already makes it pointless.
  if (kind.type === "claim" && account.claimed)
    throw new GatewayError(409, "conflict", "Account is already claimed");
  const pollHash = await digest(input.pollToken),
    id = `cli-operation:${pollHash}`;
  const payload: Record<string, unknown> = input.payload;
  const requestJson = JSON.stringify(payload);
  const requestHash = await digest(requestJson);
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
      row.request_hash !== requestHash)
  )
    throw new GatewayError(
      409,
      "conflict",
      "Operation proof is already bound to a different request",
    );
  const submissionToken = await derive(input.pollToken, `browser:${meta.id}`);
  if (!row) {
    const pins = kind.type === "resource"
      ? await pinRows(c.env.DB, kind, payload, organizationId)
      : NO_PINS;
    await enforceEndpointRateLimit(c.env, "operation", organizationId);
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_handoff(id,kind,request_json,request_hash,target_id,target_revision,gateway_id,gateway_revision,snapshot_json,organization_id,initiating_user_id,initiating_credential_id,submission_proof_hash,poll_proof_hash,expires_at,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM mgmt_handoff WHERE organization_id = ? AND consumed_at IS NULL AND expires_at>?) < 10`,
    )
      .bind(
        id,
        input.kind,
        requestJson,
        requestHash,
        pins.targetId,
        pins.targetRevision,
        pins.gatewayId,
        pins.gatewayRevision,
        pins.snapshot === null ? null : JSON.stringify(pins.snapshot),
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
  return {
    id,
    url: `${meta.consoleOrigin}${browserPath(id)}#${submissionToken}`,
    expiresAt: new Date(row.expires_at).toISOString(),
    state: handoffState(row),
    deployment: meta,
  };
}
export async function pollOperation(c: CliContext): Promise<CliPollResponse> {
  const row = await challenge(c);
  const token = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (!(await proofMatches(token, row.poll_proof_hash)))
    throw new GatewayError(403, "forbidden", "Invalid polling proof");
  const base = {
    id: row.id,
    deployment: deploymentMeta(c),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
  const state = handoffState(row);
  if (state !== "completed") return { ...base, state };
  const result = (row.outcome ? JSON.parse(row.outcome) : {}) as CliOperationResult & {
    accountId?: string;
  };
  const accountId = result.accountId ?? row.organization_id;
  const account = accountId ? await accountLifecycle(c.env, accountId) : null;
  return {
    ...base,
    state: "completed",
    result,
    account,
  };
}
