/**
 * The v2 gateway Worker.
 *
 * Everything it serves is under `/v2`, so it can run beside v1 on the same
 * hostnames, with a Worker route for `/v2` and `/v2/*` (plan section 9.1,
 * test T23). Anything it does not declare is answered with a JSON 404.
 *
 * It serves app sign-in, `/me`, provider requests
 * (`/v2/apps/{app}/proxy/{provider}/...`, outside the catalog because they
 * follow the provider descriptions) and presets
 * (`/v2/apps/{app}/presets/{slug}`, whose bodies follow their provider's API
 * style) itself. The management API, people's
 * sign-in, the OAuth server and the console's pages are loaded on first use
 * (`./management/app.ts`), and so is the MCP endpoint (`./mcp/app.ts`). The
 * OAuth discovery documents live under `/.well-known/`, outside `/v2`.
 */
import { emailSetup } from "./email/sender.ts";
import { Hono, type Context } from "hono";
import { CLIENT_CATALOG, honoPath, type ClientOperationName, type ClientOperationResponse } from "./contracts/client-catalog.ts";
import type { ErrorResponse } from "./contracts/operation.ts";
import { storedAppVersion } from "./core/app-version.ts";
import { loadedAppId } from "./apps/app-records.ts";
import { errorFacts } from "./core/error-facts.ts";
import { GatewayError } from "./core/errors.ts";
import { log } from "./core/log.ts";
import { runSweep, SWEEP_CRON } from "./ledger/sweep.ts";
import { asGatewayError } from "./core/platform-errors.ts";
import { clientCallDeadline, type DeadlineVariables } from "./http/deadline.ts";
import { serverTiming } from "./proxy/timing.ts";
import { appAuthFloodLimit, challengeHandler, failureHandler, registerHandler, tokenHandler } from "./routes/auth.ts";
import { meHandler } from "./routes/me.ts";
import { presetHandler } from "./proxy/presets.ts";
import { proxyHandler } from "./proxy/serve.ts";
import { jobCancelHandler, jobResultHandler, jobStatusHandler, pollNoStore } from "./jobs/poll.ts";
import { lazyRoutes } from "./http/lazy.ts";
import { vaultStatus } from "./vault/index.ts";
import { runHourly } from "./maintenance/nightly.ts";
import { requestIdOf } from "./core/request-id.ts";

export { EndUserLimiter } from "./do/EndUserLimiter.ts";
export { FloodLimiter } from "./do/FloodLimiter.ts";
export { ChargeStore } from "./do/ChargeStore.ts";
export { AppLimiter } from "./do/AppLimiter.ts";
export { AccountLimiter } from "./do/AccountLimiter.ts";
export { ConversationLog } from "./do/ConversationLog.ts";

type Env2 = { Bindings: Env; Variables: DeadlineVariables };

/** Where the console's pages live. */
const CONSOLE_BASE = "/v2";

/**
 * The console's routes, below `/v2`, exactly as its router declares them. A
 * `:name` segment matches any one segment. Only these get the console's
 * document: any other unknown path, such as an API path called the wrong way
 * or a missing file, stays a JSON 404. Add a route here when the console
 * gains one.
 */
const CONSOLE_ROUTES = [
  "/login",
  "/signup",
  "/oauth/consent",
  "/device",
  "/approve/:id",
  "/reveal/:id",
  "/access",
  "/settings",
  "/settings/:section",
  "/apps",
  "/apps/:app",
  "/apps/:app/:tab",
  "/providers",
  "/prices",
  "/verify-email",
] as const;

const CONSOLE_ROUTE_SEGMENTS = CONSOLE_ROUTES.map((route) => route.slice(1).split("/"));

