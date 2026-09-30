/**
 * What the CLI routes read out of cf-auth's operation views.
 *
 * The engine owns `mgmt_operation` and answers about it only through its views
 * — `findByToken`, `poll`, `details` — so nothing here reads the table. What
 * this file adds is what the engine has no notion of: the id the CLI already
 * knows an operation by, which kind of the gateway's an engine kind is, and
 * the shape of the records this gateway keeps.
 */

import { cliKindName } from "../../auth/operation-kinds";
import { GatewayError } from "../../core/errors";
import { knownKind, OPERATION_KINDS, type OperationKind } from "./operation-kinds";
import { digest } from "./security";
import type { CliOperationKind } from "../../contracts/cli";

/**
 * The id the CLI knows an operation by: `op:` and its token's digest.
 *
 * The CLI computes it from the token it saved before sending, so it can poll
 * an operation whose answer it never received. Every operation is opened with
 * it as the engine's own id, so the two never differ.
 */
export async function operationId(token: string): Promise<string> {
  return `op:${await digest(token)}`;
}

/** The gateway's kind of an engine kind, and its entry in the gateway's table. */
export function kindOf(engineKind: string): { kind: CliOperationKind; entry: OperationKind } {
  const kind = knownKind(cliKindName(engineKind));
  return { kind, entry: OPERATION_KINDS[kind] };
}

/**
 * A record that breaks its kind's rules. The engine stores what this gateway
 * handed it, so a record that fails them means the deployment has moved under
 * its own data.
 */
function malformed(): GatewayError {
  return new GatewayError(500, "internal_error", "A stored operation does not match its kind");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a completed claim or resource write reports: its result, with any
 * one-time secret removed where the engine holds the whole of it sealed.
 */
export function resultRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw malformed();
  return raw;
}
