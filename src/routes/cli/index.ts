import { accountMonthUsage } from "../../core/account-usage";
import { providerCapability } from "../../shared/capabilities";
import { browserGoogle } from "./oauth";
import { Hono } from "hono";
import { requireOrganization } from "@maxceem/cf-auth";
import { getBillingQuotaResolution } from "../../billing/quota";
import {
  assertAccountAccess,
} from "../../core/account-lifecycle";
import { GatewayError } from "../../core/errors";
import { PROVIDER_TYPES, PROVIDER_REGISTRY, type ProviderSpec } from "../../core/providers";
import { currentMonth } from "../admin/shared";
import { bootstrap, deployment } from "./bootstrap";
import { authState, createOperation, pollOperation } from "./operations";
import {
  browserDetails,
  browserSubmit,
  browserRegister,
} from "./browser";
import type { CliCapabilitiesResponse } from "../../contracts/cli";
import { SERVER_VERSION } from "../../core/version";
import type { CliEnv } from "./types";

export const cliRoutes = new Hono<CliEnv>();
cliRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});
cliRoutes.get("/capabilities", (c) => {
  const identity = deployment(c);
  const capabilities: CliCapabilitiesResponse = {
    protocolVersion: 1,
    serverVersion: SERVER_VERSION,
    deployment: identity,
    consoleOrigin: identity.consoleOrigin,
    providers: PROVIDER_TYPES.map((type) => {
      // Widened from the `as const` registry, so an optional field a single
      // entry omits is read as optional rather than as missing.
      const spec: ProviderSpec = PROVIDER_REGISTRY[type];
      const capability = providerCapability(type);
      return {
        type,
        name: type,
        apiStyles: [...capability.apiStyles],
        endpointStyles: [...capability.endpointStyles],
        baseUrl: spec.directBaseUrl,
        // Declared per provider in `PROVIDER_REGISTRY`; a type without one has
        // no obvious first call, and the CLI says so rather than guessing.
        ...(spec.defaultPath === undefined ? {} : { defaultPath: spec.defaultPath }),
      };
    }),
    providerGateways: [
      { type: "cf_aig", name: "Cloudflare AI Gateway" },
      { type: "vercel", name: "Vercel AI Gateway" },
    ],
  };
  return c.json(capabilities);
});
cliRoutes.post("/bootstrap", bootstrap);
cliRoutes.post("/operations", createOperation);
cliRoutes.get("/operations/:id", pollOperation);
cliRoutes.post("/browser/:id/details", browserDetails);
cliRoutes.post("/browser/:id/submit", browserSubmit);
cliRoutes.post("/browser/:id/register", browserRegister);
cliRoutes.post("/browser/:id/google", browserGoogle);
cliRoutes.get("/account", async (c) => {
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
  const usage = billing.period
    ? await (Date.parse(billing.period.periodEnd) <= Date.now()
        ? c.env.ORG_QUOTA.getByName(account.id).pastUsage(billing.period)
        : c.env.ORG_QUOTA.getByName(account.id).usage(billing.period))
    : null;
  return c.json({
    deployment: deployment(c),
    account,
    billing,
    usage,
  });
});
cliRoutes.get("/usage", async (c) => {
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
  return c.json(
    await accountMonthUsage(c.env.DB, resolved.organization.id, month),
  );
});
