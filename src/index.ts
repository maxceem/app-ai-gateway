import { Hono } from "hono";
import type { BillingVariables } from "./billing/gateway";
import { AUTH_EVENT_RETENTION_DAYS, pruneAuthEvents } from "./core/auth-events";
import { GatewayError } from "./core/errors";
import { log } from "./core/log";
import { OrgQuota } from "./do/OrgQuota";
import { UserLimiter } from "./do/UserLimiter";
import { adminAuth, type AdminVariables } from "./middleware/admin";
import { gatewayAuth, type GatewayVariables } from "./middleware/auth";
import { quotaGate } from "./middleware/gate";
import { billingEntitlementGate } from "./middleware/billing";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { operatorAuthRoutes } from "./routes/operator-auth";
import { consoleRoutes } from "./routes/console";
import {
  endpointPrepare,
  endpointRoutes,
  type EndpointVariables,
} from "./routes/endpoints";
import { meRoutes } from "./routes/me";
import { proxyPrepare, proxyRoutes, type ProxyVariables } from "./routes/proxy";
import { vaultStatus } from "./vault";

export { OrgQuota, UserLimiter };

const app = new Hono<{
  Bindings: Env;
  Variables: GatewayVariables & AdminVariables & ProxyVariables & EndpointVariables & BillingVariables;
}>();

app.use("*", async (c, next) => {
  c.set("billingRequestCache", new Map());
  await next();
});

app.get("/v1/healthz", (c) => c.json({
  ok: true,
  service: "ai-gateway",
  vault: vaultStatus(c.env),
}));

app.route("/v1/auth", operatorAuthRoutes);
app.route("/v1/console", consoleRoutes);

app.use("/v1/apps/:app/*", billingEntitlementGate);
app.route("/v1/apps/:app/auth", authRoutes);

app.use("/v1/apps/:app/proxy/:provider/*", gatewayAuth, proxyPrepare, quotaGate);
app.route("/v1/apps/:app/proxy", proxyRoutes);

app.use("/v1/apps/:app/endpoints/:slug", gatewayAuth, endpointPrepare, quotaGate);
app.route("/v1/apps/:app/endpoints", endpointRoutes);

app.use("/v1/apps/:app/me", gatewayAuth);
app.route("/v1/apps/:app/me", meRoutes);

app.use("/v1/admin/*", adminAuth);
app.route("/v1/admin", adminRoutes);

app.notFound((c) => c.json({ error: { code: "invalid_request", message: "Route not found" } }, 404));

app.onError((error, c) => {
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=UTF-8");
  if (c.req.path.includes("/proxy/") || c.req.path.includes("/endpoints/")) {
    const auth = c.get("authDurationMs") ?? 0;
    const limiter = c.get("limiterDurationMs") ?? 0;
    headers.set(
      "server-timing",
      `auth;dur=${auth.toFixed(1)}, limiter;dur=${limiter.toFixed(1)}, provider_ttfb;dur=0.0`,
    );
  }
  if (error instanceof GatewayError) {
    new Headers(error.headers).forEach((value, name) => headers.set(name, value));
    // Every business rejection, exactly once, in one shape. Without this a user
    // refused on every attempt produced no server-side trace at all — the
    // response was returned and the reason went nowhere.
    //
    // Deliberately nothing else: no body, no token, no header but the client
    // version, because this line is emitted for authentication failures whose
    // request payload is a credential.
    log(error.status >= 500 ? "error" : "warn", "gateway_error", {
      code: error.code,
      // Undefined fields are dropped by JSON.stringify, so a rejection with no
      // granular cause simply has no `reason` key.
      reason: error.reason,
      status: error.status,
      path: c.req.path,
      method: c.req.method,
      app: c.req.param("app"),
      appVersion: c.req.header("x-app-version"),
    });
    return new Response(
      JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          // Present only where a code alone is not actionable, so clients that
          // ignore it keep reading exactly the body they read before.
          ...(error.data === undefined ? {} : { data: error.data }),
        },
      }),
      { status: error.status, headers },
    );
  }
  log("error", "unhandled_error", {
    path: c.req.path,
    method: c.req.method,
    error: error instanceof Error ? error.message : String(error),
  });
  return new Response(JSON.stringify({ error: { code: "internal_error", message: "Internal server error" } }), {
    status: 500,
    headers,
  });
});

/**
 * Retention for the authentication event log, and nothing else.
 *
 * Deliberately the only scheduled write this Worker performs: usage events are
 * accounting history, and no cron is ever allowed near them.
 */
async function prune(env: Env): Promise<void> {
  try {
    const deleted = await pruneAuthEvents(env);
    log("info", "auth_events_pruned", { deleted, retentionDays: AUTH_EVENT_RETENTION_DAYS });
  } catch (error) {
    log("error", "auth_events_prune_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The Hono app itself is the handler — `fetch` is one of its own properties, so
 * the cron entry point is attached beside it rather than wrapped around it. That
 * keeps `app.request()` available to the test suite, which is how every route
 * here is exercised.
 */
export default Object.assign(app, {
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(prune(env));
  },
});
