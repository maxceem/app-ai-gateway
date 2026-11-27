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
import { attachLookupKeyCopies, openSession, PROVIDER_LOOKUP_WINDOW_MS } from "../ledger/sessions.ts";
import { admitSession, releaseSessionLeases } from "../limits/session-admission.ts";
import { backendModels, knownModel, listOf, priceSources, resolveCall, resolveWebsocket } from "../pricing/billability.ts";
import { compiledWebsocket, PASSTHROUGH, WEBSOCKET_OPERATION } from "../providers/passthrough.ts";
import { connectionDescription, loadConnection, sealedCredentials } from "../providers/connections.ts";
import { priceKeyValues, removeOutbound } from "../proxy/request-fields.ts";
import { storeKeyCopies } from "../vault/key-copies.ts";
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

/**
 * A query field named as a credential: a key, a token, a secret or an authorization (`xi-api-key`,
 * `api_key`, `access_token`, `authorization`, `single_use_token`). Never sent: the session's key is the
 * only credential.
 */
export const CREDENTIAL_FIELD = /(^|[_-])(key|token|secret|authorization)$/iu;

/** A live-session path and its query, apart: the query, if any, without its `?`. */
function splitQuery(path: string): [string, string | undefined] {
  const at = path.indexOf("?");
  return at === -1 ? [path, undefined] : [path.slice(0, at), path.slice(at + 1)];
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

      // The provider's own live-session path, as for any operation it declares. Its query holds the
      // session's options (Deepgram's audio format, ElevenLabs' output format), sent on as they are.
      // A custom provider's listed WebSocket path is reached as its other listed paths are, by an app
      // that allows passthrough, and served by the generic adapter (plan D4, D10).
      const [path = "", search] = splitQuery(request.data.path);
      const websocket = routing.operations.includes(PASSTHROUGH) ? compiledWebsocket(connection.passthrough ?? []) : [];
      const match = matcherFor(description).match("GET", path, { route: upstreamRoute(description, connection), passthrough: websocket });
      const operation = match.kind === "operation" ? match.operation : match.kind === "passthrough" ? WEBSOCKET_OPERATION : null;
      if (operation === null || match.kind === "refused" || operation.lifecycle !== "session" || operation.session === undefined) {
        throw new GatewayError(403, "path_not_allowed", "Provider path is not a live session");
      }
      caller.facts.operation = operation.name;
      // Only a provider that takes the session's options in its query gets the app's; any other session
      // refuses a query, as the path with it never matched before (Sol, #273 round 1).
      if (search !== undefined && operation.session.queryOptions !== true) throw new GatewayError(403, "path_not_allowed", "Provider path is not a live session");
      if (match.kind === "operation" && !routing.operations.includes(operation.name)) {
        throw new GatewayError(403, "path_not_allowed", `This app does not allow ${operation.name}`);
      }
      // Observed mode (WebRTC) comes with step 9a part 3.
      if (operation.session.mode !== "relayed") throw new GatewayError(403, "path_not_allowed", `${operation.name} is not served yet`);
      // The relay dials the provider's own address; a session through Cloudflare AI Gateway is not served yet.
      if (connection.cloudflareGateway !== null) {
        throw new GatewayError(502, "provider_unavailable", "Live sessions cannot go through Cloudflare AI Gateway yet");
      }
      const location = operation.model;
      // As for a call: the model the app names, in the body or, for a provider that takes it there, in the
      // query (Deepgram's `model`, ElevenLabs' `model_id`), else the operation's default.
      const options = new URLSearchParams(search ?? "");
      const inQuery = location.in === "query" ? (options.get(location.name) ?? undefined) : undefined;
      const requested = location.in === "fixed" ? location.model : (request.data.model ?? inQuery ?? ("default" in location ? location.default : undefined));
      if (requested === undefined) throw new GatewayError(400, "invalid_request", `${operation.name} needs a model`);
      caller.facts.model = requested;
      // A refusal records the model only when the gateway knows it, as for a call.
      caller.facts.modelKnown = () => knownModel(routing, app.routing.model_rewrites, priceSources(connection), requested);
      // The model is judged as a call's is: the app's model list, then its price. A model the app
      // does not list by name is served only with a price, and one priced in a unit the session
      // cannot bill never is; saving already refused a listed model with no price. Every live
      // session's usage is read by the relay (xAI 9b, Gemini 9d, OpenAI 9e), so none starts
      // unpriced. A rewrite is never applied to a session (plan D13).
      // A listed WebSocket path has no model: its listing's rate prices it (`resolveWebsocket`).
      const resolved =
        match.kind === "passthrough" ? resolveWebsocket(match.listed) : resolveCall(routing, undefined, priceSources(connection), operation, requested, listOf(routing), { asIfServed: true });
      if (resolved.kind === "refused") throw callRefusal(resolved, operation);
      const call = { model: requested };
      // A session that calls other models itself (GPT-Live's backend): the ones the app may call that
      // way, judged as a call to the backend's operation is, travel in the ticket for the relay to enforce.
      const backendSpec = operation.session.backend;
      const backendOperation = backendSpec === undefined ? undefined : description.operations.find((one) => one.name === backendSpec.operation);
      const backend = backendOperation === undefined ? undefined : backendModels(routing, priceSources(connection), backendOperation);
      const relayUrl = relaySessionUrl(c.env);
      if (relayUrl === null) {
        log("error", "relay_url_missing", {});
        throw new GatewayError(503, "service_unavailable", "Live sessions are not set up on this deployment");
      }
      // The app's options go on as it sent them, except the fields the operation removes (webhooks), any
      // field named as a credential (`CREDENTIAL_FIELD`), and the model, which is always the session's own.
      const sent = removeOutbound(operation, null, options).query ?? new URLSearchParams(options);
      for (const name of [...new Set(sent.keys())]) if (CREDENTIAL_FIELD.test(name)) sent.delete(name);
      if (location.in === "query") sent.set(location.name, call.model);
      const queryText = sent.toString();
      const url = upstreamUrl(connection, description, {
        hostKey: match.upstream.host,
        path: match.upstream.path.replace(/^\//u, ""),
        query: queryText === "" ? "" : `?${queryText}`,
        passthrough: match.kind === "passthrough",
      });
      const credentials = sealedCredentials(connection, identity.keyShare);
      // The values the session's price depends on, read from its options once: its slices are priced with them.
      const priceKeys = priceKeyValues(operation, { body: {}, query: options });
      // A provider whose own dollar figure settles the session after it ends (Deepgram's request record).
      const lookup = operation.session.lookup;

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
      await admitSession({ env: c.env, app, identity, claim, takesOver: request.data.takes_over ?? null, waitUntil, refuse: refusal });

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
            sessionTotal: lookup !== undefined,
            url,
            capMs: SESSION_CAP_MS,
            credentials,
            keyPlacement: { header: description.auth.header, format: description.auth.format },
            ...(backend === undefined ? {} : { backend }),
            ...(priceKeys === undefined ? {} : { priceKeys }),
          },
          now,
          sessionId,
        );
      } catch (error) {
        // The start goes no further: its slots are freed at once, not at the ticket's expiry.
        waitUntil(releaseSessionLeases(c.env, { appId: app.id, installId: identity.installId, endUserId: identity.userId }, sessionId, waitUntil));
        throw error;
      }
      // The session's row, after the reply (4.3 step 1): a failed write is
      // made by the first checkpoint or by `close` (crash table row 3). With
      // a lookup after the end, the key's copies for it are put on its row
      // once made, whichever write made the row.
      const ledger = ledgerDb(c.env, app.accountId);
      const opened = openSession(ledger, issued.session, now).catch((error: unknown) =>
        log("warn", "session_row_unwritten", { app: app.id, error: errorFacts(error) }),
      );
      waitUntil(opened);
      if (lookup !== undefined) {
        waitUntil(
          (async () => {
            // The ticket's expiry, the time cap and the lookup's hour (plan 8j).
            const copies = await storeKeyCopies(c.env, credentials, issued.expiresAt + SESSION_CAP_MS + PROVIDER_LOOKUP_WINDOW_MS, {
              message: "session_key_copy_failed",
              facts: { app: app.id, session: issued.sessionId },
            });
            if (copies === undefined) return;
            await opened;
            if (!(await attachLookupKeyCopies(ledger, issued.sessionId, copies))) log("warn", "session_key_copy_unattached", { app: app.id, session: issued.sessionId });
          })().catch((error: unknown) => log("warn", "session_key_copy_unattached", { app: app.id, session: issued.sessionId, error: errorFacts(error) })),
        );
      }
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
