import { OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import { PROVIDER_SLUG_PATTERN } from "../core/providers.ts";
import {
  CliBootstrapRequestSchema, CliOperationRequestSchema, CliSubmissionRequestSchema,
  CliBootstrapResponseSchema, CliOperationResponseSchema, CliPollResponseSchema,
  CliUsageResponseSchema, CliCapabilitiesResponseSchema, CliDeploymentSchema, CliAccountSchema,
} from "./cli.ts";
import {
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
  ApiKeyTokenRequestSchema,
  AppUpdateSchema,
  AppWriteSchema,
  OrganizationSelectRequestSchema,
  ProviderCreateRequestSchema,
  ProviderGatewayCreateRequestSchema,
  ProviderGatewayRotateRequestSchema,
  ProviderGatewayTestRequestSchema,
  ProviderGatewayUpdateRequestSchema,
  ProviderTestRequestSchema,
  ProviderUpdateRequestSchema,
  UsageRepriceRequestSchema,
} from "./schemas.ts";

export {
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
  ApiKeyTokenRequestSchema,
  AppConfigSchema,
  AppUpdateSchema,
  AppWriteSchema,
  GatewayRouteConfigSchema,
  OrganizationRoleSchema,
  OrganizationSelectRequestSchema,
  ProviderCreateRequestSchema,
  ProviderGatewayCreateRequestSchema,
  ProviderGatewayRotateRequestSchema,
  ProviderGatewayTestRequestSchema,
  ProviderGatewayUpdateRequestSchema,
  ProviderPricingSchema,
  SlugSchema,
  ProviderTestRequestSchema,
  ProviderUpdateRequestSchema,
  UsageRepriceRequestSchema,
} from "./schemas.ts";

import {
  AppAttestChallengeResponseSchema,
  AppAttestRegisterResponseSchema,
  AppDeleteResponseSchema,
  AppResponseSchema,
  AuthEventListSchema,
  AuthEventSummarySchema,
  ConsoleCapabilitiesResponseSchema,
  CreatedManagementKeyResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  IdentitySessionSchema,
  ManagementKeyListResponseSchema,
  ManagementKeyResponseSchema,
  OrganizationListResponseSchema,
  ProviderDeleteResponseSchema,
  ProviderGatewayDeleteResponseSchema,
  ProviderGatewayListResponseSchema,
  ProviderGatewayResponseSchema,
  ProviderGatewayTestResponseSchema,
  ProviderListResponseSchema,
  ProviderResponseSchema,
  ProviderTestResponseSchema,
  UsageEventListSchema,
} from "./responses.ts";

export * from "./responses.ts";

const AppPath = z.object({
  app: z.string().openapi({ param: { name: "app", in: "path" }, example: "my-app" }),
});

const UserPath = AppPath.extend({
  user: z.string().openapi({ param: { name: "user", in: "path" }, example: "user-123" }),
});

const KeyPath = AppPath.extend({
  key: z.string().openapi({ param: { name: "key", in: "path" }, example: "key_123" }),
});

const ManagementKeyPath = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "key_123" }),
});

const ProviderSlugSchema = z.string().regex(PROVIDER_SLUG_PATTERN);

const ProviderPath = AppPath.extend({
  provider: ProviderSlugSchema
    .openapi({ param: { name: "provider", in: "path" }, example: "openai-dev" }),
  path: z.string().openapi({
    param: { name: "path", in: "path" },
    description: "The provider's native API path verbatim, without a leading slash.",
    example: "v1/responses",
  }),
});

const EndpointPath = AppPath.extend({
  slug: z.string().regex(/^[a-z0-9-]{1,64}$/)
    .openapi({ param: { name: "slug", in: "path" }, example: "chat" }),
});

const json = (schema: z.ZodType) => ({
  "application/json": { schema },
});

const response = (description: string, schema: z.ZodType) => ({
  description,
  content: json(schema),
});

const errorResponses = {
  400: response("The request is invalid.", ErrorResponseSchema),
  401: response("Authentication is required or invalid.", ErrorResponseSchema),
  403: response("The authenticated identity is not allowed to perform this operation.", ErrorResponseSchema),
  404: response("The requested resource does not exist.", ErrorResponseSchema),
};

/**
 * What an issuer-token exchange can refuse with, split by what the client
 * should do about it. Three codes and no more: a finer split would publish
 * causes no client can act on differently.
 */
const issuerErrorResponses = {
  403: response(
    "`issuer_token_rejected` — the token did not verify; get a fresh one, retry once, then fail. `issuer_claims_missing` — the token is valid but a required entitlement claim has not propagated yet; do not re-authenticate, wait and retry. `auth_required` — the key was refused or the user is blocked. `attest_failed` — the App Attest proof did not hold.",
    ErrorResponseSchema,
  ),
  503: response(
    "`issuer_verification_unavailable` — the gateway could not reach or read the issuer's keys, so the token was never judged. Retry with backoff.",
    ErrorResponseSchema,
  ),
};

const registry = new OpenAPIHono();
const documentationRegistry = new OpenAPIHono();
for (const target of [registry, documentationRegistry]) {
  target.openAPIRegistry.registerComponent("securitySchemes", "ManagementBearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "agw_mgmt_…",
    description: "A management API key. It acts with its owning identity's current role for one account.",
  });
  target.openAPIRegistry.registerComponent("securitySchemes", "ConsoleSession", {
    type: "apiKey",
    in: "cookie",
    name: "agw_identity_auth.session_token",
    description: "The console's session cookie. Admin requests from the console also send x-console-request: 1.",
  });
  target.openAPIRegistry.registerComponent("securitySchemes", "CliPollProof", {
    type: "http", scheme: "bearer", description: "The initiating CLI's private pollToken, distinct from the browser submission proof.",
  });
  target.openAPIRegistry.registerComponent("securitySchemes", "GatewayBearer", {
    type: "http",
    scheme: "bearer",
    description: "A gateway access token, or an application API key for an issuer-less API-key app.",
  });
}

