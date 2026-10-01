/**
 * One CLI operation, from the request that sends it to the answer that
 * reports it.
 *
 * Every kind — a bootstrap, a login, a claim, a resource write — is one
 * operation of cf-auth's engine, opened under the token the CLI saved before
 * sending and the id the CLI derives from it. A retry with that token is
 * answered as the engine answers a poll, so a lost response is recovered
 * rather than repeated. What a resource write does, and how it runs under the
 * engine's guard, is the management layer's (`src/management/resource-operations.ts`);
 * this file is the CLI's transport over it.
 */

import type { CfAuthOperations, OperationView } from "@maxceem/cf-auth";
import { engineRefused, identityAuthFor, MANAGEMENT_IDENTITY } from "../../auth/identity";
import { GatewayError } from "../../core/errors";
import type { CliOperation } from "../../contracts/cli";
import { openClaim } from "../../management/claims";
import { deploymentMeta } from "../../management/deployment-meta";
import type { OperationInput } from "../../management/executor";
import {
  kindOf,
  operationId,
  operationKind,
  requestDigest,
} from "../../management/operation-kinds";
import {
  assertKindAccess,
  openResourceOperation,
  operationStatus,
} from "../../management/resource-operations";
import { managementActor } from "../../middleware/admin";
import { managementScope } from "../admin/body";
import type { CliContext, CliEnv } from "./types";

/** The identity instance every CLI route shares: it never provisions an account as a side effect. */
export function cliIdentity(c: CliContext) {
  return identityAuthFor(c, MANAGEMENT_IDENTITY);
}

/** cf-auth's operation engine, for this request. */
export async function operationEngine(c: CliContext): Promise<CfAuthOperations> {
  return (await cliIdentity(c)).operations;
}

export async function cliAuthenticate(c: CliContext): Promise<void> {
  c.set("actor", await managementActor(await authState(c)));
}

export async function authState(c: CliContext, interactive = false) {
  const auth = await cliIdentity(c);
  await auth.middleware<CliEnv>({
    apiKeys: !interactive,
    // The CLI's surface takes a management key; an OAuth connection's token
    // is for the two entry points an MCP client calls, `/mcp` and `/v1/admin`.
    oauth: false,
    syncCurrentOrganizationCookie: false,
  })(c, async () => {});
  return c.get("authState");
}

/**
 * Sends an operation, or recovers the one its token already names.
 *
 * A kind that runs at once is run here and answers completed; one that owes a
 * browser step answers pending with the approval page's URL. The engine binds
 * a token to its request, so a retry with the same token is answered as a
 * poll of the same operation, rerun if its write never landed.
 */
export async function createOperation(
  c: CliContext,
  { body: input, actor, state }: OperationInput<"createCliOperation">,
): Promise<CliOperation> {
  const kind = operationKind(input.kind);
  const scope = managementScope(c);
  const meta = deploymentMeta(scope.deployment);
  // A transport's check, so it stays here: a browser session may only send
  // operations from the console it was issued on.
  if (actor.credentialType === "session" && c.req.header("origin") !== meta.consoleOrigin) {
    throw new GatewayError(403, "forbidden", "Use the first-party console for browser operations");
  }
  const engine = (await scope.identity()).operations;
  if (kind.type === "claim") {
    const { view } = await openClaim(scope, actor, state, engine, {
      token: input.token,
      id: await operationId(input.token),
    });
    return operationStatus(scope, view);
  }
  await assertKindAccess(scope, actor, kind);
  if (kind.type !== "resource")
    throw new GatewayError(400, "invalid_request", "Unsupported operation kind");
  const browser = kind.browser === "always"
    || (kind.browser === "optional" && "browser" in input && input.browser === true);
  const view = await openResourceOperation(scope, actor, state, {
    kind: input.kind,
    payload: input.payload as Record<string, unknown>,
    browser,
    token: input.token,
    id: await operationId(input.token),
    digest: await requestDigest(input.kind, input.payload, browser),
  });
  return operationStatus(scope, view);
}

/**
 * The operation a poll or a redeem proves itself on: the token must hash to
 * the id in the path before anything about the operation is read, so nothing
 * reaches a caller that does not hold it.
 */
export async function provenOperation(
  c: CliContext,
  id: string,
): Promise<{ view: OperationView; token: string }> {
  const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  const view = /^[A-Za-z0-9_-]{32,256}$/.test(token) && (await operationId(token)) === id
    ? await (await operationEngine(c)).findByToken({ token })
    : null;
  if (!view) throw new GatewayError(403, "forbidden", "Invalid operation token");
  return { view, token };
}

export async function pollOperation(
  c: CliContext,
  { params }: OperationInput<"pollCliOperation">,
): Promise<CliOperation> {
  const { view, token } = await provenOperation(c, params.id);
  // A bootstrap is recovered by sending it again, which is also what activates
  // the key it delivers; a poll could hand over a key that never works.
  if (kindOf(view.kind).entry.type === "bootstrap")
    throw new GatewayError(400, "invalid_request", "Recover a bootstrap by sending it again");
  const engine = await operationEngine(c);
  const scope = managementScope(c);
  try {
    return await operationStatus(scope, await engine.poll({ id: view.id, token }));
  } catch (error) {
    // The engine withdrew what it held — a login's key revoked before anyone
    // collected it — and the CLI is told the operation is over, in its own
    // vocabulary, rather than given an error for a question it asked rightly.
    if (!engineRefused(error, "operation_expired")) throw error;
    return operationStatus(scope, { ...view, state: "expired" });
  }
}
