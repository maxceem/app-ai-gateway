import { accountMonthUsage } from "../../usage/account-usage";
import { examplePath } from "../../shared/first-request";
import { browserGoogle } from "./oauth";
import { Hono } from "hono";
import { billingQuota, quotaUsage } from "../../billing/quota";
import { accountLifecycle } from "../../core/account-lifecycle";
import { providerCapability, providerDescriptor, PROVIDER_TYPES } from "../../shared/providers";
import { GATEWAY_TYPES, gatewayDescriptor } from "../../shared/gateways";
import { currentMonth } from "../../management/usage-queries";
import { bootstrap } from "./bootstrap";
import { cliAuthenticate, createOperation, deploymentMeta, pollOperation } from "./operations";
import {
  assertConsoleOrigin,
  browserDeny,
  browserDetails,
  browserLookup,
  browserSubmit,
  browserRegister,
} from "./browser";
import { openLogin, redeemLogin, revokeCredential } from "./login";
import type { CliCapabilitiesResponse } from "../../contracts/cli";
import { catalogRouter } from "../catalog-router";
import { SERVER_VERSION } from "../../core/version";
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
routes.handle("getCliCapabilities", (c) => {
  const identity = deploymentMeta(c);
  const capabilities: CliCapabilitiesResponse = {
    protocolVersion: 1,
    serverVersion: SERVER_VERSION,
    deployment: identity,
    consoleOrigin: identity.consoleOrigin,
    providers: PROVIDER_TYPES.map((type) => {
      // Widened from the `as const` table, so an optional field a single entry
      // omits is read as optional rather than as missing.
      const descriptor = providerDescriptor(type);
      const capability = providerCapability(type);
      // The same path the console and the CLI write their examples against,
      // from `src/shared/first-request.ts`. A type without one — Gemini, whose
      // native surface needs the model in the path — publishes none rather
      // than a path no client could call as it stands.
      const defaultPath = examplePath(type);
      return {
        type,
        name: descriptor.label,
        apiStyles: [...capability.apiStyles],
        endpointStyles: [...capability.endpointStyles],
        baseUrl: descriptor.directBaseUrl,
        ...(defaultPath === undefined ? {} : { defaultPath }),
      };
    }),
    providerGateways: GATEWAY_TYPES.map((type) => ({ type, name: gatewayDescriptor(type).label })),
    features: { browserLogin: true },
  };
  return capabilities;
});
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
routes.handle("getCliAccount", async (c, { actor }) => {
  const account = await accountLifecycle(c.env, actor.organizationId);
  const quota = await billingQuota(
    c.get("deployment"),
    c.env,
    account.id,
    c.get("billingRequestCache"),
  );
  const billing = { access: quota.access };
  // A plan with no monthly limit counts nothing, so there is no figure to report.
  const usage = await quotaUsage(c.env, account.id, quota);
  return { deployment: deploymentMeta(c), account, billing, usage };
});
routes.handle("getCliUsage", async (c, { actor, query }) => {
  const month = query.month ?? currentMonth();
  return accountMonthUsage(c.env.DB, actor.organizationId, month);
});
