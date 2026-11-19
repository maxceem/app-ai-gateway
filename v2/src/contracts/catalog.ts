/**
 * Every v2 API operation, declared once.
 *
 * Each entry says its method, path, parameters, bodies and the text of the
 * published document. The OpenAPI document (`./openapi.ts`), the Worker's
 * routes, the console and the CLI all derive from it. Adding an endpoint means
 * adding an entry here and mounting its handler.
 *
 * Plain `zod`, never `@hono/zod-openapi`: the console and the CLI import this
 * module, and must not pull in Hono with it.
 *
 * Provider requests (`/v2/apps/{app}/proxy/{provider}/...`) are not listed
 * here. They follow the provider descriptions in `src/providers/`.
 */
import { z } from "zod";
import {
  ApiKeyTokenRequestSchema,
  AppAttestChallengeResponseSchema,
  AppAttestFailureReportResponseSchema,
  AppAttestFailureReportSchema,
  AppAttestRegisterRequestSchema,
  AppAttestRegisterResponseSchema,
  AppAttestTokenRequestSchema,
  CurrentUserResponseSchema,
  GatewayTokenResponseSchema,
} from "./auth.ts";
import {
  AppCreateRequestSchema,
  AppDeleteResponseSchema,
  AppKeyCreateRequestSchema,
  AppKeyListResponseSchema,
  AppKeyRevokeResponseSchema,
  AppListResponseSchema,
  AppResponseSchema,
  AppUpdateRequestSchema,
  CreatedAppKeySchema,
  CreatedAppResponseSchema,
  ProviderCreateRequestSchema,
  ProviderDeleteResponseSchema,
  ProviderListResponseSchema,
  ProviderResponseSchema,
  ProviderUpdateRequestSchema,
} from "./admin.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Which credential reaches an operation. `gateway` is an app key or a gateway
 * token, plus `X-AppAttest-Proof` where the app signs every request. The
 * document's security schemes are in `./openapi.ts`.
 */
export type SecurityKind = "public" | "gateway" | "management";

export interface OperationSpec {
  readonly method: HttpMethod;
  /** OpenAPI template, such as `/v2/apps/{app}`. The only place a path is written. */
  readonly path: `/v2/${string}`;
  /** Docs for each `{name}` in `path`. Every one is a required string. */
  readonly params?: Readonly<Record<string, { readonly description: string }>>;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly description?: string;
  readonly security: SecurityKind;
  readonly query?: z.ZodObject;
  readonly request?: z.ZodType;
  /** The success status, when it is not 200. */
  readonly status?: 201;
  readonly response: z.ZodType;
  readonly responseDescription: string;
  /** Error statuses this operation can answer with, and what each means. */
  readonly errors?: Readonly<Record<number, string>>;
}

/** Every error has this body. `code` is stable; `message` is for people. */
export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().meta({
        description:
          "Machine-readable facts about this refusal, present only where the code alone is not actionable. A rate_limited refusal carries scope, limit, windowSeconds, retryAfterSeconds and resetAt.",
      }),
    }),
  })
  .meta({ id: "ErrorResponse" });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const HealthResponseSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("app-ai-gateway"),
    api: z.literal("v2"),
  })
  .meta({ id: "HealthResponse" });

const APP_PARAM = { app: { description: "The app id." } } as const;

const PROVIDER_PARAM = { id: { description: "The provider connection id." } } as const;

/** Errors every management route can answer with. */
const ADMIN_ERRORS = {
  400: "The request is invalid.",
  401: "A valid management key is required.",
  403: "The key has only the read grant, or its owner is not an account owner or admin.",
  404: "The app, key or provider connection does not exist in this account.",
} as const;

/** Errors every app sign-in route can answer with. */
const SIGN_IN_ERRORS = {
  400: "The request is invalid.",
  403: "The app is disabled, or does not support this sign-in method.",
  404: "The app does not exist.",
  413: "The request body is too large.",
  429: "Too many sign-in calls to this app from this network address. Carries Retry-After.",
  503: "The gateway could not finish the check in time, or a platform service is briefly unavailable. Retry shortly.",
} as const;

const ISSUER_ERRORS = {
  403: "The proof or the issuer token was rejected, the challenge is invalid or used, the user is blocked, or the app does not support this sign-in method.",
  503: "The issuer's keys cannot be fetched, or the gateway could not finish the check in time. Retry shortly.",
} as const;

