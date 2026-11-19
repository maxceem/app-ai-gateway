/**
 * Who is calling the management API.
 *
 * For now only management keys (`Authorization: Bearer agw_mgmt_…`) are
 * accepted. Console sign-in and OAuth connections come with cf-auth 1.0 in
 * step 2.
 *
 * A key is checked against cf-auth's own tables, by the same rules cf-auth's
 * `resolveApiKeyAuthState` applies: the SHA-256 of the key, a management key
 * (not an OAuth connection), enabled, not revoked, not expired, and its owner
 * still an active member of an account that has not expired.
 *
 * Reading needs any member. Writing needs the `manage` grant and an owner or
 * admin role, with v1's codes (`grant_insufficient`, `forbidden`).
 */
import type { MiddlewareHandler } from "hono";
import { GatewayError } from "../core/errors.ts";

export const MANAGEMENT_KEY_PREFIX = "agw_mgmt_";

export type AccountRole = "owner" | "admin" | "member";

export interface AdminActor {
  readonly accountId: string;
  readonly userId: string;
  readonly keyId: string;
  readonly role: AccountRole;
  readonly grant: "read" | "manage";
}

export interface AdminVariables {
  actor: AdminActor;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unauthenticated(): GatewayError {
  return new GatewayError(401, "auth_required", "A valid management key is required", {
    "WWW-Authenticate": 'Bearer realm="management"',
  });
}

/** Resolves a management key to its actor, or throws 401. */
export async function managementActor(db: D1Database, authorization: string | undefined): Promise<AdminActor> {
  const value = authorization?.trim() ?? "";
  if (!/^bearer\s/iu.test(value)) throw unauthenticated();
  const token = value.slice(6).trim();
  if (!token.startsWith(MANAGEMENT_KEY_PREFIX)) throw unauthenticated();
  const now = Date.now();
  const row = await db
    .prepare(
      `SELECT k.id AS key_id, k.user_id, k.organization_id, k."grant" AS grant_name, m.role, o.expires_at
       FROM mgmt_api_key AS k
       JOIN mgmt_organization_user AS m ON m.user_id = k.user_id AND m.organization_id = k.organization_id
       JOIN mgmt_organization AS o ON o.id = k.organization_id
       JOIN mgmt_user AS u ON u.id = k.user_id
       WHERE k.token_hash = ? AND k.credential_type = 'apiKey' AND k.enabled = 1 AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > ?) AND m.status = 'active'`,
    )
    .bind(await sha256Hex(token), now)
    .first<{ key_id: string; user_id: string; organization_id: string; grant_name: string; role: string; expires_at: string | null }>();
  if (row === null) throw unauthenticated();
  if (row.expires_at !== null && Date.parse(row.expires_at) <= now) throw unauthenticated();
  const role: AccountRole = row.role === "owner" || row.role === "admin" ? row.role : "member";
  return {
    accountId: row.organization_id,
    userId: row.user_id,
    keyId: row.key_id,
    role,
    grant: row.grant_name === "manage" ? "manage" : "read",
  };
}

/** Puts the caller on the context, or refuses with 401. */
export const adminAuth: MiddlewareHandler<{ Bindings: Env; Variables: AdminVariables }> = async (c, next) => {
  c.set("actor", await managementActor(c.env.DB, c.req.header("authorization")));
  await next();
};

/** Refuses a write by a key with only the read grant, or by a member who is not an owner or admin. */
export function requireManage(actor: AdminActor): void {
  if (actor.grant !== "manage") {
    throw new GatewayError(403, "grant_insufficient", "This key has the read grant; use a key with the manage grant");
  }
  if (actor.role !== "owner" && actor.role !== "admin") {
    throw new GatewayError(403, "forbidden", "Only account owners and admins can change gateway resources");
  }
}
