/**
 * `GET /v2/apps/{app}/me`: who the caller is.
 *
 * It runs the same checks as a provider request: the app key or gateway
 * token, the App Attest proof where the app signs every request, and the
 * replay check, which is never skipped. Step 1b adds the user's limits and
 * where they stand.
 *
 * Unlike v1, there is no hosted billing check here yet: that is management
 * side, and is ported with it.
 */
import type { Context } from "hono";
import { assertAppActive, loadApp } from "../apps/app-records.ts";
import { authenticateRequest } from "../client-auth/client-auth.ts";
import { useAssertionCounter } from "../client-auth/replay.ts";
import { appUserBlocked } from "../client-auth/user-status.ts";
import type { OperationResponse } from "../contracts/catalog.ts";
import { GatewayError } from "../core/errors.ts";
import { bodyOnce } from "../http/body.ts";
import type { DeadlineVariables } from "../http/deadline.ts";

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
  const blocked = await appUserBlocked(c.env.DB, app.id, identity.userId);
  return c.json({
    user_id: identity.userId,
    install_id: identity.installId,
    blocked,
  } satisfies OperationResponse<"getCurrentUser">);
}
