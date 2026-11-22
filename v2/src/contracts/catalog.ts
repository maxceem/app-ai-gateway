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
  JobListQuerySchema,
  ConversationFileListSchema,
  ConversationFileQuerySchema,
  ConversationListQuerySchema,
  JobListResponseSchema,
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
import {
  AccountListResponseSchema,
  AccountSelectRequestSchema,
  AdminSessionResponseSchema,
  ConsentAllowRequestSchema,
  ConsentDetailsResponseSchema,
  ConsentProofSchema,
  ConsentRedirectResponseSchema,
  ConsoleCapabilitiesSchema,
  CreatedManagementKeyResponseSchema,
  CredentialListResponseSchema,
  CredentialResponseSchema,
  DeviceAnswerResponseSchema,
  DeviceApproveRequestSchema,
  DeviceCodeRequestSchema,
  DeviceDetailsResponseSchema,
  DeviceLookupRequestSchema,
  DeviceLookupResponseSchema,
  ManagementKeyCreateRequestSchema,
} from "./access.ts";
import { CLIENT_CATALOG } from "./client-catalog.ts";
import {
  HandoffAnswerResponseSchema,
  HandoffDetailsResponseSchema,
  HandoffProofSchema,
  HandoffSubmitRequestSchema,
  OpenedHandoffResponseSchema,
  OperationStatusResponseSchema,
  ProviderHandoffRequestSchema,
  ProviderKeyHandoffRequestSchema,
  ReservedAppKeyRequestSchema,
  ReservedAppKeyResponseSchema,
  ReservedAppRequestSchema,
  ReservedAppResponseSchema,
  RevealedOperationResponseSchema,
} from "./handoffs.ts";
import {
  AccountUsageResponseSchema,
  AppUsageResponseSchema,
  ChargeListQuerySchema,
  ChargeListResponseSchema,
  UsageBreakdownQuerySchema,
  UsageBreakdownResponseSchema,
  UsageMonthQuerySchema,
  UsageRangeQuerySchema,
  UsageTimeseriesResponseSchema,
} from "./usage.ts";
import { CliToolCallRequestSchema, CliToolCallResponseSchema, CliToolCatalogResponseSchema } from "./cli.ts";
import type { OperationSpec } from "./operation.ts";

export { ErrorResponseSchema, HealthResponseSchema, type ErrorResponse, type HttpMethod, type OperationSpec, type SecurityKind } from "./operation.ts";

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
  401: "A valid management key, OAuth token or console sign-in is required.",
  403: "The credential has only the read grant, or its owner is not an account owner or admin.",
  404: "The app, key or provider connection does not exist in this account.",
} as const;

/** Errors the operations only a person signed in to the console may call can answer with. */
const SESSION_ONLY_ERRORS = {
  400: "The request is invalid.",
  401: "A valid console sign-in is required.",
  403: "Only a person signed in to the console can do this (`session_required`), or the account role is too low.",
  404: "Not found.",
} as const;

/** Errors the console's own pages can answer with. */
const CONSOLE_PAGE_ERRORS = {
  400: "The request is invalid.",
  403: "The request did not come from the console's own page, or the proof or code is wrong.",
  404: "Not served here (only on the console's origin, with OAuth set up), or nothing pending has this id.",
  409: "Someone else already answered it, or it was denied.",
  410: "It expired.",
  429: "Too many attempts from this network address. Carries Retry-After.",
} as const;

const CONSENT_PARAM = { id: { description: "The authorization id from the consent link." } } as const;
const OPERATION_PARAM = { id: { description: "The operation's id, as the call that opened or reserved it answered." } } as const;