export const CATALOG = {
  getHealth: {
    method: "GET",
    path: "/v2/healthz",
    tags: ["Operations"],
    summary: "Check gateway health",
    security: "public",
    response: HealthResponseSchema,
    responseDescription: "The Worker is accepting requests.",
  },

  appAuthChallenge: {
    method: "POST",
    path: "/v2/apps/{app}/auth/challenge",
    params: APP_PARAM,
    tags: ["App sign-in"],
    summary: "Create an App Attest challenge",
    security: "public",
    response: AppAttestChallengeResponseSchema,
    responseDescription: "A five-minute, single-use challenge.",
    errors: SIGN_IN_ERRORS,
  },

  appAuthRegister: {
    method: "POST",
    path: "/v2/apps/{app}/auth/register",
    params: APP_PARAM,
    tags: ["App sign-in"],
    summary: "Register an App Attest key",
    security: "public",
    request: AppAttestRegisterRequestSchema,
    response: AppAttestRegisterResponseSchema,
    responseDescription: "The key was registered for the install, or for the issuer's user.",
    errors: { ...SIGN_IN_ERRORS, ...ISSUER_ERRORS },
  },

  appAuthFailure: {
    method: "POST",
    path: "/v2/apps/{app}/auth/failure",
    params: APP_PARAM,
    tags: ["App sign-in"],
    summary: "Report a failure on the device after a challenge",
    description:
      "Sent by the app when a step after the challenge failed on the device, so the app's auth events can say why. Diagnostic only. It must name a challenge this app issued that nothing has used yet, and uses it up, so one challenge carries at most one report.",
    security: "public",
    request: AppAttestFailureReportSchema,
    response: AppAttestFailureReportResponseSchema,
    responseDescription: "Whether a report was recorded for the challenge.",
    errors: SIGN_IN_ERRORS,
  },

  appAuthToken: {
    method: "POST",
    path: "/v2/apps/{app}/auth/token",
    params: APP_PARAM,
    tags: ["App sign-in"],
    summary: "Exchange a client proof for a gateway token",
    description:
      "App Attest clients send key_id, assertion and challenge; the answer's verify_on says whether requests sent with the token must also carry X-AppAttest-Proof. Server apps with an issuer send api_key and issuer_token. The verified issuer claim is always the user.",
    security: "public",
    request: z.union([AppAttestTokenRequestSchema, ApiKeyTokenRequestSchema]),
    response: GatewayTokenResponseSchema,
    responseDescription: "A gateway access token, valid for one hour.",
    errors: { ...SIGN_IN_ERRORS, ...ISSUER_ERRORS },
  },

  getCurrentUser: {
    method: "GET",
    path: "/v2/apps/{app}/me",
    params: APP_PARAM,
    tags: ["Application"],
    summary: "Get the current user",
    description:
      "Who the caller is. On App Attest apps, install_id names the install. Signed with X-AppAttest-Proof like every other request where the app signs every request.",
    security: "gateway",
    response: CurrentUserResponseSchema,
    responseDescription: "The caller's user id and install id.",
    errors: {
      401: "A valid app key or gateway token is required, or the request must carry X-AppAttest-Proof.",
      403: "The App Attest proof was rejected or replayed, or the app is disabled.",
      404: "The app does not exist, or identifies no end users.",
      503: "The gateway could not finish the check in time. Retry shortly.",
    },
  },
  listApps: {
    method: "GET",
    path: "/v2/admin/apps",
    tags: ["Admin applications"],
    summary: "List apps",
    security: "management",
    response: AppListResponseSchema,
    responseDescription: "Every app of the account.",
    errors: ADMIN_ERRORS,
  },

  createApp: {
    method: "POST",
    path: "/v2/admin/apps",
    tags: ["Admin applications"],
    summary: "Create an app",
    description:
      "Send `name`, `config` and an optional `status`. The gateway assigns the id: the name made URL-safe plus a random suffix. Every provider connection, operation and model the config names is checked, and a model with no price is refused with `pricing_not_configured`. An app-key app gets its first key, shown once as `api_key`.",
    security: "management",
    request: AppCreateRequestSchema,
    status: 201,
    response: CreatedAppResponseSchema,
    responseDescription: "The app, and its first key for an app-key app.",
    errors: ADMIN_ERRORS,
  },

  getApp: {
    method: "GET",
    path: "/v2/admin/apps/{app}",
    params: APP_PARAM,
    tags: ["Admin applications"],
    summary: "Get an app",
    security: "management",
    response: AppResponseSchema,
    responseDescription: "The app.",
    errors: ADMIN_ERRORS,
  },

  updateApp: {
    method: "PUT",
    path: "/v2/admin/apps/{app}",
    params: APP_PARAM,
    tags: ["Admin applications"],
    summary: "Update an app",
    description:
      "Needs `revision`, the one the app was read at: a stale one answers `409 app_revision_conflict`, a missing one `400 app_revision_required`. The config is checked as on create.",
    security: "management",
    request: AppUpdateRequestSchema,
    response: AppResponseSchema,
    responseDescription: "The updated app.",
    errors: { ...ADMIN_ERRORS, 409: "The app changed since it was read." },
  },

  deleteApp: {
    method: "DELETE",
    path: "/v2/admin/apps/{app}",
    params: APP_PARAM,
    tags: ["Admin applications"],
    summary: "Delete an app",
    description: "Pass `?confirm=<app-id>`. The app, its keys, end users and App Attest keys are deleted. Its usage history stays.",
    security: "management",
    query: z.object({ confirm: z.string() }),
    response: AppDeleteResponseSchema,
    responseDescription: "The app was deleted.",
    errors: ADMIN_ERRORS,
  },

  listAppKeys: {
    method: "GET",
    path: "/v2/admin/apps/{app}/keys",
    params: APP_PARAM,
    tags: ["Admin app keys"],
    summary: "List an app's keys",
    security: "management",
    response: AppKeyListResponseSchema,
    responseDescription: "The app's keys, without the keys themselves.",
    errors: ADMIN_ERRORS,
  },

  createAppKey: {
    method: "POST",
    path: "/v2/admin/apps/{app}/keys",
    params: APP_PARAM,
    tags: ["Admin app keys"],
    summary: "Create an app key",
    security: "management",
    request: AppKeyCreateRequestSchema,
    status: 201,
    response: CreatedAppKeySchema,
    responseDescription: "The new key, shown once.",
    errors: ADMIN_ERRORS,
  },

  revokeAppKey: {
    method: "POST",
    path: "/v2/admin/apps/{app}/keys/{key}/revoke",
    params: { ...APP_PARAM, key: { description: "The key id." } },
    tags: ["Admin app keys"],
    summary: "Revoke an app key",
    security: "management",
    response: AppKeyRevokeResponseSchema,
    responseDescription: "The revoked key.",
    errors: ADMIN_ERRORS,
  },

  listProviders: {
    method: "GET",
    path: "/v2/admin/providers",
    tags: ["Admin providers"],
    summary: "List provider connections",
    security: "management",
    response: ProviderListResponseSchema,
    responseDescription: "Every provider connection of the account, without keys.",
    errors: ADMIN_ERRORS,
  },

  createProvider: {
    method: "POST",
    path: "/v2/admin/providers",
    tags: ["Admin providers"],
    summary: "Create a provider connection",
    description:
      "Stores a provider key, sealed and write-only: only its hint is ever returned. The slug defaults to the type and is unique in the account. `baseUrl` sends the requests to another host (self-hosted servers, regional hosts, Azure OpenAI), priced from our list. `pricing` sets your own prices per model, in dollars per million units.",
    security: "management",
    request: ProviderCreateRequestSchema,
    status: 201,
    response: ProviderResponseSchema,
    responseDescription: "The provider connection.",
    errors: { ...ADMIN_ERRORS, 409: "The slug is already in use." },
  },

  getProvider: {
    method: "GET",
    path: "/v2/admin/providers/{id}",
    params: PROVIDER_PARAM,
    tags: ["Admin providers"],
    summary: "Get a provider connection",
    security: "management",
    response: ProviderResponseSchema,
    responseDescription: "The provider connection, without its key.",
    errors: ADMIN_ERRORS,
  },

  updateProvider: {
    method: "PUT",
    path: "/v2/admin/providers/{id}",
    params: PROVIDER_PARAM,
    tags: ["Admin providers"],
    summary: "Update, rotate or disable a provider connection",
    description:
      "Needs `revision`. A new non-null `baseUrl` needs `secret` in the same request: a stored key is never sent to a new origin. `baseUrl: null` returns to the provider's own origin. `status: disabled` pauses the connection and keeps its key and slug.",
    security: "management",
    request: ProviderUpdateRequestSchema,
    response: ProviderResponseSchema,
    responseDescription: "The updated provider connection.",
    errors: { ...ADMIN_ERRORS, 409: "The connection changed since it was read." },
  },

  deleteProvider: {
    method: "DELETE",
    path: "/v2/admin/providers/{id}",
    params: PROVIDER_PARAM,
    tags: ["Admin providers"],
    summary: "Delete a provider connection",
    description: "Deletes the connection and its key. Apps that use it start failing with provider_not_configured within a minute.",
    security: "management",
    response: ProviderDeleteResponseSchema,
    responseDescription: "The provider connection was deleted.",
    errors: ADMIN_ERRORS,
  },
} as const satisfies Readonly<Record<string, OperationSpec>>;

export type Catalog = typeof CATALOG;
export type OperationName = keyof Catalog;
export type OperationResponse<K extends OperationName> = z.output<Catalog[K]["response"]>;
