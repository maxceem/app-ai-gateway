import { Hono } from "hono";
import { ROUTE_NOT_FOUND } from "../core/errors";
import { rethrow } from "./lazy";
import { authRoutes } from "./auth";

/**
 * The application token exchange, mounted lazily by the entry module.
 *
 * Kept apart from `./management` because it is on the client path: every app
 * session starts here, so it must not drag better-auth and the operator identity
 * in behind it. What it does need — the zod request schemas and drizzle — is
 * still deferred past a proxied request, which never exchanges a token.
 */
export const appAuthRoutes = new Hono<{ Bindings: Env }>();

appAuthRoutes.route("/v1/apps/:app/auth", authRoutes);

appAuthRoutes.notFound((c) => c.json(ROUTE_NOT_FOUND, 404));

// Nothing to map here, so every error goes straight back to the outer app to be
// formatted and logged there.
appAuthRoutes.onError(rethrow);
