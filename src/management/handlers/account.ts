import { billingQuota, quotaUsage } from "../../billing/quota";
import type { CliCapabilitiesResponse } from "../../contracts/cli";
import { accountLifecycle } from "../../core/account-lifecycle";
import { SERVER_VERSION } from "../../core/version";
import { examplePath } from "../../shared/first-request";
import { GATEWAY_TYPES, gatewayDescriptor } from "../../shared/gateways";
import { providerCapability, providerDescriptor, PROVIDER_TYPES } from "../../shared/providers";
import { accountMonthUsage } from "../../usage/account-usage";
import { deploymentMeta } from "../deployment-meta";
import type { OperationHandlerTable } from "../executor";
import { currentMonth } from "../usage-queries";

export const accountHandlers = {
  getCliCapabilities: ({ scope }) => {
    const identity = deploymentMeta(scope.deployment);
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
  },

  getCliAccount: async ({ scope, actor }) => {
    const account = await accountLifecycle(scope.env, actor.organizationId);
    const quota = await billingQuota(scope.deployment, scope.env, account.id, scope.billingCache);
    const billing = { access: quota.access };
    // A plan with no monthly limit counts nothing, so there is no figure to report.
    const usage = await quotaUsage(scope.env, account.id, quota);
    return { deployment: deploymentMeta(scope.deployment), account, billing, usage };
  },

  getCliUsage: ({ scope, actor, query }) => {
    const month = query.month ?? currentMonth();
    return accountMonthUsage(scope.env.DB, actor.organizationId, month);
  },
} satisfies OperationHandlerTable;
