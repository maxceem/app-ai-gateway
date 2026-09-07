import { Hono } from "hono";
import { hasUserLevelLimits } from "../core/config";
import type { GatewayVariables } from "../middleware/auth";

export const meRoutes = new Hono<{ Bindings: Env; Variables: GatewayVariables }>();

meRoutes.get("/", async (c) => {
  const app = c.get("appConfig");
  const identity = c.get("identity");
  const perUser = app.limits.perUser;
  const status = await c.env.USER_LIMITER
    .getByName(`${app.id}:${identity.userId}`)
    .getStatus(Date.now());
  /*
   * Requests are only counted while a per-user limit is set: an app with none
   * never reaches the limiter on the request path, which is what keeps the
   * unlimited case free. Reporting the resulting zero as a day's traffic would
   * be a lie, so an uncounted day is `null` — unknown, not none.
   */
  const counted = hasUserLevelLimits(app);
  return c.json({
    user_id: identity.userId,
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
