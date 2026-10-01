import type { CredentialGrant, OrganizationRole } from "@maxceem/cf-auth";

/**
 * Who is writing, in the one shape the management layer understands.
 *
 * A CLI operation, a plan cap and a management service all take this one
 * shape, so nothing re-derives who is writing from a session, an operation row
 * or a credential id of its own.
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
  /**
   * `session` for a person in the console, `apiKey` for a management key, and
   * `oauth` for a connection an MCP client holds, which is held to its
   * account and its grant exactly as a key is.
   */
  credentialType: "session" | "apiKey" | "oauth";
  identityKind: "human" | "service";
  /**
   * How much of the role this credential may use: a session is always
   * `manage`, a management key whatever it was issued with, a connection
   * whatever its person chose on the consent page. The executor
   * refuses a `read` one on any operation that writes.
   */
  grant: CredentialGrant;
}

