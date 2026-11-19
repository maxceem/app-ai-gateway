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
  AppCheckResponseSchema,
  AppDraftValidateResponseSchema,
  AppPatchRequestSchema,
  AppValidateRequestSchema,
  AppValidateResponseSchema,
  CreatedAppKeySchema,
  CreatedAppResponseSchema,
  EndUserBlockResponseSchema,
  EndUserListQuerySchema,
  EndUserListResponseSchema,
  EndUserQuerySchema,
  EndUserResponseSchema,
  PriceListResponseSchema,
  ProviderCreateRequestSchema,
  ProviderDeleteResponseSchema,
  ProviderListResponseSchema,
  ProviderResponseSchema,
  ProviderTestRequestSchema,
  ProviderTestResponseSchema,
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

const USER_PARAMS = { app: { description: "The app id." }, user: { description: "The end user id." } } as const;

/** Errors a create can answer with when the account's plan sets a ceiling. */
const PLAN_CAP_ERRORS = {
  402: "No plan is available for this account.",
  409: "The plan's ceiling on this resource is reached (`billing_plan_limit_reached`, with `limit` and `used`).",
  503: "Billing could not be reached, so nothing was saved. Retry shortly.",
} as const;

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
    errors: { ...ADMIN_ERRORS, ...PLAN_CAP_ERRORS },
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

  patchApp: {
    method: "PATCH",
    path: "/v2/admin/apps/{app}",
    params: APP_PARAM,
    tags: ["Admin applications"],
    summary: "Change part of an app",
    description:
      "Applies `operations` in order to the app as `getApp` answers it, then saves the result exactly as `PUT` would: the same checks, the same errors, and nothing written unless every operation applies and the result is accepted. Each operation is RFC 6902 `add`, `replace` or `remove` at a JSON Pointer under `/name`, `/status` or `/config`, for example `{\"op\": \"replace\", \"path\": \"/config/limits/per_app/requests/per_minute\", \"value\": 600}`. A value is written as given: `null` sets a limit to unlimited, and only `remove` deletes. Needs `revision`, as `PUT` does. An operation that cannot apply answers `400 invalid_request` naming its index.",
    security: "management",
    request: AppPatchRequestSchema,
    response: AppResponseSchema,
    responseDescription: "The app after the change.",
    errors: { ...ADMIN_ERRORS, 409: "The app changed since it was read." },
  },

  validateApp: {
    method: "POST",
    path: "/v2/admin/apps/{app}/validate",
    params: APP_PARAM,
    tags: ["Admin applications"],
    summary: "Check an edit of an app without saving it",
    description:
      "Judged as an update of this app would be. After a provider connection is deleted, an edit may keep that connection's routing entry only if the entry is unchanged; an added or changed entry for it is refused. Needs only the read grant: nothing is saved.",
    security: "management",
    request: AppValidateRequestSchema,
    response: AppValidateResponseSchema,
    responseDescription: "The edit would be accepted.",
    errors: ADMIN_ERRORS,
  },

  validateAppDraft: {
    method: "POST",
    path: "/v2/admin/app-drafts/validate",
    tags: ["Admin applications"],
    summary: "Check a new app's settings without saving them",
    description: "Judged as a create would be, against the account's current provider connections and prices. Needs only the read grant.",
    security: "management",
    request: AppValidateRequestSchema,
    response: AppDraftValidateResponseSchema,
    responseDescription: "The settings would be accepted.",
    errors: ADMIN_ERRORS,
  },

  checkApp: {
    method: "GET",
    path: "/v2/admin/apps/{app}/check",
    params: APP_PARAM,
    tags: ["Admin applications"],
    summary: "Check whether an app is ready to serve requests",
    description:
      "Checks the stored config as an update would, lists every provider connection its routing names with its status (a disabled one as disabled, a deleted one as missing), and answers `ready` when the app is active and at least one of them is active. It sends no provider request, and `limitations` says what it did not try. A stored config that would no longer be accepted answers `400` with the reason.",
    security: "management",
    response: AppCheckResponseSchema,
    responseDescription: "What the check found, and what it did not try.",
    errors: ADMIN_ERRORS,
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
    errors: { ...ADMIN_ERRORS, ...PLAN_CAP_ERRORS },
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

  listAppUsers: {
    method: "GET",
    path: "/v2/admin/apps/{app}/users",
    params: APP_PARAM,
    tags: ["Admin end users"],
    summary: "List an app's end users",
    description:
      "Users that sign-in recorded, plus user ids that only the app's charges or refusals name (`is_virtual`, such as a server app's end-user header). Most recently seen first, with each user's usage in `month`.",
    security: "management",
    query: EndUserListQuerySchema,
    response: EndUserListResponseSchema,
    responseDescription: "One page of end users.",
    errors: ADMIN_ERRORS,
  },

  getAppUser: {
    method: "GET",
    path: "/v2/admin/apps/{app}/users/{user}",
    params: USER_PARAMS,
    tags: ["Admin end users"],
    summary: "Get an end user",
    security: "management",
    query: EndUserQuerySchema,
    response: EndUserResponseSchema,
    responseDescription: "The end user, with their usage in `month`.",
    errors: ADMIN_ERRORS,
  },

  blockAppUser: {
    method: "POST",
    path: "/v2/admin/apps/{app}/users/{user}/block",
    params: USER_PARAMS,
    tags: ["Admin end users"],
    summary: "Block an end user",
    description:
      "Refuses the user's sign-in and requests, and stops their live sessions at the next checkpoint. Takes effect within ten seconds everywhere. A virtual user has no row and answers 404.",
    security: "management",
    response: EndUserBlockResponseSchema,
    responseDescription: "The user's new block state.",
    errors: ADMIN_ERRORS,
  },

  unblockAppUser: {
    method: "POST",
    path: "/v2/admin/apps/{app}/users/{user}/unblock",
    params: USER_PARAMS,
    tags: ["Admin end users"],
    summary: "Unblock an end user",
    security: "management",
    response: EndUserBlockResponseSchema,
    responseDescription: "The user's new block state.",
    errors: ADMIN_ERRORS,
  },

  listModelPrices: {
    method: "GET",
    path: "/v2/admin/prices",
    tags: ["Admin models"],
    summary: "List model prices",
    description:
      "Our price list, in dollars per million units, by provider type and model. A model the provider no longer lists keeps its price, marked `unlisted_since`.",
    security: "management",
    response: PriceListResponseSchema,
    responseDescription: "The price list this deployment bills with.",
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
    errors: {
      ...ADMIN_ERRORS,
      ...PLAN_CAP_ERRORS,
      409: "The slug is already in use, or the plan's ceiling on provider connections is reached (`billing_plan_limit_reached`).",
    },
  },

  testProvider: {
    method: "POST",
    path: "/v2/admin/providers/test",
    tags: ["Admin providers"],
    summary: "Test a provider key without saving it",
    description:
      "Sends the provider one free request that needs a valid key, to the same host live requests would use, and reports what it answered. Nothing is stored, and saving a connection never runs this test. Only `rejected` says the key is wrong.",
    security: "management",
    request: ProviderTestRequestSchema,
    response: ProviderTestResponseSchema,
    responseDescription: "What the test found.",
    errors: ADMIN_ERRORS,
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
