import { Hono } from "hono";
import { hasUserLevelLimits } from "../core/config";
import { GatewayError } from "../core/errors";
import type { GatewayVariables } from "../middleware/auth";

export const meRoutes = new Hono<{ Bindings: Env; Variables: GatewayVariables }>();

meRoutes.get("/", async (c) => {
  const app = c.get("appConfig");
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
  const perUser = app.limits.perUser;
  const status = await c.env.USER_LIMITER
    .getByName(`${app.id}:${userId}`)
    .getStatus(Date.now());
  /*
   * Requests are only counted while a per-user limit is set: an app with none
   * never reaches the limiter on the request path, which is what keeps the
   * unlimited case free. Reporting the resulting zero as a day's traffic would
   * be a lie, so an uncounted day is `null` — unknown, not none.
   */
  const counted = hasUserLevelLimits(app);
  return c.json({
    user_id: userId,
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
      requests_remaining: perUser.requestsPerDay === null
        ? null
        : Math.max(0, perUser.requestsPerDay - status.requestsToday),
      requests_per_minute: perUser.requestsPerMinute,
      requests_per_day: perUser.requestsPerDay,
      monthly_cost_usd: status.monthlyCostMicrousd / 1_000_000,
      monthly_budget_usd: perUser.monthlyBudgetMicrousd === null
        ? null
        : perUser.monthlyBudgetMicrousd / 1_000_000,
      blocked: status.blocked,
    },
  });
});
