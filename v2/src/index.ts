/**
 * The v2 gateway Worker.
 *
 * Everything it serves is under `/v2`, so it can run beside v1 on the same
 * hostnames, with a Worker route for `/v2` and `/v2/*` (plan section 9.1,
 * test T23). Anything it does not declare is answered with a JSON 404.
 *
 * Step 1a part 2 adds app sign-in and `/me`. Provider requests and the
 * management API are mounted by the steps that build them.
 */
import { Hono, type Context } from "hono";
import { settleExpiredChallenges } from "./client-auth/auth-events.ts";
import { CATALOG, type ErrorResponse, type OperationName, type OperationResponse } from "./contracts/catalog.ts";
import { errorFacts } from "./core/error-facts.ts";
import { GatewayError } from "./core/errors.ts";
import { log } from "./core/log.ts";
import { asGatewayError } from "./core/platform-errors.ts";
import { clientCallDeadline, type DeadlineVariables } from "./http/deadline.ts";
import { appAuthFloodLimit, challengeHandler, failureHandler, registerHandler, tokenHandler } from "./routes/auth.ts";
import { meHandler } from "./routes/me.ts";

export { EndUserLimiter } from "./do/EndUserLimiter.ts";
export { FloodLimiter } from "./do/FloodLimiter.ts";

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

app.notFound((c) =>
  c.json({ error: { code: "not_found", message: "Nothing is served at this path." } } satisfies ErrorResponse, 404),
);

function errorBody(error: GatewayError): ErrorResponse {
  return { error: { code: error.code, message: error.message } };
}

app.onError((error, c: Context<Env2>) => {
  const gateway = asGatewayError(error);
  if (gateway !== null) {
    if (gateway.status >= 500) {
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
  /** Hourly: record expired, unused App Attest challenges as abandoned, and delete them. */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      settleExpiredChallenges(env.DB).then(
        (settled) => log("info", "auth_challenges_settled", settled),
        (error: unknown) => log("warn", "auth_challenges_prune_failed", { error: errorFacts(error) }),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