const receiptPaths = new Set(["/v1/admin/apps", "/v1/admin/apps/{app}/keys", "/v1/admin/providers", "/v1/admin/provider-gateways"]);
function register({ hide, ...route }: RouteConfig): void {
  if (route.method === "post" && receiptPaths.has(route.path)) {
    route = { ...route,
      description: `${route.description ?? ""} Optional Idempotency-Key and X-Idempotency-Proof must be supplied together as independently generated 32–256 character URL-safe proofs. Save them before sending; an identical retry returns the original result. Wrong proof is 403, changed body is 409. Protected key recovery lasts 15 minutes; expired recovery never creates another resource.`,
      request: { ...route.request, headers: z.object({
        "Idempotency-Key": z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional(),
        "X-Idempotency-Proof": z.string().regex(/^[A-Za-z0-9_-]{32,256}$/).optional(),
      }) },
      responses: { ...route.responses,
        409: response("A request proof was reused with different content or resource creation conflicted.", ErrorResponseSchema),
        410: response("resource_receipt_expired: protected key recovery expired; error.data contains existing appId/keyId when available. resource_key_unavailable: the original key was revoked. Inspect that resource and replace its key intentionally.", ErrorResponseSchema),
      },
    };
  }
  registry.openAPIRegistry.registerPath(route);
  if (!hide) documentationRegistry.openAPIRegistry.registerPath(route);
}

const managementSecurity: RouteConfig["security"] = [
  { ConsoleSession: [] },
  { ManagementBearer: [] },
];

register({
  method: "get",
  path: "/v1/healthz",
  tags: ["Operations"],
  operationId: "getHealth",
  summary: "Check gateway health",
  responses: {
    200: response("The Worker is accepting requests.", HealthResponseSchema),
  },
});

register({
  method: "get",
  path: "/v1/console/capabilities",
  tags: ["Operations"],
  operationId: "getConsoleCapabilities",
  summary: "Discover optional deployment capabilities",
  responses: {
    200: response("Capabilities the console adapts to.", ConsoleCapabilitiesResponseSchema),
  },
});

for (const authRoute of [
  {
    method: "post",
    path: "/v1/auth/sign-up/email",
    operationId: "signUp",
    summary: "Create an account",
    body: z.object({ name: z.string(), email: z.email(), password: z.string().min(8) }),
  },
  {
    method: "post",
    path: "/v1/auth/sign-in/email",
    operationId: "signIn",
    summary: "Sign in with email and password",
    body: z.object({ email: z.email(), password: z.string() }),
  },
] as const) {
  register({
    method: authRoute.method,
    path: authRoute.path,
    tags: ["Console authentication"],
    operationId: authRoute.operationId,
    summary: authRoute.summary,
    request: { body: { required: true, content: json(authRoute.body) } },
    responses: {
      200: response("Authenticated session.", z.unknown()),
      ...errorResponses,
    },
  });
}

register({
  method: "get",
  path: "/v1/auth/get-session",
  tags: ["Console authentication"],
  operationId: "getSession",
  summary: "Get the current session",
  security: [{ ConsoleSession: [] }],
  responses: { 200: response("Current session or null.", z.unknown()), ...errorResponses },
});

register({
  method: "post",
  path: "/v1/auth/sign-out",
  tags: ["Console authentication"],
  operationId: "signOut",
  summary: "End the current session",
  security: [{ ConsoleSession: [] }],
  responses: { 200: response("Session ended.", z.unknown()), ...errorResponses },
});

register({
  method: "get",
  path: "/v1/auth/sign-in/social",
  tags: ["Console authentication"],
  operationId: "signInWithGoogle",
  summary: "Start optional Google sign-in",
  description: "Available only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are configured.",
  request: { query: z.object({ provider: z.literal("google") }) },
  responses: { 302: { description: "Redirect to Google." }, ...errorResponses },
});

register({
  method: "post",
  path: "/v1/apps/{app}/auth/challenge",
  tags: ["Application authentication"],
  operationId: "createAppAttestChallenge",
  summary: "Create an App Attest challenge",
  request: { params: AppPath },
  responses: {
    200: response("A five-minute, single-use challenge.", AppAttestChallengeResponseSchema),
    ...errorResponses,
    402: response("No billing plan resolves for the account.", ErrorResponseSchema),
    404: response(
      "This application identifies no end users, so there is no per-user standing to report. Answered with auth_method_not_supported: the request was well-formed, and nothing the caller can rephrase would make it work.",
      ErrorResponseSchema,
    ),
  },
});

register({
  method: "post",
  path: "/v1/apps/{app}/auth/register",
  tags: ["Application authentication"],
  operationId: "registerAppAttestKey",
  summary: "Register an App Attest key",
  request: {
    params: AppPath,
    body: { required: true, content: json(AppAttestRegisterRequestSchema) },
  },
  responses: {
    200: response("The key was registered for the verified issuer identity.", AppAttestRegisterResponseSchema),
    ...errorResponses,
    ...issuerErrorResponses,
    402: response("No billing plan resolves for the account.", ErrorResponseSchema),
  },
});