/** Errors a reserved create can answer with, beside the create's own. */
const RESERVATION_ERRORS = {
  404: "`operation_not_found`: this server never gave out that handle. Otherwise the app does not exist in this account.",
  409: "`operation_mismatch`: the handle was reserved for other arguments or another account. `already_completed`: it was executed too long ago to repeat its answer. `conflict`: another call is executing it; nothing was written. `billing_plan_limit_reached`: the plan's ceiling is reached.",
  410: "`operation_expired`: the reservation lapsed, 15 minutes after it was made, before it was executed.",
} as const;
const DEVICE_PARAM = { id: { description: "The id the code lookup answered." } } as const;

export const CATALOG = {
  ...CLIENT_CATALOG,
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
      "Users that sign-in recorded, plus user ids that only the app's charges or refusals name (`is_virtual`, such as a server app's end-user header). Most recently seen first, with each user's usage in `month`. Usage per user is kept 90 days, so a month further back shows only what is left of it.",
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
    responseDescription: "The end user, with their usage in `month`. Usage per user is kept 90 days, so a month further back shows only what is left of it.",
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

  listAppJobs: {
    method: "GET",
    path: "/v2/admin/apps/{app}/jobs",
    params: APP_PARAM,
    tags: ["Admin jobs"],
    summary: "List an app's jobs",
    description:
      "Jobs the app submitted through the gateway in the last 89 days, such as fal queue jobs, newest first. Each shows the estimate charged at submit, what the provider's final figure corrected it by, and where it stands. Older jobs are only in the usage totals: their charges are kept 90 days.",
    security: "management",
    query: JobListQuerySchema,
    response: JobListResponseSchema,
    responseDescription: "One page of jobs.",
    errors: ADMIN_ERRORS,
  },

  getAccountUsage: {
    method: "GET",
    path: "/v2/admin/usage",
    tags: ["Admin usage"],
    summary: "Get the account's usage for a month",
    description:
      "Totals for the whole account in one UTC month, and a line per app, deleted apps included: their usage is kept. `first_usage_day` is null when the account has never made a call.",
    security: "management",
    query: UsageMonthQuerySchema,
    response: AccountUsageResponseSchema,
    responseDescription: "The account's month.",
    errors: ADMIN_ERRORS,
  },

  getAppUsage: {
    method: "GET",
    path: "/v2/admin/apps/{app}/usage",
    params: APP_PARAM,
    tags: ["Admin usage"],
    summary: "Get an app's usage for a month",
    description: "One UTC month's totals for one app, from the day totals (and month totals for days older than 400).",
    security: "management",
    query: UsageMonthQuerySchema,
    response: AppUsageResponseSchema,
    responseDescription: "The app's month.",
    errors: ADMIN_ERRORS,
  },

  getAppUsageTimeseries: {
    method: "GET",
    path: "/v2/admin/apps/{app}/usage/timeseries",
    params: APP_PARAM,
    tags: ["Admin usage"],
    summary: "Get an app's usage per day",
    description: "Totals per UTC day and provider type over a day range of at most 400 days.",
    security: "management",
    query: UsageRangeQuerySchema,
    response: UsageTimeseriesResponseSchema,
    responseDescription: "Daily buckets, oldest first.",
    errors: ADMIN_ERRORS,
  },

  getAppUsageBreakdown: {
    method: "GET",
    path: "/v2/admin/apps/{app}/usage/breakdown",
    params: APP_PARAM,
    tags: ["Admin usage"],
    summary: "Get an app's usage by one dimension",
    description:
      "Totals grouped by one dimension, largest cost first. model, provider, connection, status and unit come from the day totals, over a range of at most 400 days. user, install, operation, preset, price_source, measured and app_version come from the charges, kept 90 days, over a range of at most 31 days. v1's provider_slug is connection here (its label is the slug), cost_source is price_source, route is operation and endpoint is preset. v1's provider_gateway, credential_source, model_author and service_mode have no breakdown: v2 records none of them on a charge.",
    security: "management",
    query: UsageBreakdownQuerySchema,
    response: UsageBreakdownResponseSchema,
    responseDescription: "One row per value.",
    errors: ADMIN_ERRORS,
  },

  listAppCharges: {
    method: "GET",
    path: "/v2/admin/apps/{app}/charges",
    params: APP_PARAM,
    tags: ["Admin usage"],
    summary: "List an app's charges",
    description:
      "The ledger's rows, newest first: each upstream attempt, session slice and job estimate, and each correction as its own row naming the charge it corrects. Charges are kept 90 days; older usage is only in the totals.",
    security: "management",
    query: ChargeListQuerySchema,
    response: ChargeListResponseSchema,
    responseDescription: "One page of charges.",
    errors: ADMIN_ERRORS,
  },

  listAppConversations: {
    method: "GET",
    path: "/v2/admin/apps/{app}/conversations",
    params: APP_PARAM,
    tags: ["Admin conversations"],
    summary: "List an app's stored conversation files",
    description:
      "The batches of stored conversations of an app with `conversations.store` on, oldest first, by the UTC day of their earliest record. Each file is gzipped JSON lines, one call and its answer per line. Media the app keeps (`conversations.keep`) is stored beside them as `<YYYY-MM-DD>/media/<sha256>.<ext>`, and named in the records as `agw-media:<name>`.",
    security: "management",
    query: ConversationListQuerySchema,
    response: ConversationFileListSchema,
    responseDescription: "One page of stored conversation files.",
    errors: ADMIN_ERRORS,
  },

  getAppConversationFile: {
    method: "GET",
    path: "/v2/admin/apps/{app}/conversations/file",
    params: APP_PARAM,
    tags: ["Admin conversations"],
    summary: "Download a stored conversation file",
    description:
      "One file the listing names, or media a record names: a batch answers as application/gzip, media as its own type. Always a download, never a page.",
    security: "management",
    query: ConversationFileQuerySchema,
    response: z.unknown(),
    responseDescription: "The file's bytes.",
    file: true,
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
      "Sends the provider one free request that needs a valid key, to the same host live requests would use, and reports what it answered. Nothing is stored, and saving a connection never runs this test. Only `rejected` says the key is probably wrong: a key restricted so it cannot list models may also get it, because some providers answer 401 for a missing permission.",
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
  openProviderHandoff: {
    method: "POST",
    path: "/v2/admin/provider-handoffs",
    tags: ["Admin providers"],
    summary: "Open adding a provider connection whose key a person enters",
    description:
      "For an agent, which must never hold a provider key. Send everything `createProvider` takes but `secret`. It is checked now, as `createProvider` would check it, and nothing is created: the answer's `url` is a console page where a person enters the key and approves, within 15 minutes. Give the URL to the person, and read the operation with `getOperation` until it completes. Answers a `notice` when an identical request was made in the last hour.",
    security: "management",
    request: ProviderHandoffRequestSchema,
    status: 201,
    response: OpenedHandoffResponseSchema,
    responseDescription: "The operation and the link a person approves it on.",
    errors: { ...ADMIN_ERRORS, ...PLAN_CAP_ERRORS, 409: "A connection with that slug exists, or the plan's ceiling is reached.", 429: "Too many operations started by this account. Carries Retry-After." },
  },

  openProviderKeyHandoff: {
    method: "POST",
    path: "/v2/admin/providers/{id}/key-handoffs",
    params: PROVIDER_PARAM,
    tags: ["Admin providers"],
    summary: "Open replacing a provider connection's key, which a person enters",
    description:
      "For an agent, which must never hold a provider key. Send the revision the connection was read at. The answer's `url` is a console page where a person enters the new key and approves, within 15 minutes. A connection changed in between is refused rather than overwritten.",
    security: "management",
    request: ProviderKeyHandoffRequestSchema,
    status: 201,
    response: OpenedHandoffResponseSchema,
    responseDescription: "The operation and the link a person approves it on.",
    errors: { ...ADMIN_ERRORS, 409: "The connection changed since it was read; read it again.", 429: "Too many operations started by this account. Carries Retry-After." },
  },

  createReservedApp: {
    method: "POST",
    path: "/v2/admin/reserved/apps",
    tags: ["Admin applications"],
    summary: "Create an app once, in two calls",
    description:
      "For an agent, which may retry but must create once, and must never see a key. Without `handle`, the document is checked as `createApp` checks it and the creation is reserved: nothing is created. With the same document and the answer's `handle`, the app is created, once; repeating that call answers the same app again, with `replayed: true`. An app-key app's first key is never in the answer: `reveal_url` names the console page where a person signed in as an owner or admin sees it once, within 15 minutes.",
    security: "management",
    request: ReservedAppRequestSchema,
    response: ReservedAppResponseSchema,
    responseDescription: "The reservation, or the app it created.",
    errors: { ...ADMIN_ERRORS, ...PLAN_CAP_ERRORS, ...RESERVATION_ERRORS },
  },

  createReservedAppKey: {
    method: "POST",
    path: "/v2/admin/reserved/apps/{app}/keys",
    params: APP_PARAM,
    tags: ["Admin app keys"],
    summary: "Create an app key once, in two calls",
    description:
      "As `createReservedApp`, for another key of an app-key app. The key's value is never in the answer: `reveal_url` names the page where a person sees it once.",
    security: "management",
    request: ReservedAppKeyRequestSchema,
    response: ReservedAppKeyResponseSchema,
    responseDescription: "The reservation, or the key it created, without its value.",
    errors: { ...ADMIN_ERRORS, ...PLAN_CAP_ERRORS, ...RESERVATION_ERRORS },
  },

  getOperation: {
    method: "GET",
    path: "/v2/admin/operations/{id}",
    params: OPERATION_PARAM,
    tags: ["Admin operations"],
    summary: "Get where an operation stands",
    description:
      "Any credential of the account that opened the operation may read it; any other is answered `404 operation_not_found`. A pending one reports when it lapses, a completed one what it created, and one a person declined `expired` with `denied: true`. It never returns a secret: a key the operation created is revealed only on the page `reveal_url` names.",
    security: "management",
    response: OperationStatusResponseSchema,
    responseDescription: "Where the operation stands.",
    errors: { ...ADMIN_ERRORS, 404: "`operation_not_found`: no operation of your account has this id." },
  },

  revealOperation: {
    method: "POST",
    path: "/v2/admin/operations/{id}/reveal",
    params: OPERATION_PARAM,
    tags: ["Admin operations"],
    summary: "Reveal the key an operation created, once",
    description:
      "Console sign-in only, from the console's own page, by an owner or admin of the operation's account. Answers the key a reserved create made, once, within 15 minutes of its creation: a second reveal is `409 already_revealed`, and one after the window, or for a key revoked since, is `410 operation_expired`.",
    security: "session",
    response: RevealedOperationResponseSchema,
    responseDescription: "The key, shown this once.",
    errors: {
      ...SESSION_ONLY_ERRORS,
      404: "`operation_not_found`: no operation of your account has this id.",
      409: "`already_revealed`: it was revealed already.",
      410: "`operation_expired`: it can no longer be revealed.",
    },
  },

  listCliTools: {
    method: "GET",
    path: "/v2/cli/tools",
    tags: ["CLI"],
    summary: "List the tools the CLI builds its commands from",
    description:
      "The MCP server's tools, each with the command `agw` offers it as, the input fields it takes positionally, and how its result is shown. The CLI keeps this list and builds every command it does not implement itself from it, so a tool added to the gateway is a command of every installed CLI without a release. The list is the same for every caller of one deployment, so it needs no credential.",
    security: "public",
    response: CliToolCatalogResponseSchema,
    responseDescription: "The tools and the revision that names this list.",
  },

  callCliTool: {
    method: "POST",
    path: "/v2/cli/tools/{tool}",
    params: { tool: { description: "The tool's name, as listCliTools returns it." } },
    tags: ["CLI"],
    summary: "Run one tool, as the CLI does",
    description:
      "Runs one MCP tool with the arguments in the body, through the same operations, authorization and refusals as an MCP `tools/call`: a read needs any credential, and a change needs what that change needs over the API. A refusal is an HTTP error with the gateway's error code. Every answer, a refusal included, carries the list's revision in `Agw-Tools-Revision`; a CLI holding another one fetches the list again. Send the tool's `guard` from your list in `Agw-Tool-Guard`: when it differs from the tool's current one, the call is refused with `409 tool_changed` before anything runs.",
    security: "management",
    request: CliToolCallRequestSchema,
    response: CliToolCallResponseSchema,
    responseDescription: "The tool's structured result and its one-line summary.",
    errors: {
      ...ADMIN_ERRORS,
      404: "`tool_not_found`: this deployment has no tool of that name. Any other code: what the tool names does not exist.",
      409: "`tool_changed`: the tool has become destructive or needs more of the CLI since the caller's list; nothing ran. Otherwise the change conflicts with the current state.",
    },
  },

  getAdminSession: {
    method: "GET",
    path: "/v2/admin/session",
    tags: ["Admin access"],
    summary: "Who is calling",
    description: "The caller's sign-in, the account it acts in, its role and grant, and the accounts a console session may switch to.",
    security: "management",
    response: AdminSessionResponseSchema,
    responseDescription: "The caller.",
    errors: { 401: ADMIN_ERRORS[401] },
  },

  listAccounts: {
    method: "GET",
    path: "/v2/admin/accounts",
    tags: ["Admin access"],
    summary: "List your accounts",
    description: "Every account the person signed in to the console belongs to.",
    security: "session",
    response: AccountListResponseSchema,
    responseDescription: "The accounts, with the person's role in each.",
    errors: SESSION_ONLY_ERRORS,
  },

  selectAccount: {
    method: "POST",
    path: "/v2/admin/accounts/select",
    tags: ["Admin access"],
    summary: "Switch the console to another account",
    security: "session",
    request: AccountSelectRequestSchema,
    response: AdminSessionResponseSchema,
    responseDescription: "The session, now acting in that account.",
    errors: SESSION_ONLY_ERRORS,
  },

  listCredentials: {
    method: "GET",
    path: "/v2/admin/credentials",
    tags: ["Admin access"],
    summary: "List management keys, CLI logins and MCP connections",
    description: "Every credential that acts for this account, revoked ones included, newest first.",
    security: "session",
    response: CredentialListResponseSchema,
    responseDescription: "The credentials. Secrets are never shown.",
    errors: SESSION_ONLY_ERRORS,
  },

  createManagementKey: {
    method: "POST",
    path: "/v2/admin/management-keys",
    tags: ["Admin access"],
    summary: "Create a management key",
    description: "For scripts, CI and direct API calls. Needs an owner or admin. The key is shown once, in this answer.",
    security: "session",
    request: ManagementKeyCreateRequestSchema,
    status: 201,
    response: CreatedManagementKeyResponseSchema,
    responseDescription: "The key, shown once.",
    errors: { ...SESSION_ONLY_ERRORS, 409: "`account_changed`: the console now acts in another account than `accountId`; nothing was created." },
  },

  revokeCredential: {
    method: "POST",
    path: "/v2/admin/credentials/{id}/revoke",
    params: { id: { description: "The credential id." } },
    tags: ["Admin access"],
    summary: "Revoke a management key, CLI login or MCP connection",
    description: "It stops working at once. Needs an owner or admin.",
    security: "session",
    response: CredentialResponseSchema,
    responseDescription: "The revoked credential.",
    errors: SESSION_ONLY_ERRORS,
  },

  getConsoleCapabilities: {
    method: "GET",
    path: "/v2/console/capabilities",
    tags: ["Console"],
    summary: "What this deployment offers the console",
    security: "public",
    response: ConsoleCapabilitiesSchema,
    responseDescription: "The deployment's sign-in options.",
  },

  getOauthConsent: {
    method: "POST",
    path: "/v2/console/oauth/consents/{id}",
    params: CONSENT_PARAM,
    tags: ["Console"],
    summary: "Read an OAuth consent request",
    description: "What the consent page shows. The proof comes from the consent link's fragment, so it is sent in the body, never in a URL.",
    security: "public",
    request: ConsentProofSchema,
    response: ConsentDetailsResponseSchema,
    responseDescription: "The client, the grant it asked for, and the accounts the signed-in person may pick.",
    errors: CONSOLE_PAGE_ERRORS,
  },

  allowOauthConsent: {
    method: "POST",
    path: "/v2/console/oauth/consents/{id}/allow",
    params: CONSENT_PARAM,
    tags: ["Console"],
    summary: "Allow an OAuth client into one of your accounts",
    security: "session",
    request: ConsentAllowRequestSchema,
    response: ConsentRedirectResponseSchema,
    responseDescription: "Where to send the browser: back to the client, with its code.",
    errors: CONSOLE_PAGE_ERRORS,
  },

  denyOauthConsent: {
    method: "POST",
    path: "/v2/console/oauth/consents/{id}/deny",
    params: CONSENT_PARAM,
    tags: ["Console"],
    summary: "Decline an OAuth client",
    security: "public",
    request: ConsentProofSchema,
    response: ConsentRedirectResponseSchema,
    responseDescription: "Where to send the browser: back to the client, with access_denied.",
    errors: CONSOLE_PAGE_ERRORS,
  },

  lookupDeviceCode: {
    method: "POST",
    path: "/v2/console/device/lookup",
    tags: ["Console"],
    summary: "Find a CLI sign-in by the code it shows",
    description: "Counted per network address, so codes cannot be guessed in bulk.",
    security: "session",
    request: DeviceLookupRequestSchema,
    response: DeviceLookupResponseSchema,
    responseDescription: "The pending sign-in. Send its id with the code from now on.",
    errors: CONSOLE_PAGE_ERRORS,
  },

  getDeviceRequest: {
    method: "POST",
    path: "/v2/console/device/{id}",
    params: DEVICE_PARAM,
    tags: ["Console"],
    summary: "Read a CLI sign-in request",
    security: "session",
    request: DeviceCodeRequestSchema,
    response: DeviceDetailsResponseSchema,
    responseDescription: "The client, the grant it asked for, the code to compare, and the accounts the person may pick.",
    errors: CONSOLE_PAGE_ERRORS,
  },

  approveDeviceRequest: {
    method: "POST",
    path: "/v2/console/device/{id}/approve",
    params: DEVICE_PARAM,
    tags: ["Console"],
    summary: "Allow a CLI sign-in into one of your accounts",
    security: "session",
    request: DeviceApproveRequestSchema,
    response: DeviceAnswerResponseSchema,
    responseDescription: "Approved. The CLI's next poll gets its tokens.",
    errors: CONSOLE_PAGE_ERRORS,
  },

  denyDeviceRequest: {
    method: "POST",
    path: "/v2/console/device/{id}/deny",
    params: DEVICE_PARAM,
    tags: ["Console"],
    summary: "Decline a CLI sign-in",
    security: "public",
    request: DeviceCodeRequestSchema,
    response: DeviceAnswerResponseSchema,
    responseDescription: "Declined. The CLI's next poll is told access_denied.",
    errors: CONSOLE_PAGE_ERRORS,
  },

  getHandoff: {
    method: "POST",
    path: "/v2/console/handoffs/{id}",
    params: OPERATION_PARAM,
    tags: ["Console"],
    summary: "What a browser step asks a person to approve",
    description: "For the console's approval page. The proof comes from the approval link's fragment, and is the whole authority: whoever holds the link may answer it.",
    security: "public",
    request: HandoffProofSchema,
    response: HandoffDetailsResponseSchema,
    responseDescription: "The step and what it would change.",
    errors: CONSOLE_PAGE_ERRORS,
  },

  submitHandoff: {
    method: "POST",
    path: "/v2/console/handoffs/{id}/submit",
    params: OPERATION_PARAM,
    tags: ["Console"],
    summary: "Enter the key a browser step asks for, and approve it",
    description: "The write runs as the credential that opened the step, and the key is never answered. Approving one already approved answers `completed` again.",
    security: "public",
    request: HandoffSubmitRequestSchema,
    response: HandoffAnswerResponseSchema,
    responseDescription: "Approved: the connection is added, or its key replaced.",
    errors: { ...CONSOLE_PAGE_ERRORS, 409: "It was declined, the connection changed, a connection with that slug exists, or the plan's ceiling is reached.", 429: "Too many answers to this step. Carries Retry-After." },
  },

  denyHandoff: {
    method: "POST",
    path: "/v2/console/handoffs/{id}/deny",
    params: OPERATION_PARAM,
    tags: ["Console"],
    summary: "Decline a browser step",
    description: "Anyone holding the link may decline it. The agent that opened it is told on its next read.",
    security: "public",
    request: HandoffProofSchema,
    response: HandoffAnswerResponseSchema,
    responseDescription: "Declined.",
    errors: CONSOLE_PAGE_ERRORS,
  },
} as const satisfies Readonly<Record<string, OperationSpec>>;

export type Catalog = typeof CATALOG;
export type OperationName = keyof Catalog;
export type OperationResponse<K extends OperationName> = z.output<Catalog[K]["response"]>;

/** The `{name}` segments of a path template, as a type. */
type PathParameterNames<P extends string> =
  P extends `${string}{${infer Name}}${infer Rest}` ? Name | PathParameterNames<Rest> : never;

export type OperationParams<K extends OperationName> = Record<PathParameterNames<Catalog[K]["path"]>, string>;

/** An optional schema field of each operation, or `never` where it has none. */
type SchemaOf<Field extends string> = {
  [K in OperationName]: Catalog[K] extends { readonly [F in Field]: infer S extends z.ZodType } ? S : z.ZodNever;
};

/** A query string as a client writes it: the schema's input, so defaulted fields are optional. */
export type OperationQuery<K extends OperationName> = z.input<SchemaOf<"query">[K]>;

/** A request body as a client writes it, before the schema's defaults apply. */
export type OperationRequest<K extends OperationName> = z.input<SchemaOf<"request">[K]>;

type HasParams<K extends OperationName> = PathParameterNames<Catalog[K]["path"]> extends never ? false : true;

/** A `?a=1&b=2` suffix, or the empty string when nothing is set. */
export function searchSuffix(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * The URL of one operation, filled in from its own template (v1's helper,
 * ported). The console builds every request path with it, so no client
 * writes a path of its own.
 */
export function operationPath<K extends OperationName>(
  name: K,
  ...rest: HasParams<K> extends true
    ? [params: OperationParams<K>, query?: OperationQuery<K>]
    : [params?: undefined, query?: OperationQuery<K>]
): string {
  const [params, query] = rest as [Record<string, string> | undefined, object | undefined];
  const filled = CATALOG[name].path.replace(/\{(\w+)\}/gu, (_match, key: string) => {
    const value = params?.[key];
    // An empty segment would send the request to another endpoint.
    if (value === undefined) throw new Error(`${String(name)} needs a "${key}" path parameter`);
    return encodeURIComponent(value);
  });
  return query === undefined
    ? filled
    : filled + searchSuffix(query as Record<string, string | number | boolean | undefined | null>);
}
