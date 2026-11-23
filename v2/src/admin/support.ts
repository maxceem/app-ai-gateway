/**
 * Messages to human support (v1's, ported): from the console's Support menu,
 * `agw support send` and the MCP `contact_support` tool alike.
 *
 * Support is a plan feature (`humanSupport`), so it exists only where there
 * are plans (a hosted deployment, with billing) and a help desk bound as
 * `HELPDESK`, and only for an account whose plan includes it. A self-hosted
 * deployment, without billing, offers none, as in v1. The help desk keeps the
 * ticket, refuses a pasted credential, recognises a repeated message, and
 * emails the support inbox with the person's address as the reply-to, so the
 * conversation carries on in email rather than in the console.
 *
 * Nothing the person wrote is logged: a refusal names only its kind.
 */
import type { Context } from "hono";
import type { OperationResponse } from "../contracts/catalog.ts";
import { SupportMessageRequestSchema } from "../contracts/support.ts";
import { planFeatureRefusal, planIncludes, readBillingForConsole } from "../billing/access.ts";
import type { GatewayBillingAccess } from "../contracts/billing.ts";
import { consoleOrigin, hostedDeployment, setting } from "../auth/settings.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { enforceEndpointRateLimit } from "../core/flood-limit.ts";
import { log } from "../core/log.ts";
import { helpdeskBinding, type HelpdeskChannel, type HelpdeskTicketResult } from "../helpdesk/contract.ts";
import type { AdminVariables } from "./actor.ts";
import { parseBody } from "./apps.ts";

type AdminContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

/** The gateway's id at the help desk. */
export const HELPDESK_SERVICE_ID = "app-ai-gateway";

/** Addresses accepted as an inbox: a bare `local@domain`. */
const INBOX_ADDRESS = /^[^\s<>()[\],;:"\\@\x00-\x1f\x7f]+@[^\s<>()[\],;:"\\@\x00-\x1f\x7f]+$/u;

/** The help desk's channel for each credential source. */
const CHANNELS: Readonly<Record<string, HelpdeskChannel>> = { web: "console", cli: "cli", mcp: "mcp", api: "api" };

/**
 * The inbox the Support menu names, or null where the deployment offers no
 * support: no `HELPDESK` binding, no well-formed `SUPPORT_EMAIL`, or no
 * billing whose plans could include it. Reads the environment only, so the
 * public capabilities answer and the tool list can ask it on every request.
 */
export function supportInbox(env: Env): string | null {
  if (helpdeskBinding(env) === null || !hostedDeployment(env)) return null;
  const inbox = setting(env, "SUPPORT_EMAIL");
  return inbox !== undefined && INBOX_ADDRESS.test(inbox) ? inbox : null;
}

export async function sendSupportMessage(c: AdminContext): Promise<Response> {
  const actor = c.get("actor");
  const state = c.get("authState");
  // A message writes to the outside world, so it takes the manage grant; any role may send one.
  if (actor.grant !== "manage") {
    throw new GatewayError(403, "grant_insufficient", "This credential has the read grant; use one with the manage grant");
  }
  const body = await parseBody(c, SupportMessageRequestSchema);
  const helpdesk = helpdeskBinding(c.env);
  if (helpdesk === null || supportInbox(c.env) === null) {
    throw new GatewayError(404, "not_found", "This deployment does not offer human support");
  }
  const email = state.user?.email;
  if (!email) throw new GatewayError(409, "conflict", "This credential's owner has no email address to reply to");
  // Support replies to this address, and the help desk emails it at once: only an address its owner proved is theirs.
  if (state.user?.emailVerified !== true) {
    throw new GatewayError(403, "email_unverified", "Verify your email address before writing to support: support replies to it. Open the link in the verification email, or send a new one from the console.");
  }
  // The plan, read fresh with the console's deadline, never from a cache. An
  // outage is not a statement about the account, and it is when a paying
  // customer most needs to write in: a read that fails or runs late sends the
  // ticket with the plan unknown. A read that answers with no plan, or one
  // that leaves support out, is refused.
  let access: GatewayBillingAccess | null;
  try {
    access = await readBillingForConsole(c.env, actor.accountId);
  } catch (error) {
    if (!(error instanceof GatewayError) || error.code !== "billing_unavailable") throw error;
    access = null;
  }
  if (access !== null && !planIncludes(access, "humanSupport")) throw planFeatureRefusal("humanSupport");
  const plan = access !== null && access.state === "billed" ? access.plan : null;

  await enforceEndpointRateLimit(c.env, "support_message", actor.userId);

  const name = state.user?.name?.trim();
  const accountName = state.organization?.name?.trim();
  const origin = consoleOrigin(c.env) ?? new URL(c.req.url).origin;
  let result: HelpdeskTicketResult;
  try {
    result = await helpdesk.createTicket({
      serviceId: HELPDESK_SERVICE_ID,
      kind: body.kind,
      message: body.message,
      customer: { email, userId: actor.userId, ...(name ? { name: name.slice(0, 200) } : {}) },
      account: {
        tenantId: actor.accountId,
        ...(accountName ? { name: accountName.slice(0, 200) } : {}),
        plan: plan !== null ? plan.planName.slice(0, 100) : "unknown (billing unreachable)",
      },
      channel: CHANNELS[state.source ?? "api"] ?? "api",
      ...(body.client === undefined ? {} : { client: body.client }),
      ...(body.page === undefined ? {} : { page: new URL(body.page, origin).toString() }),
      ...(body.context === undefined ? {} : { context: body.context }),
    });
  } catch (error) {
    log("error", "support_helpdesk_failed", { error: errorFacts(error) });
    throw new GatewayError(503, "email_unavailable", "Your message could not be sent. Try again in a few minutes.");
  }

  if (result.ok) {
    return c.json({
      status: "sent",
      reference: result.reference,
      replyTo: result.replyTo,
      duplicate: result.duplicate,
    } satisfies OperationResponse<"sendSupportMessage">);
  }
  switch (result.code) {
    case "invalid_input":
    case "credential_detected":
      throw new GatewayError(400, "invalid_request", result.message);
    case "rate_limited":
      throw new GatewayError(
        429,
        "rate_limited",
        result.message,
        result.retryAfterSeconds === undefined ? undefined : { "Retry-After": String(result.retryAfterSeconds) },
      );
    case "unknown_service":
      log("error", "support_helpdesk_unknown_service", { serviceId: HELPDESK_SERVICE_ID });
      throw new GatewayError(404, "not_found", "This deployment does not offer human support");
  }
}