register({
  method: "post",
  path: "/v1/apps/{app}/auth/token",
  tags: ["Application authentication"],
  operationId: "exchangeGatewayToken",
  summary: "Exchange issuer identity and client proof for a gateway token",
  description: "App Attest clients send key_id, assertion, and challenge. Issuer-backed API-key clients send api_key and issuer_token. The verified issuer claim is always the resulting user identity.",
  request: {
    params: AppPath,
    body: { required: true, content: json(z.union([
      AppAttestTokenRequestSchema,
      ApiKeyTokenRequestSchema,
    ])) },
  },
  responses: {
    200: response("A short-lived gateway access token.", z.object({ access_token: z.string(), expires_in: z.number() })),
    ...errorResponses,
    ...issuerErrorResponses,
    402: response("No billing plan resolves for the account.", ErrorResponseSchema),
  },
});

register({
  method: "get",
  path: "/v1/apps/{app}/me",
  tags: ["Application"],
  operationId: "getCurrentUser",
  summary: "Get the current user's limits, spend and block state",
  security: [{ GatewayBearer: [] }],
  request: { params: AppPath },
  responses: {
    200: response("Current user state.", z.object({
      user_id: z.string(),
      limits: z.object({
        requests_today: z.number().int().nullable().describe("Requests this user has made so far in the current UTC day. Null when the application sets no per-user limit, in which case requests are not counted at all."),
        requests_remaining: z.number().int().nullable().describe("What is left of requests_per_day. Null when no daily limit is set."),
        requests_per_minute: z.number().nullable().describe("The per-user per-minute limit this app sets. Null means unlimited."),
        requests_per_day: z.number().nullable().describe("The per-user per-day limit this app sets. Null means unlimited."),
        monthly_cost_usd: z.number().describe("What this user's traffic has cost so far in the current UTC calendar month."),
        monthly_budget_usd: z.number().nullable().describe("The per-user monthly spending budget this app sets. Null means unlimited."),
        blocked: z.boolean().describe("Whether this user has been blocked in the console."),
      }).openapi({
        description: "The limits the app sets on this user, and where the user stands against them. The account's request allowance is not reported here: it is shared by all apps, and is reported on the rejection that spends it.",
      }),
    })),
    ...errorResponses,
    402: response("No billing plan resolves for the account.", ErrorResponseSchema),
    404: response(
      "This application identifies no end users, so there is no per-user standing to report. Answered with auth_method_not_supported: the request was well-formed, and nothing the caller can rephrase would make it work.",
      ErrorResponseSchema,
    ),
  },
});

register({
  method: "post",
  path: "/v1/apps/{app}/proxy/{provider}/{path}",
  tags: ["Provider proxy"],
  operationId: "proxyProviderRequest",
  summary: "Proxy a provider-native model request",
  description: "The path, body, and successful response retain the selected provider's native contract. For example, OpenAI clients send v1/responses or v1/chat/completions; gateway-specific provider slug quirks are never part of the client path. The gateway validates the configured path and model, spends one request from the account's monthly allowance, and streams the upstream response without buffering.",
  security: [{ GatewayBearer: [] }],
  request: {
    params: ProviderPath,
    headers: z.object({
      "x-app-version": z.string().optional().openapi({ description: "Required for gateway-token clients; optional for issuer-less API-key clients." }),
      "x-end-user-id": z.string().optional().openapi({ description: "Optional configured end-user identity for issuer-less API-key applications." }),
    }),
    body: { required: true, content: json(z.record(z.string(), z.unknown()).openapi({
      description: "Provider-native JSON request. Consult the selected provider's API reference for the exact shape.",
    })) },
  },
  responses: {
    200: response("Provider-native response. Streaming responses remain streamed.", z.unknown()),
    ...errorResponses,
    402: response("No billing plan resolves for the account.", ErrorResponseSchema),
    429: response("Either the app's own limits or the account's request allowance refused the request. The app's limits are checked first and answer app_rate_limited or app_budget_exhausted, carrying scope; the plan allowance answers billing_request_quota_exceeded with limit, used, and the UTC resetAt. Every one of them carries a Retry-After header.", ErrorResponseSchema),
    502: response("The upstream provider request failed.", ErrorResponseSchema),
    504: response("The upstream provider sent no response headers within the gateway's time-to-first-byte budget.", ErrorResponseSchema),
  },
});

register({
  method: "post",
  path: "/v1/apps/{app}/endpoints/{slug}",
  tags: ["Named endpoints"],
  operationId: "callNamedEndpoint",
  summary: "Call a server-configured named endpoint",
  description: "The endpoint's provider, model, fixed parameters, output cap, and fallback chain come from the application configuration, so you can change models without shipping a client release. Responses-style endpoints accept an OpenAI Responses body; transcription-style endpoints accept an OpenAI audio transcription multipart body and may omit the model field. The successful response keeps the serving provider's native format and streaming behaviour.",
  security: [{ GatewayBearer: [] }],
  request: {
    params: EndpointPath,
    headers: z.object({
      "x-app-version": z.string().optional().openapi({ description: "Required for gateway-token clients; optional for issuer-less API-key clients." }),
      "x-end-user-id": z.string().optional().openapi({ description: "Optional configured end-user identity for issuer-less API-key applications." }),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.record(z.string(), z.unknown()).openapi({
            description: "OpenAI Responses API body for endpoints whose api_style is responses. The gateway overwrites model and deep-merges the configured params.",
          }),
        },
        "multipart/form-data": {
          schema: z.object({
            file: z.string().openapi({ format: "binary" }),
            model: z.string().optional().openapi({ description: "Ignored; the gateway sets the configured model." }),
            prompt: z.string().optional(),
            language: z.string().optional(),
            response_format: z.string().optional(),
          }).openapi({ description: "Body for endpoints whose api_style is transcription." }),
        },
      },
    },
  },
  responses: {
    200: response("Provider-native response. Streaming responses remain streamed.", z.unknown()),
    ...errorResponses,
    402: response("No billing plan resolves for the account.", ErrorResponseSchema),
    429: response("Either the app's own limits or the account's request allowance refused the request. The app's limits are checked first and answer app_rate_limited or app_budget_exhausted, carrying scope; the plan allowance answers billing_request_quota_exceeded with limit, used, and the UTC resetAt. Every one of them carries a Retry-After header.", ErrorResponseSchema),
    502: response("Every configured target failed.", ErrorResponseSchema),
    504: response("Every configured target failed, and the last one sent no response headers within the gateway's time-to-first-byte budget.", ErrorResponseSchema),
  },
});

