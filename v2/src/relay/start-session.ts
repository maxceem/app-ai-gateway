/**
 * Where an app asks for a live session (plan section 4.3, step 1;
 * `POST /v2/apps/{app}/sessions/{provider}`).
 *
 * The caller is checked like any app request (`serveCaller`). The app must
 * allow the session's operation and model, as for a call. Then the session's slots are taken (`admitSession`): the end
 * user's, then the app's, each with its budget. Last, the session's copy of
 * the credentials is sealed and its ticket signed (`issueTicket`). The answer
 * carries the ticket and the relay's address; the app connects there.
 *
 * Opening a session uses no request and no plan allowance (D8). The session's
 * ledger row is written after the reply; if that write fails, the first
 * checkpoint or `close` writes it (crash table row 3).
 */
import { assertAppServes, loadRequestApp } from "../apps/app-records.ts";
import { StartSessionRequestSchema, type ClientOperationResponse } from "../contracts/client-catalog.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { ledgerDb } from "../ledger/database.ts";
import { openSession } from "../ledger/sessions.ts";
import { admitSession, releaseAdmission } from "../limits/session-admission.ts";
import { knownModel, listOf, priceSources } from "../pricing/billability.ts";
import { connectionDescription, loadConnection, sealedCredentials } from "../providers/connections.ts";
import { upstreamRoute } from "../providers/matcher.ts";
import { upstreamUrl } from "../providers/route.ts";
import { callRefusal, matcherFor, refusal, serveCaller, type ProxyContext } from "../proxy/serve.ts";
import { UNRECOGNIZED } from "../diagnostics/rejection-events.ts";
import { issueTicket, newSessionId, TICKET_TTL_MS } from "./tickets.ts";

/** How long a live session lasts at most, and by default (plan section 6, owner 2026-11-17). */
export const SESSION_CAP_MS = 30 * 60_000;
/** The relay's path for a session (`relay/src/constants.js`). */
const RELAY_SESSION_PATH = "/v2/relay/session";

