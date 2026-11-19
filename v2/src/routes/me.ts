/**
 * `GET /v2/apps/{app}/me`: who the caller is, the limits the app sets on them,
 * and where they stand (v1's fields).
 *
 * It runs the same checks as a provider request: the app key or gateway
 * token, the App Attest proof where the app signs every request, and the
 * replay check, which is never skipped.
 *
 * Unlike v1, there is no hosted billing check here yet: that is management
 * side, and is ported with it.
 */
import type { Context } from "hono";
import { assertAppActive, loadApp } from "../apps/app-records.ts";
import { authenticateRequest } from "../client-auth/client-auth.ts";
import { useAssertionCounter } from "../client-auth/replay.ts";
import { appUserBlocked } from "../client-auth/user-status.ts";
import { scopeHasLimits } from "../contracts/app-config.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { GatewayError } from "../core/errors.ts";
import { bodyOnce } from "../http/body.ts";
import type { DeadlineVariables } from "../http/deadline.ts";
import { endUserCaller } from "../limits/admission.ts";
import { monthlySpendNano } from "../limits/spend.ts";
import { NANO_PER_DOLLAR } from "../money.ts";

export async function meHandler(c: Context<{ Bindings: Env; Variables: DeadlineVariables }>): Promise<Response> {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadApp(c.env, appId);
  assertAppActive(app);
  const { identity, assertionCounter } = await authenticateRequest({
    env: c.env,
    app,
    request: c.req.raw,
    body: bodyOnce(c.req.raw),
  });
  if (identity.userId === null) {
    throw new GatewayError(
      404,
      "auth_method_not_supported",
      "This application identifies no end users, so there is no per-user standing to report",
    );
  }
  if (assertionCounter !== null && identity.installId !== null) {
    await useAssertionCounter(c.env, app.id, identity.installId, assertionCounter);
  }
  const caller = endUserCaller(app, identity)!;
  const perUser = app.limits.per_user;
  // Requests are counted only while a per-user limit is set, so an uncounted
  // day is `null` (unknown), not zero.
  const counted = scopeHasLimits(perUser);
  const now = Date.now();
  const [requestsToday, spentNano, blocked] = await Promise.all([
    counted ? c.env.END_USER_LIMITER.getByName(caller.name).requestsToday(now) : Promise.resolve(null),
    monthlySpendNano(c.env.DB, caller.spend, now),
    appUserBlocked(c.env.DB, app.id, identity.userId),
  ]);
  const budget = perUser.spending.monthly_nano;
  return c.json({
    user_id: identity.userId,
    install_id: identity.installId,
    limits: {
      requests_today: requestsToday,
      requests_remaining:
        perUser.requests.per_day === null ? null : Math.max(0, perUser.requests.per_day - (requestsToday ?? 0)),
      requests_per_minute: perUser.requests.per_minute,
      requests_per_day: perUser.requests.per_day,
      // Dollars at the edge, as v1 sends them: apps and the Swift SDK read these.
      monthly_cost_usd: spentNano / NANO_PER_DOLLAR,
      monthly_budget_usd: budget === null ? null : budget / NANO_PER_DOLLAR,
      budget_scope: caller.spend.scope,
      blocked,
    },
  } satisfies OperationResponse<"getCurrentUser">);
}
