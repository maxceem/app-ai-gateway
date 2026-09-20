import {
  AUTHORIZATION_SWEEP_QUERIES,
  pruneExpiredAccounts,
  pruneExpiredAuthorizations,
} from "./core/account-lifecycle";
import { Hono, type MiddlewareHandler } from "hono";
import type { HealthResponse } from "./contracts/responses";
import { billingBinding, type BillingVariables } from "./billing/gateway";
import {
  AUTH_EVENT_RETENTION_DAYS,
  AUTH_SWEEP_QUERIES,
  pruneAuthChallenges,
  pruneAuthEvents,
} from "./core/auth-events";
import {
  MAINTENANCE_SLACK_QUERIES,
  maintenanceQueryBudget,
  type QueryBudget,
} from "./core/query-budget";
import { runUsageRetention } from "./core/usage-retention";
import { GatewayError, ROUTE_NOT_FOUND } from "./core/errors";
import { log } from "./core/log";
import { publicApiHost } from "./core/public-api-url";
import { storedAppVersion } from "./core/app-version";
import { OrgQuota } from "./do/OrgQuota";
import { UserLimiter } from "./do/UserLimiter";
import { EndpointRateLimiter } from "./do/EndpointRateLimiter";
import { gatewayAuth, type GatewayVariables } from "./middleware/auth";
import { quotaGate } from "./middleware/gate";
import { billingEntitlementGate } from "./middleware/billing";
import { billingRequestScope } from "./middleware/request-scope";
import { lazyRoutes } from "./routes/lazy";
import {
  endpointPrepare,
  endpointRoutes,
  type EndpointVariables,
} from "./routes/endpoints";
import { meRoutes } from "./routes/me";
import { proxyPrepare, proxyRoutes, type ProxyVariables } from "./routes/proxy";
import { vaultStatus } from "./vault";

export { EndpointRateLimiter, OrgQuota, UserLimiter };

type AppEnv = {
  Bindings: Env;
  Variables: GatewayVariables & ProxyVariables & EndpointVariables & BillingVariables;
};

const app = new Hono<AppEnv>();

app.use("*", billingRequestScope);

app.get("/v1/healthz", (c) => c.json({
  ok: true,
  service: "app-ai-gateway",
  vault: vaultStatus(c.env),
} satisfies HealthResponse));

/**
 * Keeps the operator surface off the host application clients call.
 *
 * A deployment may publish this Worker on a second custom domain named by
 * `PUBLIC_API_URL`. Operator authentication answers 404 there, so no operator
 * session cookie can ever be issued for that host, which makes every management
 * call arriving on it key-only by construction; the console API answers 404 for
 * the same reason. The console host is left alone and keeps serving the app
 * routes too, so clients configured before the second host still work.
 */
const consoleHostOnly: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const apiHost = publicApiHost(c.env);
  if (apiHost !== undefined && new URL(c.req.url).host === apiHost) {
    return c.json(ROUTE_NOT_FOUND, 404);
  }
  await next();
};

app.use("/v1/auth/*", consoleHostOnly);
app.use("/v1/console/*", consoleHostOnly);
app.use("/v1/cli/browser/*", consoleHostOnly);

/**
 * The management surface and the application token exchange are mounted as
 * whole apps behind a dynamic `import()`, so a proxied request never evaluates
 * better-auth, the operator identity or the zod contract schemas on a cold
 * isolate. See `./routes/lazy` for why the request is forwarded untouched and
 * how errors get back here.
 *
 * One bundle, four prefixes: the loader is memoised per `lazyRoutes` call, so
 * all four share a single evaluation of `./routes/management`. The wildcard
 * also matches the bare prefix, so `/v1/admin` reaches the same app as
 * `/v1/admin/apps`.
 */
const management = lazyRoutes<AppEnv>(
  () => import("./routes/management").then((module) => module.managementRoutes),
);

app.all("/v1/cli/*", management);
app.all("/v1/auth/*", management);
app.all("/v1/console/*", management);

