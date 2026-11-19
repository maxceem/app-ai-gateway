/**
 * The v2 gateway Worker.
 *
 * Everything it serves is under `/v2`, so it can run beside v1 on the same
 * hostnames, with a Worker route for `/v2` and `/v2/*` (plan section 9.1,
 * test T23). Anything it does not declare is answered with a JSON 404.
 *
 * It serves app sign-in, `/me` and provider requests
 * (`/v2/apps/{app}/proxy/{provider}/...`, outside the catalog because they
 * follow the provider descriptions) itself. The management API, people's
 * sign-in, the OAuth server and the console's pages are loaded on first use
 * (`./management/app.ts`), and so is the MCP endpoint (`./mcp/app.ts`). The
 * OAuth discovery documents live under `/.well-known/`, outside `/v2`.
 */
import { Hono, type Context } from "hono";
import { settleExpiredChallenges } from "./client-auth/auth-events.ts";
import { CLIENT_CATALOG, honoPath, type ClientOperationName, type ClientOperationResponse } from "./contracts/client-catalog.ts";
import type { ErrorResponse } from "./contracts/operation.ts";
import { errorFacts } from "./core/error-facts.ts";
import { GatewayError } from "./core/errors.ts";
import { log } from "./core/log.ts";
import { runSweep, SWEEP_CRON } from "./ledger/sweep.ts";
import { asGatewayError } from "./core/platform-errors.ts";
import { clientCallDeadline, type DeadlineVariables } from "./http/deadline.ts";
import { appAuthFloodLimit, challengeHandler, failureHandler, registerHandler, tokenHandler } from "./routes/auth.ts";
import { meHandler } from "./routes/me.ts";
import { proxyHandler } from "./proxy/serve.ts";
import { lazyRoutes } from "./http/lazy.ts";

export { EndUserLimiter } from "./do/EndUserLimiter.ts";
export { FloodLimiter } from "./do/FloodLimiter.ts";
export { ChargeStore } from "./do/ChargeStore.ts";
export { AppLimiter } from "./do/AppLimiter.ts";
export { AccountLimiter } from "./do/AccountLimiter.ts";

type Env2 = { Bindings: Env; Variables: DeadlineVariables };

/** Where the console's pages live. */
const CONSOLE_BASE = "/v2";

/**
 * The console's pages, below `/v2`, each with any path under it. Only these
 * get the console's document: any other unknown path, such as an API path
 * called with the wrong method or a missing file, stays a JSON 404. Add a
 * page here when the console gains one.
 */
const CONSOLE_PAGES = ["/login", "/signup", "/oauth/consent", "/device", "/access", "/settings"] as const;

/** A browser loading one of the console's pages, not a script calling the API. */
function isConsolePage(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const { pathname } = new URL(request.url);
  const page = CONSOLE_PAGES.some((path) => {
    const full = `${CONSOLE_BASE}${path}`;
    return pathname === full || pathname.startsWith(`${full}/`);
  });
  return page && (request.headers.get("accept") ?? "").includes("text/html");
}

const app = new Hono<Env2>();

/** A client operation's path in Hono's syntax. */
function routePath(name: ClientOperationName): string {
  return honoPath(CLIENT_CATALOG[name].path);
}

app.get(routePath("getHealth"), (c) =>
  c.json({ ok: true, service: "app-ai-gateway", api: "v2" } satisfies ClientOperationResponse<"getHealth">),
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
app.all("/v2/apps/:app/proxy/:provider/*", proxyHandler);

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
        status: gateway.status,
        code: gateway.code,
        reason: gateway.reason ?? null,
      });
    } else {
      log(gateway.code === "service_unavailable" ? "warn" : "error", "request_failed", {
        path: c.req.routePath,
        code: gateway.code,
        reason: gateway.reason ?? null,
        error: errorFacts(gateway.cause ?? gateway),
      });
    }
    const headers = new Headers(gateway.headers);
    headers.set("content-type", "application/json; charset=UTF-8");
    return new Response(JSON.stringify(errorBody(gateway)), { status: gateway.status, headers });
  }
  log("error", "unhandled_error", { path: c.req.routePath, error: errorFacts(error) });
  return c.json(
    { error: { code: "internal_error", message: "The gateway failed to handle this request." } } satisfies ErrorResponse,
    500,
  );
});

export default {
  fetch: app.fetch,
  /**
   * Every minute: the sweep of open work. Hourly (any other cron): record
   * expired, unused App Attest challenges as abandoned, and delete them; and
   * clean up expired OAuth approvals and ended OAuth connections' tokens.
   */
  async scheduled(controller, env, ctx) {
    if (controller.cron === SWEEP_CRON) {
      ctx.waitUntil(runSweep(env).catch((error: unknown) => log("error", "sweep_failed", { error: errorFacts(error) })));
      return;
    }
    ctx.waitUntil(
      settleExpiredChallenges(env.DB).then(
        (settled) => log("info", "auth_challenges_settled", settled),
        (error: unknown) => log("warn", "auth_challenges_prune_failed", { error: errorFacts(error) }),
      ),
    );
    ctx.waitUntil(
      import("./management/maintenance.ts")
        .then(({ sweepSignIn }) => sweepSignIn(env))
        .then(
          (swept) => log("info", "sign_in_swept", swept),
          (error: unknown) => log("warn", "sign_in_sweep_failed", { error: errorFacts(error) }),
        ),
    );
  },
} satisfies ExportedHandler<Env>;