/** A browser loading one of the console's pages, not a script calling the API. */
function isConsolePage(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (!(request.headers.get("accept") ?? "").includes("text/html")) return false;
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${CONSOLE_BASE}/`)) return false;
  // One trailing slash is the same page, as the console's router reads it.
  const segments = pathname.slice(CONSOLE_BASE.length + 1).replace(/\/$/u, "").split("/");
  // A file name is never a page, even under one.
  if (segments.at(-1)?.includes(".")) return false;
  return CONSOLE_ROUTE_SEGMENTS.some(
    (route) =>
      route.length === segments.length &&
      route.every((part, index) => (part.startsWith(":") ? segments[index] !== "" : part === segments[index])),
  );
}

const app = new Hono<Env2>();

/** A client operation's path in Hono's syntax. */
function routePath(name: ClientOperationName): string {
  return honoPath(CLIENT_CATALOG[name].path);
}

app.get(routePath("getHealth"), (c) =>
  c.json({
    ok: true,
    service: "app-ai-gateway",
    api: "v2",
    vault: vaultStatus(c.env),
    email: emailSetup(c.env).state,
  } satisfies ClientOperationResponse<"getHealth">),
);

app.post(routePath("appAuthChallenge"), clientCallDeadline(), appAuthFloodLimit("app_auth_challenge"), challengeHandler);
app.post(routePath("appAuthRegister"), clientCallDeadline(), appAuthFloodLimit("app_auth_register"), registerHandler);
app.post(routePath("appAuthToken"), clientCallDeadline(), appAuthFloodLimit("app_auth_token"), tokenHandler);
app.post(routePath("appAuthFailure"), clientCallDeadline(), appAuthFloodLimit("app_auth_failure"), failureHandler);
app.get(routePath("getCurrentUser"), clientCallDeadline(), meHandler);

// Everything else but provider requests: the management API, sign-in, the
// OAuth server and the console's pages. Loaded on first use, so none of it is
// on a provider request's cold start (see `./management/app.ts`).
const management = lazyRoutes(() => import("./management/app.ts").then((module) => module.default));
// The OAuth endpoints are named one by one: `/v2/oauth/consent` is the
// console's own page.
for (const pattern of ["/v2/admin/*", "/v2/cli/*", "/v2/auth/*", "/v2/oauth/authorize", "/v2/oauth/token", "/v2/oauth/revoke", "/v2/oauth/device_authorization", "/v2/console/*", "/.well-known/oauth-authorization-server/v2", "/.well-known/oauth-protected-resource/v2", "/.well-known/oauth-protected-resource/v2/*"]) {
  app.all(pattern, management);
}

// The MCP endpoint, loaded on first use apart from the rest, so the MCP SDK
// is evaluated only by an MCP request (see `./mcp/app.ts`).
app.all("/v2/mcp", lazyRoutes(() => import("./mcp/app.ts").then((module) => module.default)));

// Provider requests. No deadline of their own: a provider may stream for minutes.
// Each served route answers with `server-timing`, error answers included (`./proxy/timing.ts`).
app.all("/v2/apps/:app/proxy/:provider/*", serverTiming, proxyHandler);
// Job polls: free, and their upstream URL comes from the signed job id (plan D9).
app.get(routePath("getJobStatus"), serverTiming, pollNoStore, jobStatusHandler);
app.get(routePath("getJobResult"), serverTiming, pollNoStore, jobResultHandler);
app.put(routePath("cancelJob"), serverTiming, pollNoStore, jobCancelHandler);
app.post("/v2/apps/:app/presets/:slug", serverTiming, presetHandler);

app.notFound(async (c) => {
  // A page of the console, such as `/v2/access` or `/v2/oauth/consent`: no
  // file has that path, so a browser gets the console's document, which
  // routes it itself. It is never framed, as the static files' own rule says
  // (`console/public/_headers`); set here too, since that file may not apply
  // to an answer the Worker hands on.
  if (c.env.ASSETS !== undefined && isConsolePage(c.req.raw)) {
    const page = await c.env.ASSETS.fetch(new URL(`${CONSOLE_BASE}/`, c.req.url));
    const headers = new Headers(page.headers);
    headers.set("Content-Security-Policy", "frame-ancestors 'none'");
    headers.set("X-Frame-Options", "DENY");
    return new Response(page.body, { status: page.status, headers });
  }
  return c.json({ error: { code: "not_found", message: "Nothing is served at this path." } } satisfies ErrorResponse, 404);
});

/** 5xx answers about the provider or the app's own setup, not a fault of the gateway. */
const NOT_OUR_FAULT: ReadonlySet<string> = new Set(["provider_error", "provider_not_configured", "provider_disabled"]);

function errorBody(error: GatewayError): ErrorResponse {
  return {
    error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) },
  };
}

/**
 * What a refusal's log line says about the request beyond its route: the app
 * the handler actually loaded (`loadRequestApp`), never the path's own
 * segment, which may name nothing registered, and the caller's app version
 * when it is shaped like one (`storedAppVersion`), as v1 logged them. Never a
 * body, a header value other than the version, or a credential.
 */
function requestFacts(c: Context<Env2>): { app?: string; appVersion?: string; ray?: string } {
  const facts: { app?: string; appVersion?: string; ray?: string } = {};
  // Cloudflare's id for the request, only when shaped like one: management analytics carries it too.
  const ray = requestIdOf(c.req.header("cf-ray"));
  if (ray !== null) facts.ray = ray;
  const app = loadedAppId(c.req.raw);
  if (app !== undefined) facts.app = app;
  const version = storedAppVersion(c.req.header("x-app-version"));
  if (version !== null) facts.appVersion = version;
  return facts;
}

app.onError((error, c: Context<Env2>) => {
  // A call that failed after its deadline already answered the client with a
  // 503. Its late failure is a diagnostic, not a gateway fault (as v1).
  const deadline = c.get("deadline") as AbortSignal | undefined;
  if (deadline?.aborted === true && error !== deadline.reason) {
    log("warn", "abandoned_call_failed", { path: c.req.routePath, error: errorFacts(error) });
    return c.body(null, 503);
  }
  const gateway = asGatewayError(error);
  if (gateway !== null) {
    if (gateway.status < 500 || NOT_OUR_FAULT.has(gateway.code)) {
      // Every refusal is logged once, without the message: it may echo a request value.
      log("warn", "gateway_error", {
        path: c.req.routePath,
        method: c.req.method,
        status: gateway.status,
        code: gateway.code,
        reason: gateway.reason ?? null,
        ...requestFacts(c),
      });
    } else {
      log(gateway.code === "service_unavailable" ? "warn" : "error", "request_failed", {
        path: c.req.routePath,
        method: c.req.method,
        ...requestFacts(c),
        code: gateway.code,
        reason: gateway.reason ?? null,
        error: errorFacts(gateway.cause ?? gateway),
      });
    }
    const headers = new Headers(gateway.headers);
    headers.set("content-type", "application/json; charset=UTF-8");
    return new Response(JSON.stringify(errorBody(gateway)), { status: gateway.status, headers });
  }
  log("error", "unhandled_error", { path: c.req.routePath, method: c.req.method, ...requestFacts(c), error: errorFacts(error) });
  return c.json(
    { error: { code: "internal_error", message: "The gateway failed to handle this request." } } satisfies ErrorResponse,
    500,
  );
});

export default {
  fetch: app.fetch,
  /**
   * Every minute: the sweep of open work. Hourly (the other cron): the
   * clean-up of expired App Attest challenges and sign-in records, and once a
   * day the nightly maintenance (`./maintenance/nightly.ts`).
   */
  async scheduled(controller, env, ctx) {
    if (controller.cron === SWEEP_CRON) {
      ctx.waitUntil(runSweep(env, { waitUntil: (work) => ctx.waitUntil(work) }).catch((error: unknown) => log("error", "sweep_failed", { error: errorFacts(error) })));
      return;
    }
    runHourly(env, controller.scheduledTime, (work) => ctx.waitUntil(work));
  },
} satisfies ExportedHandler<Env>;
