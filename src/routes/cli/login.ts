/**
 * A CLI that holds no credential getting one from a person.
 *
 * The login is cf-auth's own operation kind: anyone may open one, a signed-in
 * person approves it into one of their accounts on the console's approval
 * page, and the engine mints a management key owned by that person, marked
 * `source: "cli"` and named after the CLI's label, in the batch that completes
 * it. What this file adds is the gateway's shape of it: the id the CLI already
 * knows, the approval URL on the console's origin, and the account the key
 * belongs to.
 */

import { accountLifecycle } from "../../core/account-lifecycle";
import { clientAddress, enforceEndpointRateLimit } from "../../core/endpoint-rate-limit";
import { GatewayError } from "../../core/errors";
import { deploymentMeta } from "../../management/deployment-meta";
import type { CliLogin, CliLoginRedeemResponse } from "../../contracts/cli";
import type { OperationInput } from "../../management/executor";
import {
  browserPath,
  cliIdentity,
  operationEngine,
  provenOperation,
} from "./operations";
import { kindOf, operationId } from "./operation-rows";
import type { CliContext } from "./types";

/** The longest client text the engine stores; a longer user agent is cut rather than refused. */
const CLIENT_TEXT_LIMIT = 512;

export async function openLogin(
  c: CliContext,
  { body }: OperationInput<"openCliLogin">,
): Promise<CliLogin> {
  const meta = deploymentMeta(c.get("deployment"));
  const userAgent = c.req.header("user-agent")?.slice(0, CLIENT_TEXT_LIMIT);
  const id = await operationId(body.token);
  // Both limits on an endpoint anyone may call are taken over this address —
  // how many logins it asks for an hour, and how many of them may wait at
  // once — so it is always set: a request with no edge in front of it shares
  // the one `local` counter rather than escaping either.
  // The same address is stored for the approval page to show, where it is
  // only ever displayed.
  const ip = clientAddress(c.req.raw);
  const engine = await operationEngine(c);
  // Sent again: answered with where it stands, without the engine handing a
  // key it may still hold to an answer that has nowhere to put it — only a
  // poll, or a redeem, collects that.
  const existing = await engine.findByToken({ token: body.token });
  if (existing && kindOf(existing.kind).entry.type !== "login")
    throw new GatewayError(409, "conflict", "This operation token is already bound to a different request");
  // Counted only when it asks for a new login: a resend of one already asked
  // for is answered whatever the count, so a CLI that lost its answer is never
  // locked out of the login it is waiting on.
  if (!existing) await enforceEndpointRateLimit(c.env, "login", ip);
  const view = existing ?? await engine.open({
    id,
    kind: "login",
    token: body.token,
    rateLimitKey: ip,
    client: {
      label: body.client.label,
      meta: {
        ...(body.client.os === undefined ? {} : { os: body.client.os }),
        ip,
        ...(userAgent === undefined ? {} : { userAgent }),
      },
      loopbackRedirect: body.loopbackRedirect ?? null,
    },
  });
  const state = view.state === "retired" ? "expired" : view.state;
  return {
    id,
    kind: "login",
    state,
    url: view.browserProof === null ? null : `${meta.consoleOrigin}${browserPath(id)}#${view.browserProof}`,
    userCode: view.userCode,
    expiresAt: view.expiresAt,
  };
}

/**
 * The credential of a login whose CLI listened locally, for the one-time code
 * the approval page sent there. Needs the operation's token as well, so a code
 * caught in transit is useless on its own.
 */
export async function redeemLogin(
  c: CliContext,
  { body, params }: OperationInput<"redeemCliLogin">,
): Promise<CliLoginRedeemResponse> {
  const { view, token } = await provenOperation(c, params.id);
  if (kindOf(view.kind).entry.type !== "login")
    throw new GatewayError(400, "invalid_request", "Only a login is redeemed");
  const { outcome } = await (await operationEngine(c)).redeem({
    id: view.id,
    token,
    redeemCode: body.redeemCode,
  });
  const delivered = outcome as { credential: { token: string }; organizationId: string };
  return {
    credential: { token: delivered.credential.token },
    account: await accountLifecycle(c.env, delivered.organizationId),
  };
}

/**
 * Ends the key the request was sent with: a CLI logging out. Holding a key is
 * authority enough, whatever its role; a browser session is refused, since it
 * signs out instead.
 */
export async function revokeCredential(c: CliContext): Promise<{ revoked: true }> {
  await (await cliIdentity(c)).service.revokeOwnApiKey({ actor: c.get("authState") });
  return { revoked: true };
}
