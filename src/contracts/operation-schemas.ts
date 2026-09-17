/**
 * The runtime zod schema behind every descriptor in `./operations.ts`.
 *
 * Split out because the console must not gain zod: it imports the descriptors
 * for their types and their path builders, and never this module. The CLI does
 * import it, and parses every response it prints through the entry here.
 *
 * That parse is the CLI's secret-safety property, not merely a sanity check.
 * zod drops keys a schema does not declare, so a field the gateway adds — or a
 * field an unexpected error path leaks — cannot reach stdout until it is
 * written down as part of the contract. The CLI used to get the same guarantee
 * from a hand-maintained allow-list of field names, which had no way of knowing
 * which response it was filtering.
 *
 * The `satisfies` at the bottom is what keeps the two halves together: a
 * descriptor whose response type changes fails to typecheck here until its
 * schema changes with it.
 */
import { z } from "zod";
import {
  CliAccountResponseSchema,
  CliBootstrapResponseSchema,
  CliBrowserDetailsResponseSchema,
  CliBrowserGoogleResponseSchema,
  CliBrowserRegisterResponseSchema,
  CliBrowserSubmitResponseSchema,
  CliCapabilitiesResponseSchema,
  CliOperationResponseSchema,
  CliPollResponseSchema,
  CliUsageResponseSchema,
} from "./cli.ts";
import type { ResponseSchemaMap } from "./operations.ts";
import {
  ApiKeyListResponseSchema,
  ApiKeyRevokeResponseSchema,
  AppDeleteResponseSchema,
  AppListResponseSchema,
  AppResponseSchema,
  AppValidateResponseSchema,
  AuthEventListSchema,
  AuthEventSummarySchema,
  BreakdownResponseSchema,
  ConsoleCapabilitiesResponseSchema,
  CreatedApiKeySchema,
  CreatedAppResponseSchema,
  CreatedManagementKeyResponseSchema,
  IdentitySessionSchema,
  ManagementKeyListResponseSchema,
  ManagementKeyResponseSchema,
  MonthlyUsageResponseSchema,
  OrganizationListResponseSchema,
  PricesResponseSchema,
  ProviderDeleteResponseSchema,
  ProviderGatewayDeleteResponseSchema,
  ProviderGatewayListResponseSchema,
  ProviderGatewayResponseSchema,
  ProviderGatewayTestResponseSchema,
  ProviderListResponseSchema,
  ProviderResponseSchema,
  ProviderTestResponseSchema,
  TimeseriesResponseSchema,
  UsageEventListSchema,
  UserBlockResponseSchema,
  UserListResponseSchema,
} from "./responses.ts";

export const responseSchemas = {
  getConsoleCapabilities: ConsoleCapabilitiesResponseSchema,
  getAdminSession: IdentitySessionSchema,
  listOrganizations: OrganizationListResponseSchema,
  selectOrganization: IdentitySessionSchema,

  listManagementKeys: ManagementKeyListResponseSchema,
  createManagementKey: CreatedManagementKeyResponseSchema,
  revokeManagementKey: ManagementKeyResponseSchema,

  listProviders: ProviderListResponseSchema,
  createProvider: ProviderResponseSchema,
  testProvider: ProviderTestResponseSchema,
  updateProvider: ProviderResponseSchema,
  deleteProvider: ProviderDeleteResponseSchema,

  listProviderGateways: ProviderGatewayListResponseSchema,
  createProviderGateway: ProviderGatewayResponseSchema,
  testProviderGateway: ProviderGatewayTestResponseSchema,
  updateProviderGateway: ProviderGatewayResponseSchema,
  rotateProviderGateway: ProviderGatewayResponseSchema,
  deleteProviderGateway: ProviderGatewayDeleteResponseSchema,

  listApps: AppListResponseSchema,
  createApp: CreatedAppResponseSchema,
  getApp: AppResponseSchema,
  updateApp: AppResponseSchema,
  deleteApp: AppDeleteResponseSchema,
  validateApp: AppValidateResponseSchema,

  listAppKeys: ApiKeyListResponseSchema,
  createAppKey: CreatedApiKeySchema,
  revokeAppKey: ApiKeyRevokeResponseSchema,

  listAppUsers: UserListResponseSchema,
  setAppUserBlocked: UserBlockResponseSchema,

  getAppUsage: MonthlyUsageResponseSchema,
  getAppUsageTimeseries: TimeseriesResponseSchema,
  getAppUsageBreakdown: BreakdownResponseSchema,
  listAppEvents: UsageEventListSchema,
  getAppAuthEventSummary: AuthEventSummarySchema,
  listAppAuthEvents: AuthEventListSchema,
  listModelPrices: PricesResponseSchema,

  getCliCapabilities: CliCapabilitiesResponseSchema,
  bootstrapCliAccount: CliBootstrapResponseSchema,
  createCliOperation: CliOperationResponseSchema,
  pollCliOperation: CliPollResponseSchema,
  getCliAccount: CliAccountResponseSchema,
  getCliUsage: CliUsageResponseSchema,

  cliBrowserDetails: CliBrowserDetailsResponseSchema,
  cliBrowserSubmit: CliBrowserSubmitResponseSchema,
  cliBrowserRegister: CliBrowserRegisterResponseSchema,
  cliBrowserGoogle: CliBrowserGoogleResponseSchema,
} as const satisfies ResponseSchemaMap;

/**
 * The same map, widened to the mapped type. Indexing the literal above with a
 * generic operation name yields a union of schemas; indexing this yields the
 * one schema that operation's response type calls for, which is what a generic
 * `call(name, …)` transport needs.
 */
export const responseSchemaFor: ResponseSchemaMap = responseSchemas;

/** The envelope the CLI prints for a failure; see `cli/src/common.ts`. */
export const CliErrorDetailsSchema = z.object({
  status: z.number().optional(),
  appId: z.string().optional(),
  keyId: z.string().optional(),
  providerId: z.string().optional(),
  providerGatewayId: z.string().optional(),
  revoked: z.boolean().optional(),
  storagePath: z.string().optional(),
  /** Which ceiling refused the request, for the codes that name one. */
  scope: z.string().optional(),
  limit: z.number().optional(),
  used: z.number().optional(),
  windowSeconds: z.number().optional(),
  retryAfterSeconds: z.number().optional(),
  resetAt: z.string().optional(),
  id: z.string().optional(),
  state: z.string().optional(),
  expiresAt: z.string().optional(),
  url: z.string().optional(),
  /** The tail of a failed subprocess's own output, for failures it explains. */
  output: z.string().optional(),
  /**
   * What Cloudflare itself said about a refused API call: each error's message
   * and its code. Carried because the things that refuse a deployment — an
   * account ceiling, a permission a token lacks — are named only there, and
   * wrangler reports an API refusal it aggregates as the bare sentence that a
   * request failed.
   */
  apiErrors: z.string().optional(),
});
export type CliErrorDetails = z.infer<typeof CliErrorDetailsSchema>;
