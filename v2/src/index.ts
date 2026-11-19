/**
 * The v2 gateway Worker.
 *
 * Everything it serves is under `/v2`, so it can run beside v1 on the same
 * hostnames, with a Worker route for `/v2` and `/v2/*` (plan section 9.1,
 * test T23). Anything it does not declare is answered with a JSON 404.
 *
 * Step 1a part 2 added app sign-in and `/me`; part 3 adds provider requests
 * (`/v2/apps/{app}/proxy/{provider}/...`, outside the catalog because they
 * follow the provider descriptions) and the minimal management API.
 */
import { Hono, type Context } from "hono";
import { settleExpiredChallenges } from "./client-auth/auth-events.ts";
import { CATALOG, type ErrorResponse, type OperationName, type OperationResponse } from "./contracts/catalog.ts";
import { errorFacts } from "./core/error-facts.ts";
import { GatewayError } from "./core/errors.ts";
import { log } from "./core/log.ts";
import { runSweep, SWEEP_CRON } from "./ledger/sweep.ts";
import { asGatewayError } from "./core/platform-errors.ts";
import { clientCallDeadline, type DeadlineVariables } from "./http/deadline.ts";
import { appAuthFloodLimit, challengeHandler, failureHandler, registerHandler, tokenHandler } from "./routes/auth.ts";
import { meHandler } from "./routes/me.ts";
import { proxyHandler } from "./proxy/serve.ts";
import { adminAuth, type AdminVariables } from "./admin/actor.ts";
import { createApp, createAppKey, deleteApp, getApp, listAppKeys, listApps, revokeAppKey, updateApp } from "./admin/apps.ts";
import { createProvider, deleteProvider, getProvider, listProviders, updateProvider } from "./admin/providers.ts";

export { EndUserLimiter } from "./do/EndUserLimiter.ts";
export { FloodLimiter } from "./do/FloodLimiter.ts";
export { ChargeStore } from "./do/ChargeStore.ts";
export { AppLimiter } from "./do/AppLimiter.ts";
export { AccountLimiter } from "./do/AccountLimiter.ts";

type Env2 = { Bindings: Env; Variables: DeadlineVariables };

const app = new Hono<Env2>();

/** A catalog path in Hono's syntax: `{app}` becomes `:app`. */
function routePath(name: OperationName): string {
  return CATALOG[name].path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1");
}

app.get(routePath("getHealth"), (c) =>
  c.json({ ok: true, service: "app-ai-gateway", api: "v2" } satisfies OperationResponse<"getHealth">),
);

app.post(routePath("appAuthChallenge"), clientCallDeadline(), appAuthFloodLimit("app_auth_challenge"), challengeHandler);
app.post(routePath("appAuthRegister"), clientCallDeadline(), appAuthFloodLimit("app_auth_register"), registerHandler);
app.post(routePath("appAuthToken"), clientCallDeadline(), appAuthFloodLimit("app_auth_token"), tokenHandler);
app.post(routePath("appAuthFailure"), clientCallDeadline(), appAuthFloodLimit("app_auth_failure"), failureHandler);
app.get(routePath("getCurrentUser"), clientCallDeadline(), meHandler);

// The management API: management keys only for now (cf-auth 1.0 adds console
// sessions and OAuth in step 2).
const admin = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
admin.use("/v2/admin/*", adminAuth);
admin.get(routePath("listApps"), listApps);
admin.post(routePath("createApp"), createApp);
admin.get(routePath("getApp"), getApp);
admin.put(routePath("updateApp"), updateApp);
admin.delete(routePath("deleteApp"), deleteApp);
admin.get(routePath("listAppKeys"), listAppKeys);
admin.post(routePath("createAppKey"), createAppKey);
admin.post(routePath("revokeAppKey"), revokeAppKey);
admin.get(routePath("listProviders"), listProviders);
admin.post(routePath("createProvider"), createProvider);
admin.get(routePath("getProvider"), getProvider);
admin.put(routePath("updateProvider"), updateProvider);
admin.delete(routePath("deleteProvider"), deleteProvider);
app.route("/", admin);

// Provider requests. No deadline of their own: a provider may stream for minutes.
app.all("/v2/apps/:app/proxy/:provider/*", proxyHandler);

app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "Nothing is served at this path." } } satisfies ErrorResponse, 404),
);

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
   * expired, unused App Attest challenges as abandoned, and delete them.
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
  },
} satisfies ExportedHandler<Env>;