app.use("/v1/apps/:app/*", billingEntitlementGate);
app.all(
  "/v1/apps/:app/auth/*",
  lazyRoutes<AppEnv>(
    () => import("./routes/app-auth").then((module) => module.appAuthRoutes),
  ),
);

app.use("/v1/apps/:app/proxy/:provider/*", gatewayAuth, proxyPrepare, quotaGate);
app.route("/v1/apps/:app/proxy", proxyRoutes);

app.use("/v1/apps/:app/endpoints/:slug", gatewayAuth, endpointPrepare, quotaGate);
app.route("/v1/apps/:app/endpoints", endpointRoutes);

app.use("/v1/apps/:app/me", gatewayAuth);
app.route("/v1/apps/:app/me", meRoutes);

/*
 * The two app-scoped patterns exist only so the error log below still names the
 * application. Hono binds `c.req.param()` from the pattern of the handler that
 * is running, and `onError` runs on that same context, so a failure under a
 * bare `/v1/admin/*` mount would log no `app` at all — where mounting the admin
 * routes statically used to register `/v1/admin/apps/:app/...` on this app and
 * fill it in. Nothing about routing changes: all three send the untouched
 * request to the same memoised handler, and the first match wins because it
 * answers without calling `next()`, so these must be registered first.
 */
app.all("/v1/admin/apps/:app", management);
app.all("/v1/admin/apps/:app/*", management);
app.all("/v1/admin/*", management);

app.notFound((c) => c.json(ROUTE_NOT_FOUND, 404));

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
      appVersion: storedAppVersion(c.req.header("x-app-version")) ?? undefined,
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
 * Nightly retention: the authentication event log, spent App Attest challenges,
 * expired CLI authorizations, expired unclaimed accounts, and the usage history.
 *
 * Usage events are accounting history, so they are summed into
 * `app_usage_rollup` before they are dropped and no total ever disappears —
 * unlike the diagnostic sweeps beside them, which simply delete. Every sweep
 * gets its own try/catch so a failure in one still leaves the others to run.
 *
 * All of them draw on one allowance, because what bounds them is not their own
 * cost but D1's shared per-invocation subrequest ceiling. It is spent in the
 * order written: the fixed-cost sweeps first, then account cleanup, then usage
 * retention with everything that is left. Account cleanup is offered at most
 * half of what remains at that point, so a large expired backlog cannot starve
 * compaction, and whatever it declines returns to the budget rather than being
 * wasted.
 */
async function prune(env: Env): Promise<void> {
  const budget = maintenanceQueryBudget(env);
  budget.remaining -= AUTH_SWEEP_QUERIES + MAINTENANCE_SLACK_QUERIES;
  try {
    const deleted = await pruneAuthEvents(env);
    log("info", "auth_events_pruned", { deleted, retentionDays: AUTH_EVENT_RETENTION_DAYS });
  } catch (error) {
    log("error", "auth_events_prune_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const deleted = await pruneAuthChallenges(env);
    log("info", "auth_challenges_pruned", { deleted });
  } catch (error) {
    log("error", "auth_challenges_prune_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  budget.remaining -= AUTHORIZATION_SWEEP_QUERIES;
  try {
    await pruneExpiredAuthorizations(env);
  } catch (error) {
    log("error", "authorizations_prune_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // Only a hosted deployment writes an account deadline, and only a hosted
  // deployment can have one to collect: a self-host's single account has no
  // `expires_at` at all, so running this there would spend a sixth of a Free
  // plan's nightly queries on a sweep that cannot match a row.
  if (billingBinding(env)) {
    const share: QueryBudget = { remaining: Math.floor(budget.remaining / 2) };
    const offered = share.remaining;
    try {
      const deleted = await pruneExpiredAccounts(env, share);
      if (deleted > 0) log("info", "expired_accounts_pruned", { deleted });
    } catch (error) {
      log("error", "expired_accounts_prune_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    budget.remaining -= offered - share.remaining;
  }
  // Reports under its own codes, and swallows its own failures for the same
  // reason the sweeps above do.
  await runUsageRetention(env, Date.now(), budget);
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
