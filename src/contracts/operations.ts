/**
 * Every admin and CLI endpoint the console or the CLI calls, as one descriptor
 * each: the method, a path builder, and the request and response types.
 *
 * This is the module both clients route through, so neither writes a URL or
 * names a response type by hand. It is deliberately runtime-light — the only
 * values here are strings and the functions that build them. Every schema
 * arrives through `import type`, so the console bundle gains no zod, no Hono
 * and no Worker code from importing it; the runtime schemas that back these
 * same descriptors live in `./operation-schemas.ts`, which only the CLI loads.
 */
import type { z } from "zod";
import type * as Cli from "./cli.ts";
import type * as Requests from "./schemas.ts";
import type * as Responses from "./responses.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * `requestType` and `responseType` are never assigned. They exist so that the
 * descriptor's *type* names both shapes: a transport declared as
 * `call(operation, params, body)` infers the body it must be given and the
 * value it returns straight from the entry it was handed.
 */
export interface ApiOperation<
  Params extends readonly unknown[] = readonly [],
  Body = undefined,
  Response = unknown,
> {
  readonly method: HttpMethod;
  readonly path: (...params: Params) => string;
  readonly requestType?: Body;
  readonly responseType?: Response;
}

export type AnyOperation = ApiOperation<never, never, unknown>;

export type OperationParams<O> = O extends { path: (...params: infer P) => string } ? P : never;
export type OperationRequest<O> = O extends { requestType?: infer B } ? B : never;
export type OperationResponse<O> = O extends { responseType?: infer R } ? R : never;

