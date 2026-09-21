import { isCfAuthError } from "@maxceem/cf-auth";
import { Hono } from "hono";
import { asGatewayAuthError } from "../auth/identity";
import { ROUTE_NOT_FOUND } from "../core/errors";
import { adminAuth, type AdminVariables } from "../middleware/admin";
import { requestScope } from "../middleware/request-scope";
import { adminRoutes } from "./admin";
import { cliRoutes } from "./cli";
import { consoleRoutes } from "./console";
import { identityAuthRoutes } from "./identity-auth";

/**
 * The management surface — the operator console, the CLI and operator identity —
 * as one app the entry module mounts lazily through `./lazy`.
 *
 * It is a separate module precisely so that importing it is a decision a request
 * makes rather than something the isolate does on startup: this is where
 * better-auth, `@maxceem/cf-auth` and the zod contract schemas enter the bundle,
 * and none of them is on the path of a proxied request.
 *
 * Paths are absolute and identical to the ones the outer app publishes, because
 * `lazyRoutes` forwards the untouched request.
 */
export const managementRoutes = new Hono<{
  Bindings: Env;
  Variables: AdminVariables;
}>();

// This is an app of its own, with its own `Context`, so the request scope the
// entry module opens on the outer context is not visible here and has to be
// opened again: one deployment snapshot and one `Map` per management request.
managementRoutes.use("*", requestScope);

managementRoutes.use("/v1/admin/*", adminAuth);
managementRoutes.route("/v1/admin", adminRoutes);

managementRoutes.route("/v1/cli", cliRoutes);
managementRoutes.route("/v1/auth", identityAuthRoutes);
managementRoutes.route("/v1/console", consoleRoutes);

managementRoutes.notFound((c) => c.json(ROUTE_NOT_FOUND, 404));

/**
 * The one thing this app decides about an error: a cf-auth rejection becomes the
 * gateway's own error type. Everything after that — the status, the body, the
 * `server-timing` header and the log line — belongs to the entry module, so the
 * mapped error is rethrown and surfaces as a rejection of `fetch()`.
 */
managementRoutes.onError((error) => {
  throw isCfAuthError(error) ? asGatewayAuthError(error) : error;
});
