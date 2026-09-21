import { accountMonthUsage } from "../../core/account-usage";
import { examplePath } from "../../shared/first-request";
import { browserGoogle } from "./oauth";
import { Hono } from "hono";
import { requireOrganization } from "@maxceem/cf-auth";
import { getBillingQuotaResolution } from "../../billing/quota";
import {
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { GatewayError } from "../../core/errors";
import {
  providerCapability,
  providerDescriptor,
  PROVIDER_TYPES,
} from "../../core/providers";
import { currentMonth } from "../admin/shared";
import { bootstrap, deployment } from "./bootstrap";
import { authState, createOperation, pollOperation } from "./operations";
import {
  browserDetails,
  browserSubmit,
  browserRegister,
} from "./browser";
import type { CliCapabilitiesResponse } from "../../contracts/cli";
import { catalogRouter } from "../catalog-router";
import { SERVER_VERSION } from "../../core/version";
import type { CliEnv } from "./types";

export const cliRoutes = new Hono<CliEnv>();
const routes = catalogRouter(cliRoutes, "/v1/cli");
cliRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});
routes.handle("getCliCapabilities", (c) => {
  const identity = deployment(c);
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
        name: type,
        apiStyles: [...capability.apiStyles],
        endpointStyles: [...capability.endpointStyles],
        baseUrl: descriptor.directBaseUrl,
        ...(defaultPath === undefined ? {} : { defaultPath }),
      };
    }),
    providerGateways: [
      { type: "cf_aig", name: "Cloudflare AI Gateway" },
      { type: "vercel", name: "Vercel AI Gateway" },
    ],
  };
  return capabilities;
});
routes.handle("bootstrapCliAccount", bootstrap);
routes.handle("createCliOperation", createOperation);
routes.handle("pollCliOperation", pollOperation);
routes.handle("cliBrowserDetails", browserDetails);
routes.handle("cliBrowserSubmit", browserSubmit);
/*
 * Two of the four browser endpoints relay Better Auth's own `Response` — its
 * status and its `Set-Cookie` are the answer, not merely its body — so they are
 * mounted rather than assembled. The path still comes from the catalog.
 */
routes.relay("cliBrowserRegister", browserRegister);
routes.relay("cliBrowserGoogle", browserGoogle);
routes.handle("getCliAccount", async (c) => {
  const state = await authState(c),
    resolved = requireOrganization(state);
  const account = await assertAccountAccess(
    c.env,
    resolved.organization.id,
    "read",
  );
  const billing = await getBillingQuotaResolution(
    c.env,
    account.id,
    c.get("billingRequestCache"),
  );
  const reading = billing.period
    ? await (Date.parse(billing.period.periodEnd) <= Date.now()
        ? c.env.ORG_QUOTA.getByName(account.id).pastUsage(billing.period)
        : c.env.ORG_QUOTA.getByName(account.id).usage(billing.period))
    : null;
  return {
    deployment: deployment(c),
    account,
    billing,
    // A count whose period was replaced while it was being read describes
    // nothing, and the marker saying so is internal, so it is reported as an
    // empty object — which is what every client has always reduced it to.
    usage: reading !== null && "superseded" in reading && reading.superseded ? {} : reading,
  };
});
routes.handle("getCliUsage", async (c) => {
  const state = await authState(c),
    resolved = requireOrganization(state);
  await assertAccountAccess(c.env, resolved.organization.id, "read");
  const month = c.req.query("month") ?? currentMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new GatewayError(
      400,
      "invalid_request",
      "month must use YYYY-MM format",
    );
  return accountMonthUsage(c.env.DB, resolved.organization.id, month);
});
