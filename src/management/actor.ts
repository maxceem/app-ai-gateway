import type { OrganizationRole } from "@maxceem/cf-auth";
import { GatewayError } from "../core/errors";

/**
 * Who is writing, in the one shape the management layer understands.
 *
 * It used to arrive in four: cf-auth's `AuthState`, an `AdminContext` whose
 * `credentialId` was `""` when there was none, a `ResourceWriteActor` of two
 * fields, and the three `initiating_*` columns of a handoff row read out by
 * hand wherever one was needed. A receipt, a plan cap and a management service
 * all take this.
 */
export interface Actor {
  organizationId: string;
  userId: string;
  /** The credential the write is made with, or null where the actor is not holding one. */
  credentialId: string | null;
}

/** An actor on the admin surface, where the credential that authenticated is known. */
export interface AdminActor extends Actor {
  role: OrganizationRole;
  credentialType: "session" | "apiKey";
  identityKind: "human" | "service";
}

/** The three columns a browser handoff carries its initiator in, read in one place. */
export function actorFromHandoff(row: {
  organization_id: string | null;
  initiating_user_id: string | null;
  initiating_credential_id: string | null;
}): Actor {
  if (!row.organization_id || !row.initiating_user_id || !row.initiating_credential_id) {
    throw new GatewayError(403, "forbidden", "This operation has no management identity binding");
  }
  return {
    organizationId: row.organization_id,
    userId: row.initiating_user_id,
    credentialId: row.initiating_credential_id,
  };
}
