import { Hono } from "hono";
import { budgetScope, countsPerInstall, hasUserLevelLimits } from "../shared/app-config";
import { appUserBlocked } from "../client-auth/user-status";
import type { CurrentUserResponse } from "../contracts/responses";
import { GatewayError } from "../core/errors";
import type { GatewayVariables } from "../middleware/auth";
import { monthlySpendMicrousd } from "../usage/app-usage-accounting";
import { recordRejectionEvent } from "../diagnostics/rejection-events";

export const meRoutes = new Hono<{ Bindings: Env; Variables: GatewayVariables }>();

meRoutes.get("/", async (c) => {
  const app = c.get("app");
  const identity = c.get("identity");
  /*
   * "Where do I stand" has no answer for a caller who is nobody. An application
   * that identifies no end users has no per-user limits to report and no ledger
   * to read, so this is a 404 rather than a body of nulls: the resource does not
   * exist here, which is different from existing and being empty.
   */
  const userId = identity.userId;
  if (userId === null) {
    throw new GatewayError(
      404,
      "auth_method_not_supported",
      "This application identifies no end users, so there is no per-user standing to report",
    );
  }
  const perUser = app.config.limits.per_user;
  const now = Date.now();
  // An App Attest caller is counted per install, and its budget measured over
  // the install's month unless the application moved it to the user's.
  const installId = countsPerInstall(app.config) ? identity.installId : null;
  const limiter = c.env.USER_LIMITER.getByName(
    installId === null ? `${app.id}:${userId}` : `${app.id}:install:${installId}`,
  );
  // A signed request spends its assertion counter here as anywhere else, so a
  // proof captured off this route is no more replayable than one off a proxy.
  const counter = c.get("assertionCounter");
  if (counter !== null && !(await limiter.advanceCounter(counter)).accepted) {
    // Sampled exactly as admission samples a replayed proxy request.
    c.executionCtx.waitUntil(recordRejectionEvent({
      env: c.env,
      identity,
      attribution: { providerSlug: null, model: null, route: "me" },
      endpointSlug: null,
      appVersion: c.req.header("x-app-version") ?? null,
      reason: "blocked_replay",
      scope: "install",
      latencyMs: Math.round(Date.now() - now),
    }));
    throw new GatewayError(403, "attest_failed", "App Attest assertion counter was replayed");
  }
  const spendKey = installId !== null && budgetScope(app.config) === "install"
    ? { appId: app.id, scope: "install" as const, key: installId }
    : { appId: app.id, scope: "user" as const, key: userId };
  const [status, spentMicrousd, blocked] = await Promise.all([
    limiter.getStatus(now),
    monthlySpendMicrousd(c.env.DB, spendKey, new Date(now).toISOString().slice(0, 7)),
    appUserBlocked(c.env.DB, app.id, userId),
  ]);
  /*
   * Requests are only counted while a per-user limit is set: an app with none
   * never reaches the limiter on the request path, which is what keeps the
   * unlimited case free. Reporting the resulting zero as a day's traffic would
   * be a lie, so an uncounted day is `null` — unknown, not none.
   */
  const counted = hasUserLevelLimits(app.config);
  return c.json({
    user_id: userId,
    install_id: installId,
    /*
     * The limits this app's operator set on this caller, and where the caller
     * stands against them. Nested rather than spread across the response
     * because they are one thing: the policy that applies to you.
     *
     * The organization's plan allowance is deliberately absent. That is the
     * organization's arrangement with the gateway, not its users' business; it
     * is reported on the rejection that spends it and on the billing page.
     */
    limits: {
      requests_today: counted ? status.requestsToday : null,
      requests_remaining: perUser.requests.per_day === null
        ? null
        : Math.max(0, perUser.requests.per_day - status.requestsToday),
      requests_per_minute: perUser.requests.per_minute,
      requests_per_day: perUser.requests.per_day,
      monthly_cost_usd: spentMicrousd / 1_000_000,
      monthly_budget_usd: perUser.spending.monthly_usd,
      blocked,
    },
  } satisfies CurrentUserResponse);
});