/** A `?a=1&b=2` suffix, or the empty string when nothing is set. */
export function searchSuffix(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

const seg = encodeURIComponent;

/**
 * Names the three type parameters at the definition site. Written as a curried
 * call so the request and response types can be given explicitly while the path
 * builder's parameters stay inferred.
 */
function operation<Body = undefined, Response = unknown>() {
  return <Params extends readonly unknown[]>(
    method: HttpMethod,
    path: (...params: Params) => string,
  ): ApiOperation<Params, Body, Response> => ({ method, path });
}

type AppUsageQuery = { month?: string };
type RangeQuery = { from?: string; to?: string };

export const operations = {
  // Deployment and identity
  getConsoleCapabilities: operation<undefined, Responses.ConsoleCapabilitiesResponse>()(
    "GET", () => "/v1/console/capabilities"),
  getAdminSession: operation<undefined, Responses.IdentitySession>()(
    "GET", () => "/v1/admin/session"),
  listOrganizations: operation<undefined, Responses.OrganizationListResponse>()(
    "GET", () => "/v1/admin/organizations"),
  selectOrganization: operation<Requests.OrganizationSelectRequest, Responses.IdentitySession>()(
    "POST", () => "/v1/admin/organizations/select"),

  // Management keys
  listManagementKeys: operation<undefined, Responses.ManagementKeyListResponse>()(
    "GET", () => "/v1/admin/keys"),
  createManagementKey: operation<{ name: string }, Responses.CreatedManagementKeyResponse>()(
    "POST", () => "/v1/admin/keys"),
  revokeManagementKey: operation<undefined, Responses.ManagementKeyResponse>()(
    "POST", (id: string) => `/v1/admin/keys/${seg(id)}/revoke`),

  // Providers
  listProviders: operation<undefined, Responses.ProviderListResponse>()(
    "GET", () => "/v1/admin/providers"),
  createProvider: operation<Requests.ProviderCreateRequest, Responses.ProviderResponse>()(
    "POST", () => "/v1/admin/providers"),
  testProvider: operation<Requests.ProviderTestRequest, Responses.ProviderTestResponse>()(
    "POST", () => "/v1/admin/providers/test"),
  updateProvider: operation<Requests.ProviderUpdateRequest, Responses.ProviderResponse>()(
    "PUT", (id: string) => `/v1/admin/providers/${seg(id)}`),
  deleteProvider: operation<undefined, Responses.ProviderDeleteResponse>()(
    "DELETE", (id: string) => `/v1/admin/providers/${seg(id)}`),

  // Provider gateways
  listProviderGateways: operation<undefined, Responses.ProviderGatewayListResponse>()(
    "GET", () => "/v1/admin/provider-gateways"),
  createProviderGateway: operation<
    Requests.ProviderGatewayCreateRequest, Responses.ProviderGatewayResponse
  >()("POST", () => "/v1/admin/provider-gateways"),
  testProviderGateway: operation<
    Requests.ProviderGatewayTestRequest, Responses.ProviderGatewayTestResponse
  >()("POST", () => "/v1/admin/provider-gateways/test"),
  updateProviderGateway: operation<
    Requests.ProviderGatewayUpdateRequest, Responses.ProviderGatewayResponse
  >()("PATCH", (id: string) => `/v1/admin/provider-gateways/${seg(id)}`),
  rotateProviderGateway: operation<
    Requests.ProviderGatewayRotateRequest, Responses.ProviderGatewayResponse
  >()("POST", (id: string) => `/v1/admin/provider-gateways/${seg(id)}/rotate`),
  deleteProviderGateway: operation<undefined, Responses.ProviderGatewayDeleteResponse>()(
    "DELETE", (id: string) => `/v1/admin/provider-gateways/${seg(id)}`),

  // Applications
  listApps: operation<undefined, Responses.AppListResponse>()(
    "GET", (query: AppUsageQuery = {}) => `/v1/admin/apps${searchSuffix(query)}`),
  createApp: operation<Requests.AppWrite, Responses.CreatedAppResponse>()(
    "POST", () => "/v1/admin/apps"),
  getApp: operation<undefined, Responses.AppResponse>()(
    "GET", (appId: string) => `/v1/admin/apps/${seg(appId)}`),
  updateApp: operation<Requests.AppUpdate, Responses.AppResponse>()(
    "PUT", (appId: string) => `/v1/admin/apps/${seg(appId)}`),
  deleteApp: operation<undefined, Responses.AppDeleteResponse>()(
    "DELETE", (appId: string) => `/v1/admin/apps/${seg(appId)}${searchSuffix({ confirm: appId })}`),
  validateApp: operation<Requests.AppWrite, Responses.AppValidateResponse>()(
    "POST", (appId: string) => `/v1/admin/apps/${seg(appId)}/validate`),

  // Application keys
  listAppKeys: operation<undefined, Responses.ApiKeyListResponse>()(
    "GET", (appId: string) => `/v1/admin/apps/${seg(appId)}/keys`),
  createAppKey: operation<{ name: string }, Responses.CreatedApiKey>()(
    "POST", (appId: string) => `/v1/admin/apps/${seg(appId)}/keys`),
  revokeAppKey: operation<undefined, Responses.ApiKeyRevokeResponse>()(
    "POST", (appId: string, keyId: string) =>
      `/v1/admin/apps/${seg(appId)}/keys/${seg(keyId)}/revoke`),

  // Application users
  listAppUsers: operation<undefined, Responses.UserListResponse>()(
    "GET", (appId: string, query: {
      month: string; query?: string; status?: "active" | "blocked"; limit?: number; offset?: number;
    }) => `/v1/admin/apps/${seg(appId)}/users${searchSuffix(query)}`),
  setAppUserBlocked: operation<undefined, Responses.UserBlockResponse>()(
    "POST", (appId: string, userId: string, blocked: boolean) =>
      `/v1/admin/apps/${seg(appId)}/users/${seg(userId)}/${blocked ? "block" : "unblock"}`),

  // Application usage
  getAppUsage: operation<undefined, Responses.MonthlyUsageResponse>()(
    "GET", (appId: string, query: AppUsageQuery = {}) =>
      `/v1/admin/apps/${seg(appId)}/usage${searchSuffix(query)}`),
  getAppUsageTimeseries: operation<undefined, Responses.TimeseriesResponse>()(
    "GET", (appId: string, query: RangeQuery) =>
      `/v1/admin/apps/${seg(appId)}/usage/timeseries${searchSuffix(query)}`),
  getAppUsageBreakdown: operation<undefined, Responses.BreakdownResponse>()(
    "GET", (appId: string, query: RangeQuery & { by?: string; limit?: number }) =>
      `/v1/admin/apps/${seg(appId)}/usage/breakdown${searchSuffix(query)}`),
  listAppEvents: operation<undefined, Responses.UsageEventList>()(
    "GET", (appId: string, query: Record<string, string | number | undefined>) =>
      `/v1/admin/apps/${seg(appId)}/events${searchSuffix(query)}`),
  getAppAuthEventSummary: operation<undefined, Responses.AuthEventSummary>()(
    "GET", (appId: string, query: { days?: number }) =>
      `/v1/admin/apps/${seg(appId)}/auth-events/summary${searchSuffix(query)}`),
  listAppAuthEvents: operation<undefined, Responses.AuthEventList>()(
    "GET", (appId: string, query: Record<string, string | number | undefined>) =>
      `/v1/admin/apps/${seg(appId)}/auth-events${searchSuffix(query)}`),

  listModelPrices: operation<undefined, Responses.PricesResponse>()(
    "GET", () => "/v1/admin/prices"),

  // CLI surface
  getCliCapabilities: operation<undefined, Cli.CliCapabilitiesResponse>()(
    "GET", () => "/v1/cli/capabilities"),
  bootstrapCliAccount: operation<Cli.CliBootstrapRequest, Cli.CliBootstrapResponse>()(
    "POST", () => "/v1/cli/bootstrap"),
  createCliOperation: operation<Cli.CliOperationRequest, Cli.CliOperationResponse>()(
    "POST", () => "/v1/cli/operations"),
  pollCliOperation: operation<undefined, Cli.CliPollResponse>()(
    "GET", (id: string) => `/v1/cli/operations/${seg(id)}`),
  getCliAccount: operation<undefined, Cli.CliAccountResponse>()(
    "GET", () => "/v1/cli/account"),
  getCliUsage: operation<undefined, Cli.CliUsageResponse>()(
    "GET", (query: { month?: string } = {}) => `/v1/cli/usage${searchSuffix(query)}`),

  /*
   * The browser half of a handoff, called by the console's approval page rather
   * than by the CLI. Every one of them carries the submission proof from the
   * URL fragment in its body, so they are POSTs with no readable URL of their
   * own; routing them through here is what keeps the page from writing those
   * paths by hand.
   */
  cliBrowserDetails: operation<Cli.CliSubmissionRequest, Cli.CliBrowserDetailsResponse>()(
    "POST", (id: string) => `/v1/cli/browser/${seg(id)}/details`),
  cliBrowserSubmit: operation<Cli.CliSubmissionRequest, Cli.CliBrowserSubmitResponse>()(
    "POST", (id: string) => `/v1/cli/browser/${seg(id)}/submit`),
  cliBrowserRegister: operation<Cli.CliSubmissionRequest, Cli.CliBrowserRegisterResponse>()(
    "POST", (id: string) => `/v1/cli/browser/${seg(id)}/register`),
  cliBrowserGoogle: operation<Cli.CliSubmissionRequest, Cli.CliBrowserGoogleResponse>()(
    "POST", (id: string) => `/v1/cli/browser/${seg(id)}/google`),
} as const;

export type OperationName = keyof typeof operations;

/**
 * The runtime schema map in `./operation-schemas.ts` is checked against this,
 * so a descriptor whose response type changes cannot keep an old parser.
 */
export type ResponseSchemaMap = {
  [K in OperationName]: z.ZodType<OperationResponse<(typeof operations)[K]>>;
};
