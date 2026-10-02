import { browserGoogle } from "./oauth";
import { Hono } from "hono";
import { bootstrap } from "./bootstrap";
import { cliAuthenticate, createOperation, pollOperation } from "./operations";
import {
  assertConsoleOrigin,
  browserDeny,
  browserDetails,
  browserLookup,
  browserSubmit,
  browserRegister,
} from "./browser";
import { openLogin, redeemLogin, revokeCredential } from "./login";
import { catalogRouter } from "../catalog-router";
import { cliJson } from "./security";
import type { CliEnv } from "./types";

export const cliRoutes = new Hono<CliEnv>();
// Authorizing, like the admin router: the CLI's management operations run
// their catalog policy, and only authenticate differently.
const routes = catalogRouter(cliRoutes, "/v1/cli", {
  authorized: true,
  authenticate: cliAuthenticate,
  // Bounded, because the bootstrap and the browser handoff are public.
  readBody: (c) => cliJson(c.req.raw),
});
cliRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});
routes.handle("getCliCapabilities");
routes.handle("bootstrapCliAccount", bootstrap);
routes.handle("openCliLogin", openLogin);
routes.handle("redeemCliLogin", redeemLogin);
routes.handle("revokeCliCredential", revokeCredential);
routes.handle("createCliOperation", createOperation);
routes.handle("pollCliOperation", pollOperation);
routes.handle("cliBrowserLookup", browserLookup, { before: assertConsoleOrigin });
routes.handle("cliBrowserDetails", browserDetails, { before: assertConsoleOrigin });
routes.handle("cliBrowserSubmit", browserSubmit, { before: assertConsoleOrigin });
routes.handle("cliBrowserDeny", browserDeny, { before: assertConsoleOrigin });
/*
 * Two of the browser endpoints relay Better Auth's own `Response` — its
 * status and its `Set-Cookie` are the answer, not merely its body — so they are
 * mounted rather than assembled. The path still comes from the catalog.
 */
routes.relay("cliBrowserRegister", browserRegister);
routes.relay("cliBrowserGoogle", browserGoogle);
routes.handle("getCliAccount");
routes.handle("getCliUsage");
