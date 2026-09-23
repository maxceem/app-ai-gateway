import type { OrganizationRole } from "@maxceem/cf-auth";
import { GatewayError } from "../core/errors";

/**
 * Who is writing, in the one shape the management layer understands.
 *
 * A receipt, a plan cap and a management service all take this one shape, so
 * nothing re-derives who is writing from a session, a handoff row or a
 * credential id of its own.
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