/** The relay's address for a session, from `RELAY_URL`, or null when the deployment has none. */
export function relaySessionUrl(env: Env): string | null {
  const base = (env as unknown as { RELAY_URL?: unknown }).RELAY_URL;
  if (typeof base !== "string" || base === "") return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = RELAY_SESSION_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function startSessionHandler(c: ProxyContext): Promise<Response> {
  const startedAt = Date.now();
  const appId = c.req.param("app");
  const slug = c.req.param("provider");
  if (!appId || !slug) throw new GatewayError(400, "invalid_request", "App id and provider are required");
  const app = await loadRequestApp(c, appId);
  assertAppServes(c.env, app);
  const routing = Object.hasOwn(app.routing.providers, slug) ? app.routing.providers[slug] : undefined;
  const connection = routing === undefined ? null : await loadConnection(c.env, app.accountId, slug);
  const description = connection === null ? null : connectionDescription(connection);

  return serveCaller(
    c,
    {
      app,
      startedAt,
      providerSlug: routing === undefined ? UNRECOGNIZED : slug,
      ...(description === null ? {} : { providerAuthHeader: description.auth.header }),
    },
    async (caller) => {
      const { identity } = caller;
      if (connection === null || description === null || routing === undefined) {
        throw new GatewayError(502, "provider_not_configured", `No provider connection ${slug} is set up for this app`);
      }
      if (connection.status === "disabled") {
        throw new GatewayError(502, "provider_disabled", `Provider connection ${slug} is disabled`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(await caller.readBody()));
      } catch {
        throw new GatewayError(400, "invalid_request", "The request body must be JSON");
      }
      const request = StartSessionRequestSchema.safeParse(parsed);
      if (!request.success) throw new GatewayError(400, "invalid_request", "The request must name a live-session path, and may name a model and a session to take over");

      // The provider's own live-session path, as for any operation it declares.
      const match = matcherFor(description).match("GET", request.data.path, { route: upstreamRoute(description, connection) });
      const operation = match.kind === "operation" ? match.operation : null;
      if (match.kind !== "operation" || operation === null || operation.lifecycle !== "session" || operation.session === undefined) {
        throw new GatewayError(403, "path_not_allowed", "Provider path is not a live session");
      }
      caller.facts.operation = operation.name;
      if (!routing.operations.includes(operation.name)) {
        throw new GatewayError(403, "path_not_allowed", `This app does not allow ${operation.name}`);
      }
      // Observed mode (WebRTC) comes with step 9a part 3.
      if (operation.session.mode !== "relayed") throw new GatewayError(403, "path_not_allowed", `${operation.name} is not served yet`);
      // The relay dials the provider's own address; a session through Cloudflare AI Gateway is not served yet.
      if (connection.cloudflareGateway !== null) {
        throw new GatewayError(502, "provider_unavailable", "Live sessions cannot go through Cloudflare AI Gateway yet");
      }
      const location = operation.model;
      const requested = location.in === "fixed" ? location.model : request.data.model;
      if (requested === undefined) throw new GatewayError(400, "invalid_request", `${operation.name} needs a model`);
      caller.facts.model = requested;
      // A refusal records the model only when the gateway knows it, as for a call.
      caller.facts.modelKnown = () => knownModel(routing, app.routing.model_rewrites, priceSources(connection), requested);
      // The app's model list judges the model, as for a call; a rewrite is
      // never applied to a session (plan D13). Its price is checked where a
      // session is metered, at its checkpoints (step 9a part 2): no session
      // operation has a price in the list yet.
      const listed = listOf(routing);
      if (listed !== null && !listed.has(requested)) throw callRefusal({ kind: "refused", reason: "model_not_allowed", model: requested }, operation);
      const call = { model: requested };
      const relayUrl = relaySessionUrl(c.env);
      if (relayUrl === null) {
        log("error", "relay_url_missing", {});
        throw new GatewayError(503, "service_unavailable", "Live sessions are not set up on this deployment");
      }
      const query = location.in === "query" ? `?${new URLSearchParams({ [location.name]: call.model }).toString()}` : "";
      const url = upstreamUrl(connection, description, { hostKey: match.upstream.host, path: match.upstream.path.replace(/^\//u, ""), query });
      const credentials = sealedCredentials(connection, identity.keyShare);

      const now = Date.now();
      const sessionId = newSessionId();
      const claim = {
        sessionId,
        kind: operation.session.slot,
        ticketStart: now,
        expiresAt: now + TICKET_TTL_MS,
        deadline: now + SESSION_CAP_MS,
      };
      const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
      const admission = await admitSession({ env: c.env, app, identity, claim, takesOver: request.data.takes_over ?? null, waitUntil, refuse: refusal });

      let issued;
      try {
        issued = await issueTicket(
          c.env,
          {
            accountId: app.accountId,
            appId: app.id,
            endUserId: identity.userId,
            installId: identity.installId,
            appleAccountId: identity.appleAccountId,
            appKeyId: identity.apiKeyId ?? null,
            providerType: connection.type,
            connectionId: connection.id,
            operation: operation.name,
            model: call.model,
            mode: operation.session.mode,
            slot: operation.session.slot,
            sessionTotal: false,
            url,
            capMs: SESSION_CAP_MS,
            credentials,
            keyPlacement: { header: description.auth.header, format: description.auth.format },
          },
          now,
          sessionId,
        );
      } catch (error) {
        // The start goes no further: its slots are freed at once, not at the ticket's expiry.
        waitUntil(releaseAdmission(c.env, app.id, sessionId, admission));
        throw error;
      }
      // The session's row, after the reply (4.3 step 1): a failed write is
      // made by the first checkpoint or by `close` (crash table row 3).
      waitUntil(
        openSession(ledgerDb(c.env, app.accountId), issued.session, now).catch((error: unknown) =>
          log("warn", "session_row_unwritten", { app: app.id, error: errorFacts(error) }),
        ),
      );
      const body: ClientOperationResponse<"startSession"> = {
        session_id: issued.sessionId,
        ticket: issued.ticket,
        relay_url: relayUrl,
        expires_at: new Date(issued.expiresAt).toISOString(),
        ends_at: new Date(issued.deadline).toISOString(),
      };
      return c.json(body, 201, { "cache-control": "no-store" });
    },
  );
}
