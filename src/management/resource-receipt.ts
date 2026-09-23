import { openSecret, sealSecret } from "../vault/secrets";
import { hashApiKey } from "../core/apikeys";
import { GatewayError } from "../core/errors";
import type { Actor } from "./actor";
import type { ResourceWriteBoundary } from "./write-boundary";

const PROOF = /^[A-Za-z0-9_-]{32,256}$/;
export const RESOURCE_RECEIPT_SECRET_TTL = 15 * 60_000;
const RECEIPT_TTL = 90 * 24 * 60 * 60_000;

interface ReceiptRow {
  id: string;
  request_hash: string;
  kind: string;
  organization_id: string | null;
  initiating_user_id: string | null;
  proof_hash: string;
  outcome: string | null;
  protected_credential: string | null;
  protected_credential_expires_at: number | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function recovery(outcome: Record<string, unknown>): Record<string, string> {
  const app = outcome.app as { id?: string } | undefined;
  const key = outcome.api_key as { id?: string } | null | undefined;
  const provider = outcome.provider as { id?: string } | undefined;
  const gateway = outcome.gateway as { id?: string } | undefined;
  return {
    ...(app?.id ? { appId: app.id } : {}),
    ...(key?.id ? { keyId: key.id } : {}),
    ...(typeof outcome.id === "string" ? { keyId: outcome.id } : {}),
    ...(provider?.id ? { providerId: provider.id } : {}),
    ...(gateway?.id ? { providerGatewayId: gateway.id } : {}),
  };
}

export class ResourceReceipt implements ResourceWriteBoundary {
  readonly condition: { sql: string; params: unknown[] };
  result: Record<string, unknown> | undefined;

  constructor(
    private readonly env: Env,
    readonly id: string,
    private readonly purpose: string,
    private readonly accountId: string,
    private readonly userId: string,
    private readonly credentialId: string | null,
    private readonly proofHash: string,
    private readonly requestHash: string,
  ) {
    this.condition = {
      sql: "NOT EXISTS (SELECT 1 FROM mgmt_resource_receipt WHERE id = ?)",
      params: [id],
    };
  }

  async read(): Promise<Record<string, unknown> | undefined> {
    const row = await this.env.DB.prepare("SELECT * FROM mgmt_resource_receipt WHERE id = ?")
      .bind(this.id)
      .first<ReceiptRow>();
    if (!row) return undefined;
    if (
      row.kind !== this.purpose || row.organization_id !== this.accountId ||
      row.initiating_user_id !== this.userId || row.proof_hash !== this.proofHash
    ) {
      throw new GatewayError(403, "forbidden", "The resource retry authorization does not match");
    }
    if (row.request_hash !== this.requestHash) {
      throw new GatewayError(409, "conflict", "This idempotency key is already bound to a different request");
    }
    if (!row.outcome) throw new GatewayError(409, "conflict", "Resource receipt is incomplete");
    const saved = JSON.parse(row.outcome) as {
      recovery: Record<string, string>;
      publicResult?: Record<string, unknown>;
    };
    if (saved.publicResult) {
      this.result = saved.publicResult;
      return this.result;
    }
    if (saved.recovery.keyId) {
      const key = await this.env.DB.prepare("SELECT status FROM app_api_key WHERE id = ?")
        .bind(saved.recovery.keyId)
        .first<{ status: string }>();
      if (!key || key.status !== "active") {
        throw new GatewayError(410, "resource_key_unavailable", "This resource was created, but its generated key was revoked or removed. Create a replacement key intentionally.", undefined, { data: saved.recovery });
      }
    }
    if (!row.protected_credential || (row.protected_credential_expires_at ?? 0) <= Date.now()) {
      throw new GatewayError(410, "resource_receipt_expired", "This resource was already created, but its one-time response recovery window ended. Inspect the resource and revoke or replace its key explicitly.", undefined, { data: saved.recovery });
    }
    this.result = JSON.parse(await openSecret(this.env, "resourceReceipt", [this.id, this.proofHash], row.protected_credential)) as Record<string, unknown>;
    return this.result;
  }

  async commit(statement: D1PreparedStatement | D1PreparedStatement[], outcome: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const protectedOutcome = await sealSecret(this.env, "resourceReceipt", [this.id, this.proofHash], JSON.stringify(outcome));
    const complete = this.env.DB.prepare(
      `INSERT INTO mgmt_resource_receipt(
         id,kind,organization_id,initiating_user_id,initiating_credential_id,
         proof_hash,request_hash,outcome,protected_credential,protected_credential_expires_at,
         consumed_at,expires_at,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE changes() = 1
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      this.id, this.purpose, this.accountId, this.userId, this.credentialId,
      this.proofHash, this.requestHash,
      JSON.stringify({
        recovery: recovery(outcome),
        ...(typeof outcome.key === "string" || typeof (outcome.api_key as { key?: unknown } | null)?.key === "string"
          ? {} : { publicResult: outcome }),
      }),
      protectedOutcome, now + RESOURCE_RECEIPT_SECRET_TTL, now, now + RECEIPT_TTL, now, now,
    );
    await this.env.DB.batch([...(Array.isArray(statement) ? statement : [statement]), complete]);
    if (!(await this.read())) {
      throw new GatewayError(409, "conflict", "The resource changed before creation could commit; retry the same request");
    }
  }
}

export interface ResourceReceiptInput {
  env: Env;
  actor: Actor;
  kind: string;
  method: string;
  path: string;
  body: unknown;
  idempotencyKey?: string;
  proof?: string;
}

export async function prepareResourceReceipt(input: ResourceReceiptInput): Promise<ResourceReceipt | undefined> {
  const { idempotencyKey: key, proof } = input;
  if (key === undefined && proof === undefined) return undefined;
  if (!key || !proof || !PROOF.test(key) || !PROOF.test(proof)) {
    throw new GatewayError(400, "invalid_request", "Supply both random Idempotency-Key and X-Idempotency-Proof headers (32–256 characters)");
  }
  const id = `cli-resource:${await hashApiKey(canonical([input.actor.organizationId, input.actor.userId, input.kind, key]))}`;
  const requestHash = await hashApiKey(canonical({ method: input.method, path: input.path, body: input.body }));
  const receipt = new ResourceReceipt(
    input.env, id, `cli.resource.${input.kind}`, input.actor.organizationId, input.actor.userId,
    input.actor.credentialId, await hashApiKey(proof), requestHash,
  );
  await receipt.read();
  return receipt;
}