register({
  method: "get",
  path: "/v1/admin/apps",
  tags: ["Admin applications"],
  operationId: "listApps",
  summary: "List applications",
  security: managementSecurity,
  responses: {
    200: response(
      "Applications and current usage summaries.",
      z.object({
        month: z.string(),
        has_proxied_requests: z.boolean().openapi({
          description:
            "Whether this account has ever had a request recorded, at any time. Unlike the per-application `usage` totals beside it, which cover `month` only, this does not reset when a new month begins, and it never goes from true back to false. Intended for first-run interfaces that stop offering setup guidance once traffic has started.",
        }),
        apps: z.array(z.unknown()),
      }),
    ),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/apps",
  tags: ["Admin applications"],
  operationId: "createApp",
  summary: "Create an application",
  description: "Send only `name`, `config` and an optional `status`. The gateway assigns the id — the name slugified plus a six-character random suffix — and returns it as `app.id`; it cannot be chosen, and it cannot change once the application exists. A body that still carries `id` is refused with `400`. API-key applications receive a one-time plaintext initial key in the response.",
  security: managementSecurity,
  request: { body: { required: true, content: json(AppWriteSchema) } },
  responses: {
    201: response(
      "Application created. `app.id` is the assigned id and the segment every gateway URL for this app uses. `api_key` is the one-time plaintext initial key for an API-key application, and null for any other.",
      AppResponseSchema.extend({ api_key: z.unknown().nullable() }),
    ),
    ...errorResponses,
    409: response("`invalid_request` — no unique generated id could be allocated after repeated attempts. Retrying is safe.", ErrorResponseSchema),
  },
});

const BillingPlanSelectionSchema = z.object({
  planKey: z.string().min(1),
  billingPeriod: z.enum(["month", "year"]),
});

register({
  method: "get",
  path: "/v1/admin/billing/plans",
  hide: true,
  tags: ["Admin billing"],
  operationId: "listBillingPlans",
  summary: "List billing plans",
  security: managementSecurity,
  responses: { 200: response("Billing service response.", z.unknown()), ...errorResponses },
});

/**
 * The organization's current monthly allowance period against the one allowance a plan grants.
 * Only the dispatch path writes this count, so a status read is the only place
 * an operator can see it before the allowance runs out.
 */
const BillingPlanLimitsSchema = z.object({
  maxRequestsPerMonth: z.number().int().optional().describe("Requests the account may dispatch per allowance period."),
  maxApps: z.number().int().optional().describe("Applications the account may own."),
  maxProviders: z.number().int().optional().describe("Providers the account may own."),
  maxProviderGateways: z.number().int().optional().describe("Provider gateways the account may own."),
  maxActiveKeysPerApp: z.number().int().optional().describe("Active API keys each of the account's applications may hold."),
}).describe(
  "The plan's ceilings, as this gateway enforces them. Every key is optional and an absent key means unlimited, so an empty object is a plan with no ceilings. A write that would exceed one is refused with billing_plan_limit_reached.",
);

const BillingQuotaSchema = z.object({
  periodId: z.string().describe("Opaque identifier for the allowance period being reported."),
  periodStart: z.string().describe("Inclusive UTC instant at which this allowance period began."),
  periodEnd: z.string().describe("Exclusive UTC instant at which this allowance period ends."),
  used: z.number().int().describe("Requests dispatched to a provider in this period, across all apps."),
  limit: z.number().int().optional().describe("The plan's maxRequestsPerMonth. Absent means unlimited."),
  resetAt: z.string().describe("UTC instant at which the allowance resets; currently equal to periodEnd."),
});

for (const route of [
  { path: "/v1/admin/billing/status", operationId: "getBillingStatus", summary: "Get billing access and the current allowance period" },
  { path: "/v1/admin/billing/portal/status", operationId: "getBillingPortalStatus", summary: "Poll billing portal/access status" },
] as const) {
  register({
    method: "get",
    path: route.path,
    tags: ["Admin billing"],
    hide: true,
    operationId: route.operationId,
    summary: route.summary,
    security: managementSecurity,
    responses: {
      200: response(
        "Billing access, and the current period against the plan's request allowance when an entitlement resolves.",
        z.object({
          access: z.unknown(),
          limits: BillingPlanLimitsSchema,
          quota: BillingQuotaSchema.nullable().describe(
            "Null when billing is unavailable or no plan entitlement resolves.",
          ),
        }),
      ),
      ...errorResponses,
    },
  });
}

register({
  method: "post",
  path: "/v1/admin/billing/checkout",
  hide: true,
  tags: ["Admin billing"],
  operationId: "createBillingCheckout",
  summary: "Create a hosted checkout",
  security: managementSecurity,
  request: { body: { required: true, content: json(BillingPlanSelectionSchema.extend({
    successUrl: z.url().optional(),
    cancelUrl: z.url().optional(),
  })) } },
  responses: { 200: response("Hosted checkout URL.", z.object({ url: z.string() })), ...errorResponses },
});

for (const route of [
  { path: "/v1/admin/billing/change", operationId: "changeBillingPlan", summary: "Change the subscription plan" },
  { path: "/v1/admin/billing/resume", operationId: "resumeBillingSubscription", summary: "Resume a canceled subscription" },
] as const) {
  register({
    method: "post",
    path: route.path,
    tags: ["Admin billing"],
    hide: true,
    operationId: route.operationId,
    summary: route.summary,
    security: managementSecurity,
    request: { body: { required: true, content: json(BillingPlanSelectionSchema) } },
    responses: { 200: response("Billing service response.", z.unknown()), ...errorResponses },
  });
}

register({
  method: "post",
  path: "/v1/admin/billing/cancel",
  hide: true,
  tags: ["Admin billing"],
  operationId: "cancelBillingSubscription",
  summary: "Cancel the subscription at period end",
  security: managementSecurity,
  responses: { 200: response("Cancellation accepted.", z.object({ ok: z.literal(true) })), ...errorResponses },
});

register({
  method: "post",
  path: "/v1/admin/billing/trial",
  hide: true,
  tags: ["Admin billing"],
  operationId: "startBillingTrial",
  summary: "Start a no-card trial",
  security: managementSecurity,
  request: { body: { required: true, content: json(z.object({ planKey: z.string().min(1) })) } },
  responses: { 200: response("Trial access state.", z.unknown()), ...errorResponses },
});

for (const definition of [
  { method: "get", operationId: "getApp", summary: "Get an application" },
  {
    method: "put",
    operationId: "updateApp",
    summary: "Update an application",
    description: "Requires `revision` in the body, the one the application was read at; a stale revision answers `409 app_revision_conflict` and an absent one `400 app_revision_required`. Updates an existing application in place. It never creates one: an id none of your applications holds answers `404 app_not_found`, and nothing is written. Applications are created only by `POST /v1/admin/apps`, which assigns the id.",
  },
] as const) {
  register({
    method: definition.method,
    path: "/v1/admin/apps/{app}",
    tags: ["Admin applications"],
    operationId: definition.operationId,
    summary: definition.summary,
    ...("description" in definition ? { description: definition.description } : {}),
    security: managementSecurity,
    request: {
      params: AppPath,
      ...(definition.method === "put" ? { body: { required: true, content: json(AppUpdateSchema) } } : {}),
    },
    responses: { 200: response("Application state.", AppResponseSchema), ...(definition.method === "put" ? { 409: response("The application changed since it was read.", ErrorResponseSchema) } : {}), ...errorResponses },
  });
}

register({
  method: "post",
  path: "/v1/admin/apps/{app}/validate",
  tags: ["Admin applications"],
  operationId: "validateApp",
  summary: "Validate an application configuration without saving it",
  security: managementSecurity,
  request: { params: AppPath, body: { required: true, content: json(AppWriteSchema) } },
  responses: { 200: response("Resolved valid configuration.", z.unknown()), ...errorResponses },
});

register({
  method: "delete",
  path: "/v1/admin/apps/{app}",
  tags: ["Admin applications"],
  operationId: "deleteApp",
  summary: "Delete an application and its associated operational data",
  security: managementSecurity,
  request: { params: AppPath, query: z.object({ confirm: z.string() }) },
  responses: {
    200: response("Application deleted. Its usage events are kept, which is what `usage_events_retained` reports.", AppDeleteResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "get",
  path: "/v1/admin/keys",
  tags: ["Admin management keys"],
  operationId: "listManagementKeys",
  summary: "List management keys",
  description: "Console session only. Management keys cannot administer management keys.",
  security: [{ ConsoleSession: [] }],
  responses: {
    200: response("Management key metadata without plaintext tokens.", ManagementKeyListResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/keys",
  tags: ["Admin management keys"],
  operationId: "createManagementKey",
  summary: "Create a management key",
  description: "Console session only, and requires the owner or admin role. A management key cannot create another one, so revoking a key you handed out ends that access for good. The plaintext agw_mgmt_ token is returned once, and never expires; the account's own deadline is the only one.",
  security: [{ ConsoleSession: [] }],
  request: { body: { required: true, content: json(z.object({ name: z.string().min(1).max(100) })) } },
  responses: {
    201: response("One-time plaintext management key.", CreatedManagementKeyResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/keys/{id}/revoke",
  tags: ["Admin management keys"],
  operationId: "revokeManagementKey",
  summary: "Revoke a management key",
  description: "Console session only, and requires the owner or admin role.",
  security: [{ ConsoleSession: [] }],
  request: { params: ManagementKeyPath },
  responses: {
    200: response("Revoked management key metadata.", ManagementKeyResponseSchema),
    ...errorResponses,
  },
});

const ProviderIdPath = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "b0a1…" }),
});

register({
  method: "get",
  path: "/v1/admin/providers",
  tags: ["Admin providers"],
  operationId: "listProviders",
  summary: "List provider credentials",
  security: managementSecurity,
  responses: {
    200: response("Provider metadata without credentials.", ProviderListResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/providers",
  tags: ["Admin providers"],
  operationId: "createProvider",
  summary: "Store a provider credential",
  description:
    "Creates one named provider instance. Supply exactly one direct provider secret or reusable providerGatewayId. The credential is stored as given and never probed: check one first with POST /v1/admin/providers/test. The slug defaults to the provider type and is unique among your provider instances, disabled ones included; only deleting an instance frees its slug.",
  security: managementSecurity,
  request: { body: { required: true, content: json(ProviderCreateRequestSchema) } },
  responses: {
    201: response("Stored provider.", ProviderResponseSchema),
    409: response("The requested active provider slug is already in use.", ErrorResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/providers/test",
  tags: ["Admin providers"],
  operationId: "testProviderCredential",
  summary: "Probe a provider credential without storing it",
  description:
    "Calls the provider with a credential, and reports what it answered. Nothing is stored, and no other endpoint runs this check: a write stores what it is given. Supply exactly one direct provider secret or an existing providerGatewayId.",
  security: managementSecurity,
  request: { body: { required: true, content: json(ProviderTestRequestSchema) } },
  responses: {
    200: response("Probe outcome.", ProviderTestResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "put",
  path: "/v1/admin/providers/{id}",
  tags: ["Admin providers"],
  operationId: "updateProvider",
  summary: "Rotate a credential, rename it, move it to another origin, replace its custom pricing, or disable it",
  description:
    "Sending status disables or re-enables the instance. Disabling keeps the secret, the pricing and the slug, so requests to it fail with provider_disabled and no other instance can take its slug meanwhile. Re-enabling therefore always succeeds. Sending a non-null baseUrl also requires secret in the same request: the stored key is write-only and is never decrypted to be sent to an origin it has not been sent to before, so a move carries the key it is to be used with. Sending baseUrl: null returns the instance to its provider type's own origin and needs nothing else.",
  security: managementSecurity,
  request: {
    params: ProviderIdPath,
    body: { required: true, content: json(ProviderUpdateRequestSchema) },
  },
  responses: {
    200: response("Updated provider.", ProviderResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "delete",
  path: "/v1/admin/providers/{id}",
  tags: ["Admin providers"],
  operationId: "deleteProvider",
  summary: "Delete a provider credential and its custom pricing",
  description:
    "A hard delete, secret and pricing included. Applications using this provider start failing with provider_not_configured within a minute. To pause an instance reversibly instead, send status: \"disabled\" to PUT /v1/admin/providers/{id}.",
  security: managementSecurity,
  request: { params: ProviderIdPath },
  responses: {
    200: response("Provider deleted.", ProviderDeleteResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "get",
  path: "/v1/admin/provider-gateways",
  tags: ["Admin provider gateways"],
  operationId: "listProviderGateways",
  summary: "List reusable provider gateways",
  security: managementSecurity,
  responses: {
    200: response("Provider gateway metadata without tokens.", ProviderGatewayListResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/provider-gateways",
  tags: ["Admin provider gateways"],
  operationId: "createProviderGateway",
  summary: "Create a reusable provider gateway connection",
  description: "Cloudflare AI Gateway takes an account and gateway id; Vercel AI Gateway takes only a name and a token. The token is encrypted and stored as given, never probed: check a connection first with POST /v1/admin/provider-gateways/test. Provider instances are attached separately through the providers API.",
  security: managementSecurity,
  request: { body: { required: true, content: json(ProviderGatewayCreateRequestSchema) } },
  responses: {
    201: response("Created provider gateway.", ProviderGatewayResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/provider-gateways/test",
  tags: ["Admin provider gateways"],
  operationId: "testProviderGateway",
  summary: "Probe a gateway connection without storing it",
  description:
    "Calls the gateway with a token, and reports what it answered. Nothing is stored, and no other endpoint runs this check: a write stores what it is given. Unlike the providers API, a refused token is reported as reason: rejected rather than raised as provider_key_invalid, because the same 401 means both a wrong token and a gateway that is not finished being set up.",
  security: managementSecurity,
  request: { body: { required: true, content: json(ProviderGatewayTestRequestSchema) } },
  responses: {
    200: response("Probe outcome.", ProviderGatewayTestResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "patch",
  path: "/v1/admin/provider-gateways/{id}",
  tags: ["Admin provider gateways"],
  operationId: "updateProviderGateway",
  summary: "Rename a provider gateway",
  security: managementSecurity,
  request: {
    params: ProviderIdPath,
    body: { required: true, content: json(ProviderGatewayUpdateRequestSchema) },
  },
  responses: {
    200: response("Updated provider gateway.", ProviderGatewayResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/provider-gateways/{id}/rotate",
  tags: ["Admin provider gateways"],
  operationId: "rotateProviderGateway",
  summary: "Rotate a shared provider gateway token",
  description: "Re-encrypts the token once for every provider instance referencing this gateway. The new token is stored as given, never probed.",
  security: managementSecurity,
  request: {
    params: ProviderIdPath,
    body: { required: true, content: json(ProviderGatewayRotateRequestSchema) },
  },
  responses: {
    200: response("Rotated provider gateway.", ProviderGatewayResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "delete",
  path: "/v1/admin/provider-gateways/{id}",
  tags: ["Admin provider gateways"],
  operationId: "deleteProviderGateway",
  summary: "Delete an unused provider gateway",
  security: managementSecurity,
  request: { params: ProviderIdPath },
  responses: {
    200: response("Provider gateway deleted.", ProviderGatewayDeleteResponseSchema),
    409: response(
      "Provider instances still reference this gateway. Disabled rows are retained for re-enabling and block deletion too; see referencedCount.",
      ErrorResponseSchema,
    ),
    ...errorResponses,
  },
});

register({
  method: "get",
  path: "/v1/admin/session",
  tags: ["Admin organizations"],
  operationId: "getAdminSession",
  summary: "Get the caller's identity, current organization and role",
  description:
    "The console needs the caller's role and active organization to gate its UI; the sign-in session endpoint reports neither.",
  security: managementSecurity,
  responses: { 200: response("Resolved session.", IdentitySessionSchema), ...errorResponses },
});

register({
  method: "get",
  path: "/v1/admin/organizations",
  tags: ["Admin organizations"],
  operationId: "listOrganizations",
  summary: "List the organizations the caller belongs to",
  security: [{ ConsoleSession: [] }],
  responses: {
    200: response("Memberships ordered by organization creation time.", OrganizationListResponseSchema),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/organizations/select",
  tags: ["Admin organizations"],
  operationId: "selectOrganization",
  summary: "Switch the caller's active organization",
  description: "Available to every member, including read-only members, of the target organization.",
  security: [{ ConsoleSession: [] }],
  request: { body: { required: true, content: json(OrganizationSelectRequestSchema) } },
  responses: { 200: response("Session rescoped to the selected organization.", IdentitySessionSchema), ...errorResponses },
});

const adminRoutes: Omit<RouteConfig, "responses">[] = [
  { method: "get", path: "/v1/admin/apps/{app}/keys", operationId: "listAppKeys", summary: "List application API keys", request: { params: AppPath } },
  { method: "post", path: "/v1/admin/apps/{app}/keys", operationId: "createAppKey", summary: "Create an application API key", request: { params: AppPath, body: { required: true, content: json(z.object({ name: z.string().optional() })) } } },
  { method: "post", path: "/v1/admin/apps/{app}/keys/{key}/revoke", operationId: "revokeAppKey", summary: "Revoke an application API key", request: { params: KeyPath } },
  { method: "get", path: "/v1/admin/apps/{app}/users", operationId: "listAppUsers", summary: "List application users", request: { params: AppPath } },
  { method: "get", path: "/v1/admin/apps/{app}/users/{user}", operationId: "getAppUser", summary: "Get an application user", request: { params: UserPath } },
  { method: "post", path: "/v1/admin/apps/{app}/users/{user}/block", operationId: "blockAppUser", summary: "Block an application user", request: { params: UserPath } },
  { method: "post", path: "/v1/admin/apps/{app}/users/{user}/unblock", operationId: "unblockAppUser", summary: "Unblock an application user", request: { params: UserPath } },
  { method: "get", path: "/v1/admin/apps/{app}/usage", operationId: "getAppUsage", summary: "Get application usage totals", request: { params: AppPath } },
  { method: "post", path: "/v1/admin/apps/{app}/usage/reprice", operationId: "repriceAppUsage", summary: "Preview or apply current catalog prices to stored usage", request: { params: AppPath, body: { required: true, content: json(UsageRepriceRequestSchema) } } },
  { method: "get", path: "/v1/admin/apps/{app}/usage/timeseries", operationId: "getAppUsageTimeseries", summary: "Get application usage over time", request: { params: AppPath } },
  { method: "get", path: "/v1/admin/apps/{app}/usage/breakdown", operationId: "getAppUsageBreakdown", summary: "Get grouped application usage", request: { params: AppPath } },
  { method: "get", path: "/v1/admin/prices", operationId: "listModelPrices", summary: "List known model prices" },
];

register({
  method: "get",
  path: "/v1/admin/apps/{app}/events",
  operationId: "listAppEvents",
  summary: "List application usage events",
  tags: ["Admin operations"],
  security: managementSecurity,
  request: { params: AppPath },
  responses: { 200: response("Paginated application usage events.", UsageEventListSchema), ...errorResponses },
});

register({
  method: "get",
  path: "/v1/admin/apps/{app}/auth-events/summary",
  operationId: "getAppAuthEventSummary",
  summary: "Summarize application authentication outcomes",
  description: "Daily authentication outcomes and reasons, non-ok proxied requests, token-exchange success rate, entitlement-claim propagation delays, and how many users are waiting on a claim right now.",
  tags: ["Admin operations"],
  security: managementSecurity,
  request: {
    params: AppPath,
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).optional()
        .openapi({ description: "Trailing window in days, ending today. Defaults to 30." }),
    }),
  },
  responses: { 200: response("Authentication activity for the window.", AuthEventSummarySchema), ...errorResponses },
});

register({
  method: "get",
  path: "/v1/admin/apps/{app}/auth-events",
  operationId: "listAppAuthEvents",
  summary: "List application authentication events",
  tags: ["Admin operations"],
  security: managementSecurity,
  request: { params: AppPath },
  responses: { 200: response("Paginated authentication attempts, newest first.", AuthEventListSchema), ...errorResponses },
});

for (const route of adminRoutes) {
  register({
    ...route,
    tags: [route.path === "/v1/admin/prices" ? "Admin models" : "Admin operations"],
    security: managementSecurity,
    responses: { 200: response("Successful operation.", z.unknown()), ...errorResponses },
  });
}

const CliOperationPath = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const cliErrors = { ...errorResponses,
  409: response("A conflicting transition or setup cap prevents this operation.", ErrorResponseSchema),
  410: response("The protected credential exchange has expired; no replacement is minted.", ErrorResponseSchema),
  429: response("The durable initiation or submission rate limit was reached.", ErrorResponseSchema),
};
register({ method: "get", path: "/v1/cli/capabilities", tags: ["CLI"], operationId: "getCliCapabilities",
  summary: "Discover deployment identity and provider capabilities", responses: { 200: response("Public deployment capabilities. No credentials or inference calls.", CliCapabilitiesResponseSchema) } });
register({ method: "post", path: "/v1/cli/bootstrap", tags: ["CLI"], operationId: "bootstrapCliAccount",
  summary: "Initialize a recoverable CLI account",
  description: "Persist both random proofs before sending. An identical retry returns the same account and protected credential during its exchange window. Cloud initialization is public and rate limited. Self-hosted initialization is public too and creates the deployment's single initial account, so whoever initializes an empty deployment first owns it, exactly as its first console registration does. All responses are no-store.",
  request: { body: { required: true, content: json(CliBootstrapRequestSchema) } },
  responses: { 200: response("Initial account and credential. Never print or log the credential.", CliBootstrapResponseSchema), ...cliErrors } });
register({ method: "post", path: "/v1/cli/operations", tags: ["CLI"], operationId: "createCliOperation",
  summary: "Create or recover a browser handoff",
  description: "Persist pollToken before initiation. Repeating the same proof and payload recovers the same operation. A current account key is required. Claims require interactive human sign-in and explicit consent. Provider handoffs require the browser URL proof and show the exact resource configuration before secret submission. Handoffs expire after 15 minutes.",
  security: managementSecurity, request: { body: { required: true, content: json(CliOperationRequestSchema) } },
  responses: { 200: response("Browser URL for the pending handoff.", CliOperationResponseSchema), ...cliErrors } });
register({ method: "get", path: "/v1/cli/operations/{id}", tags: ["CLI"], operationId: "pollCliOperation",
  summary: "Poll a browser handoff", security: [{ CliPollProof: [] }], request: { params: CliOperationPath },
  description: "Only the original polling proof can recover the result. Completed claims report whether the existing service access was retained. Provider secrets are never returned.",
  responses: { 200: response("Current operation state and nonsecret result.", CliPollResponseSchema), ...cliErrors } });
register({ method: "get", path: "/v1/cli/account", tags: ["CLI"], operationId: "getCliAccount",
  summary: "Read account lifecycle and current access", security: managementSecurity,
  responses: { 200: response("Account deadlines, effective access and current request count.", z.object({ deployment: CliDeploymentSchema, account: CliAccountSchema,
    billing: z.record(z.string(), z.unknown()), usage: z.record(z.string(), z.unknown()).nullable() })), ...cliErrors } });
register({ method: "get", path: "/v1/cli/usage", tags: ["CLI"], operationId: "getCliUsage",
  summary: "Read retained account usage for a UTC month", security: managementSecurity,
  description: "Includes retained usage for deleted apps, with durable account attribution. Historical rows whose owner was already unknown when attribution was introduced cannot be counted. Coverage describes this limitation without disclosing other accounts' data.",
  request: { query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().describe("YYYY-MM; defaults to the current UTC month.") }) },
  responses: { 200: response("Account totals, per-app totals and attribution coverage.", CliUsageResponseSchema), ...cliErrors } });
register({ method: "get", path: "/v1/cli/browser/{id}", tags: ["CLI"], operationId: "getCliHandoffPage",
  summary: "Open the first-party human handoff page", request: { params: CliOperationPath },
  responses: { 200: { description: "No-store browser page. The submission proof arrives only in the URL fragment.", content: { "text/html": { schema: z.string() } } }, ...cliErrors } });
for (const action of ["details", "submit", "register", "google"] as const) {
  register({ method: "post", path: `/v1/cli/browser/{id}/${action}`, tags: ["CLI"], operationId: `cliBrowser${action[0]!.toUpperCase()}${action.slice(1)}`,
    summary: `Browser handoff: ${action}`, description: "First-party browser only: both the request URL origin and exact Origin header must match consoleOrigin; a separate submissionToken is required. Identity approval also requires an interactive human session; registration is limited to a valid pending claim. Provider secret values are write-only.",
    request: { params: CliOperationPath, body: { required: true, content: json(CliSubmissionRequestSchema) } },
    responses: { 200: response("Nonsecret browser handoff result or authentication redirect metadata.", z.record(z.string(), z.unknown())), ...cliErrors } });
}

export function createOpenAPIDocument({ includeHidden = true } = {}) {
  const target = includeHidden ? registry : documentationRegistry;
  return target.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "App AI Gateway API",
      version: "0.1.0",
      description: "A provider-native AI proxy for iOS applications and trusted server backends. Provider keys stay on the gateway; requests are checked, limited and recorded before they reach a provider.",
    },
    servers: [{ url: "https://api.appaigateway.com", description: "The cloud API host. On a self-hosted gateway, use your own origin." }],
    tags: [
      { name: "CLI", description: "CLI discovery, protected initialization and human browser handoffs." },
      { name: "Operations", description: "Unauthenticated service health." },
      { name: "Console authentication", description: "Sign-up, sign-in and session lifecycle for the console." },
      { name: "Application authentication", description: "Issuer identity plus App Attest or API-key client proof." },
      { name: "Application", description: "Authenticated application-user state." },
      { name: "Provider proxy", description: "Provider-native streaming proxy endpoints." },
      { name: "Named endpoints", description: "Server-configured provider and model behind a stable slug." },
      { name: "Admin applications", description: "Application configuration lifecycle." },
      { name: "Admin operations", description: "Keys, users, and usage." },
      { name: "Admin management keys", description: "agw_mgmt_ credentials for scripts, CI and agents. They never expire, and are created and revoked from the console only." },
      { name: "Admin providers", description: "Named provider instances and their credentials." },
      { name: "Admin provider gateways", description: "Reusable Cloudflare AI Gateway connections shared by provider instances." },
      { name: "Admin organizations", description: "Caller identity and organization switching." },
      { name: "Admin billing", description: "Optional billing service-binding operations." },
      { name: "Admin models", description: "Model pricing metadata." },
    ],
  });
}
