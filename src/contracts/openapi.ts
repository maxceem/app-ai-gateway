import { OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import { PROVIDER_SLUG_PATTERN, PROVIDER_TYPES } from "../core/providers.ts";
import {
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
  ApiKeyTokenRequestSchema,
  AppWriteSchema,
  GatewayRouteConfigSchema,
  OrganizationRoleSchema,
  OrganizationSelectRequestSchema,
  ProviderCreateRequestSchema,
  ProviderGatewayCreateRequestSchema,
  ProviderGatewayRotateRequestSchema,
  ProviderGatewayUpdateRequestSchema,
  ProviderPricingSchema,
  ProviderTestRequestSchema,
  ProviderUpdateRequestSchema,
  UsageRepriceRequestSchema,
} from "./schemas.ts";

export {
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
  ApiKeyTokenRequestSchema,
  AppConfigSchema,
  AppWriteSchema,
  GatewayRouteConfigSchema,
  OrganizationRoleSchema,
  OrganizationSelectRequestSchema,
  ProviderCreateRequestSchema,
  ProviderGatewayCreateRequestSchema,
  ProviderGatewayRotateRequestSchema,
  ProviderGatewayUpdateRequestSchema,
  ProviderPricingSchema,
  SlugSchema,
  ProviderTestRequestSchema,
  ProviderUpdateRequestSchema,
  UsageRepriceRequestSchema,
} from "./schemas.ts";

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
}).openapi("ErrorResponse");

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

const UsageEventSchema = z.object({
  id: z.number().int(),
  user_id: z.string(),
  api_key_id: z.string().nullable().openapi({
    description: "Non-secret ID of the application API key that authenticated the request, including the client-proof key carried by an exchanged gateway token.",
  }),
  provider: z.string(),
  provider_slug: z.string().nullable(),
  provider_gateway_id: z.string().nullable().openapi({
    description: "The gateway connection that carried the request, or null for a direct call. Recorded for every routed request; the id is kept even after the gateway row is deleted.",
  }),
  provider_gateway_type: z.string().nullable().openapi({
    description: "That gateway's type at request time, for example cf_aig.",
  }),
  credential_source: z.enum(["direct", "byok", "gateway_system", "unknown"]).nullable().openapi({
    description: "Whose credential paid, where something settles it: `direct` for an instance holding its own key, `byok` when a gateway serves it from the organization's own key store or when a reporting upstream says the organization's own key paid for the inference. Never inferred from a successful response; null when nothing settles it.",
  }),
  model_author: z.string().nullable().openapi({
    description: "Who made the model, resolved when the event was recorded. An analytics dimension only — it never affects budgets or allowlists.",
  }),
  served_provider: z.string().nullable().openapi({
    description: "The serving provider the upstream named, when it names one — the host OpenRouter routed to, for instance. Null means unknown, never a guarantee.",
  }),
  served_model: z.string().nullable().openapi({
    description: "The serving model the upstream named, canonicalized back to the provider's own model ID.",
  }),
  model: z.string(),
  route: z.string(),
  endpoint_slug: z.string().nullable(),
  input_tokens: z.number().int(),
  cached_input_tokens: z.number().int(),
  cache_write_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cost_usd: z.number(),
  reported_cost_usd: z.number().nullable().openapi({
    description: "What the upstream said the request cost, on routes that report one. Null everywhere else; cost_usd stays the billed figure either way.",
  }),
  cost_source: z.enum(["computed", "reported", "unresolved"]).nullable().openapi({
    description: "How cost_usd was determined. `reported` is the upstream's own figure for this request, which is what was billed; `computed` is this deployment's price catalog; `unresolved` means the provider answered successfully but neither source could establish a cost, so the zero is unknown rather than measured. Null on blocked traffic and on events recorded before this field existed.",
  }),
  app_version: z.string().nullable(),
  auth_method: z.enum(["attest", "api_key"]).nullable(),
  status: z.enum(["ok", "provider_error", "blocked_rate", "blocked_budget", "blocked_user"]),
  latency_ms: z.number().int().nullable(),
  created_at: z.string(),
}).openapi("UsageEvent");

const UsageEventListSchema = z.object({
  app_id: z.string(),
  limit: z.number().int(),
  next_before_id: z.number().int().nullable(),
  events: z.array(UsageEventSchema),
});

const registry = new OpenAPIHono();
registry.openAPIRegistry.registerComponent("securitySchemes", "ManagementBearer", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "agw_mgmt_…",
  description: "An organization-scoped management API key created by an owner or admin.",
});
registry.openAPIRegistry.registerComponent("securitySchemes", "OperatorSession", {
  type: "apiKey",
  in: "cookie",
  name: "agw_operator_auth.session_token",
  description: "The Better Auth operator session cookie. Admin requests also send x-console-request: 1.",
});
registry.openAPIRegistry.registerComponent("securitySchemes", "GatewayBearer", {
  type: "http",
  scheme: "bearer",
  description: "A gateway access token, or an application API key for an issuer-less API-key app.",
});

function register(route: RouteConfig): void {
  registry.openAPIRegistry.registerPath(route);
}

const operatorSecurity: RouteConfig["security"] = [
  { OperatorSession: [] },
  { ManagementBearer: [] },
];

register({
  method: "get",
  path: "/v1/healthz",
  tags: ["Operations"],
  operationId: "getHealth",
  summary: "Check gateway health",
  responses: {
    200: response("The Worker is accepting requests.", z.object({
      ok: z.literal(true),
      service: z.literal("ai-gateway"),
      vault: z.enum(["ok", "misconfigured"]),
    })),
  },
});

register({
  method: "get",
  path: "/v1/console/capabilities",
  tags: ["Operations"],
  operationId: "getConsoleCapabilities",
  summary: "Discover optional deployment capabilities",
  responses: {
    200: response("Capabilities used by operator clients.", z.object({
      billing: z.boolean(),
      registrationOpen: z.boolean(),
      googleAuth: z.boolean(),
    })),
  },
});

for (const authRoute of [
  {
    method: "post",
    path: "/v1/auth/sign-up/email",
    operationId: "signUpOperator",
    summary: "Create an operator account and its initial organization",
    body: z.object({ name: z.string(), email: z.email(), password: z.string().min(8) }),
  },
  {
    method: "post",
    path: "/v1/auth/sign-in/email",
    operationId: "signInOperator",
    summary: "Sign in an operator with email and password",
    body: z.object({ email: z.email(), password: z.string() }),
  },
] as const) {
  register({
    method: authRoute.method,
    path: authRoute.path,
    tags: ["Operator authentication"],
    operationId: authRoute.operationId,
    summary: authRoute.summary,
    request: { body: { required: true, content: json(authRoute.body) } },
    responses: {
      200: response("Authenticated operator session.", z.unknown()),
      ...errorResponses,
    },
  });
}

register({
  method: "get",
  path: "/v1/auth/get-session",
  tags: ["Operator authentication"],
  operationId: "getOperatorSession",
  summary: "Get the current operator session",
  security: [{ OperatorSession: [] }],
  responses: { 200: response("Current session or null.", z.unknown()), ...errorResponses },
});

register({
  method: "post",
  path: "/v1/auth/sign-out",
  tags: ["Operator authentication"],
  operationId: "signOutOperator",
  summary: "End the current operator session",
  security: [{ OperatorSession: [] }],
  responses: { 200: response("Session ended.", z.unknown()), ...errorResponses },
});

register({
  method: "get",
  path: "/v1/auth/sign-in/social",
  tags: ["Operator authentication"],
  operationId: "signInOperatorWithGoogle",
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
    200: response("A five-minute, single-use challenge.", z.object({ challenge: z.string(), expires_in: z.number() })),
    ...errorResponses,
    402: response("The organization requires an active subscription or trial.", ErrorResponseSchema),
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
    200: response("The key was registered for the verified issuer identity.", z.object({ user_id: z.string() })),
    ...errorResponses,
    402: response("The organization requires an active subscription or trial.", ErrorResponseSchema),
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
    402: response("The organization requires an active subscription or trial.", ErrorResponseSchema),
  },
});

register({
  method: "get",
  path: "/v1/apps/{app}/me",
  tags: ["Application"],
  operationId: "getCurrentUser",
  summary: "Get the current user's limits and usage",
  security: [{ GatewayBearer: [] }],
  request: { params: AppPath },
  responses: {
    200: response("Current user state.", z.object({
      user_id: z.string(),
      limits: z.object({
        requests_today: z.number(),
        requests_remaining: z.number().nullable(),
        monthly_cost_usd: z.number(),
        monthly_budget_usd: z.number().nullable(),
        blocked: z.boolean(),
      }),
    })),
    ...errorResponses,
    402: response("The organization requires an active subscription or trial.", ErrorResponseSchema),
  },
});

register({
  method: "post",
  path: "/v1/apps/{app}/proxy/{provider}/{path}",
  tags: ["Provider proxy"],
  operationId: "proxyProviderRequest",
  summary: "Proxy a provider-native model request",
  description: "The path, body, and successful response retain the selected provider's native contract. For example, OpenAI clients send v1/responses or v1/chat/completions; gateway-specific provider slug quirks are never part of the client path. The gateway validates the configured path and model, applies limits, and streams the upstream response without buffering.",
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
    402: response("The organization requires an active subscription or trial.", ErrorResponseSchema),
    429: response("A request or spending limit was reached.", ErrorResponseSchema),
    502: response("The upstream provider request failed.", ErrorResponseSchema),
  },
});

register({
  method: "post",
  path: "/v1/apps/{app}/endpoints/{slug}",
  tags: ["Named endpoints"],
  operationId: "callNamedEndpoint",
  summary: "Call a server-configured named endpoint",
  description: "The endpoint's provider, model, fixed parameters, output cap, and fallback chain come from the application configuration, so an operator can change models without shipping a client release. Responses-style endpoints accept an OpenAI Responses body; transcription-style endpoints accept an OpenAI audio transcription multipart body and may omit the model field. The successful response keeps the serving provider's native format and streaming behaviour.",
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
    402: response("The organization requires an active subscription or trial.", ErrorResponseSchema),
    429: response("A request or spending limit was reached.", ErrorResponseSchema),
    502: response("Every configured target failed.", ErrorResponseSchema),
  },
});

register({
  method: "get",
  path: "/v1/admin/apps",
  tags: ["Admin applications"],
  operationId: "listApps",
  summary: "List applications",
  security: operatorSecurity,
  responses: { 200: response("Applications and current usage summaries.", z.object({ month: z.string(), apps: z.array(z.unknown()) })), ...errorResponses },
});

register({
  method: "post",
  path: "/v1/admin/apps",
  tags: ["Admin applications"],
  operationId: "createApp",
  summary: "Create an application",
  description: "API-key applications receive a one-time plaintext initial key in the response.",
  security: operatorSecurity,
  request: { body: { required: true, content: json(AppWriteSchema) } },
  responses: {
    201: response("Application created.", z.object({ app_id: z.string(), api_key: z.unknown().nullable() })),
    ...errorResponses,
    409: response("A unique application ID could not be allocated.", ErrorResponseSchema),
  },
});

const BillingPlanSelectionSchema = z.object({
  planKey: z.string().min(1),
  billingPeriod: z.enum(["month", "year"]),
});

for (const route of [
  { path: "/v1/admin/billing/plans", operationId: "listBillingPlans", summary: "List billing plans" },
  { path: "/v1/admin/billing/status", operationId: "getBillingStatus", summary: "Get organization billing access" },
  { path: "/v1/admin/billing/portal/status", operationId: "getBillingPortalStatus", summary: "Poll billing portal/access status" },
] as const) {
  register({
    method: "get",
    path: route.path,
    tags: ["Admin billing"],
    operationId: route.operationId,
    summary: route.summary,
    security: operatorSecurity,
    responses: { 200: response("Billing service response.", z.unknown()), ...errorResponses },
  });
}

register({
  method: "post",
  path: "/v1/admin/billing/checkout",
  tags: ["Admin billing"],
  operationId: "createBillingCheckout",
  summary: "Create a hosted checkout",
  security: operatorSecurity,
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
    operationId: route.operationId,
    summary: route.summary,
    security: operatorSecurity,
    request: { body: { required: true, content: json(BillingPlanSelectionSchema) } },
    responses: { 200: response("Billing service response.", z.unknown()), ...errorResponses },
  });
}

register({
  method: "post",
  path: "/v1/admin/billing/cancel",
  tags: ["Admin billing"],
  operationId: "cancelBillingSubscription",
  summary: "Cancel the subscription at period end",
  security: operatorSecurity,
  responses: { 200: response("Cancellation accepted.", z.object({ ok: z.literal(true) })), ...errorResponses },
});

register({
  method: "post",
  path: "/v1/admin/billing/trial",
  tags: ["Admin billing"],
  operationId: "startBillingTrial",
  summary: "Start a no-card trial",
  security: operatorSecurity,
  request: { body: { required: true, content: json(z.object({ planKey: z.string().min(1) })) } },
  responses: { 200: response("Trial access state.", z.unknown()), ...errorResponses },
});

for (const definition of [
  { method: "get", operationId: "getApp", summary: "Get an application" },
  { method: "put", operationId: "updateApp", summary: "Update an application" },
] as const) {
  register({
    method: definition.method,
    path: "/v1/admin/apps/{app}",
    tags: ["Admin applications"],
    operationId: definition.operationId,
    summary: definition.summary,
    security: operatorSecurity,
    request: {
      params: AppPath,
      ...(definition.method === "put" ? { body: { required: true, content: json(AppWriteSchema) } } : {}),
    },
    responses: { 200: response("Application state.", z.unknown()), ...errorResponses },
  });
}

register({
  method: "post",
  path: "/v1/admin/apps/{app}/validate",
  tags: ["Admin applications"],
  operationId: "validateApp",
  summary: "Validate an application configuration without saving it",
  security: operatorSecurity,
  request: { params: AppPath, body: { required: true, content: json(AppWriteSchema) } },
  responses: { 200: response("Resolved valid configuration.", z.unknown()), ...errorResponses },
});

register({
  method: "delete",
  path: "/v1/admin/apps/{app}",
  tags: ["Admin applications"],
  operationId: "deleteApp",
  summary: "Delete an application and its associated operational data",
  security: operatorSecurity,
  request: { params: AppPath, query: z.object({ confirm: z.string() }) },
  responses: { 200: response("Application deleted.", z.object({ deleted: z.literal(true), app_id: z.string() })), ...errorResponses },
});

const ManagementKeySummarySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  tokenHint: z.string().nullable().openapi({
    description: "Last characters of the token for display. Null for keys created before hints were recorded.",
    example: "x9Qb",
  }),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

register({
  method: "get",
  path: "/v1/admin/keys",
  tags: ["Admin management keys"],
  operationId: "listManagementKeys",
  summary: "List management keys for the current organization",
  security: [{ OperatorSession: [] }],
  responses: {
    200: response("Management key metadata without plaintext tokens.", z.object({
      keys: z.array(ManagementKeySummarySchema),
    })),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/keys",
  tags: ["Admin management keys"],
  operationId: "createManagementKey",
  summary: "Create a management key for the current organization",
  description: "Requires an owner/admin user session. The plaintext agw_mgmt_ token is returned once.",
  security: [{ OperatorSession: [] }],
  request: { body: { required: true, content: json(z.object({ name: z.string().min(1).max(100) })) } },
  responses: {
    201: response("One-time plaintext management key.", z.object({
      key: ManagementKeySummarySchema.extend({ plaintext: z.string() }),
    })),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/keys/{id}/revoke",
  tags: ["Admin management keys"],
  operationId: "revokeManagementKey",
  summary: "Revoke a management key",
  description: "Requires an owner/admin user session.",
  security: [{ OperatorSession: [] }],
  request: { params: ManagementKeyPath },
  responses: {
    200: response("Revoked management key metadata.", z.object({ key: ManagementKeySummarySchema })),
    ...errorResponses,
  },
});

const ProviderIdPath = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, example: "b0a1…" }),
});

const ProviderSummarySchema = z.object({
  id: z.string(),
  type: z.enum(PROVIDER_TYPES),
  slug: ProviderSlugSchema.openapi({ description: "Organization-unique URL segment used under /proxy/{slug}/." }),
  name: z.string(),
  secretHint: z.string().nullable().openapi({
    description: "Last characters of a direct provider key; null when a shared provider gateway owns the token.",
  }),
  providerGatewayId: z.string().nullable(),
  gatewayRoute: GatewayRouteConfigSchema.nullable().openapi({
    description: "How this instance is routed inside its gateway. Always null for a direct instance and for gateways that take no routing configuration, such as Cloudflare AI Gateway.",
  }),
  pricing: ProviderPricingSchema.nullable(),
  status: z.enum(["active", "revoked"]),
  createdAt: z.string(),
  createdBy: z.string(),
}).openapi("Provider");

const ProviderValidatedSchema = z.boolean().openapi({
  description: "Whether a live probe confirmed the credential. false means the probe was inconclusive (provider outage, or no probe exists for this provider), not that the credential is bad — a rejected credential fails the request with provider_key_invalid.",
});

register({
  method: "get",
  path: "/v1/admin/providers",
  tags: ["Admin providers"],
  operationId: "listProviders",
  summary: "List the organization's provider credentials",
  security: operatorSecurity,
  responses: {
    200: response("Provider metadata without credentials.", z.object({
      providers: z.array(ProviderSummarySchema),
    })),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/providers",
  tags: ["Admin providers"],
  operationId: "createProvider",
  summary: "Store a provider credential for the organization",
  description:
    "Creates one named provider instance. Supply exactly one direct provider secret or reusable providerGatewayId. The slug defaults to the provider type and is unique among active instances.",
  security: operatorSecurity,
  request: { body: { required: true, content: json(ProviderCreateRequestSchema) } },
  responses: {
    201: response("Stored provider.", z.object({
      provider: ProviderSummarySchema,
      validated: ProviderValidatedSchema,
    })),
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
    "Runs the same live probe a create runs, against a credential that does not exist yet. Nothing is stored. Supply exactly one direct provider secret or an existing providerGatewayId.",
  security: operatorSecurity,
  request: { body: { required: true, content: json(ProviderTestRequestSchema) } },
  responses: {
    200: response("Probe outcome.", z.object({
      validated: ProviderValidatedSchema,
      reason: z.enum(["no_probe", "unreachable", "unexpected_status"]).optional().openapi({
        description: "Why an unvalidated probe proved nothing. Absent when validated is true.",
      }),
      status: z.number().int().optional().openapi({
        description: "The upstream status behind an unexpected_status reason.",
      }),
    })),
    ...errorResponses,
  },
});

register({
  method: "put",
  path: "/v1/admin/providers/{id}",
  tags: ["Admin providers"],
  operationId: "updateProvider",
  summary: "Rotate a credential, rename it, or replace its custom pricing",
  security: operatorSecurity,
  request: {
    params: ProviderIdPath,
    body: { required: true, content: json(ProviderUpdateRequestSchema) },
  },
  responses: {
    200: response("Updated provider.", z.object({
      provider: ProviderSummarySchema,
      validated: ProviderValidatedSchema.nullable().openapi({
        description: "null when the request did not rotate the credential.",
      }),
    })),
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
    "A hard delete. Applications using this provider start failing with provider_not_configured within a minute.",
  security: operatorSecurity,
  request: { params: ProviderIdPath },
  responses: {
    200: response("Provider deleted.", z.object({
      deleted: z.literal(true),
      provider_id: z.string(),
    })),
    ...errorResponses,
  },
});

/** Everything about a gateway that does not depend on which gateway it is. */
const providerGatewayFields = {
  id: z.string(),
  name: z.string(),
  secretHint: z.string().openapi({
    description: "The last characters of the gateway token. The token itself is never returned.",
  }),
  providerCount: z.number().int().nonnegative().openapi({
    description: "Active provider instances routed through this gateway.",
  }),
  referencedCount: z.number().int().nonnegative().openapi({
    description:
      "All provider instances referencing this gateway, including revoked rows retained for audit. Deletion is refused while this is above zero.",
  }),
  status: z.enum(["active", "revoked"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
};

/**
 * Discriminated by `type`, because each gateway's `config` is its own shape:
 * Cloudflare's account and gateway pair, and nothing at all for Vercel, whose
 * origin is fixed in adapter code and whose team is named by the token.
 */
const ProviderGatewaySummarySchema = z.discriminatedUnion("type", [
  z.object({
    ...providerGatewayFields,
    type: z.literal("cf_aig"),
    config: z.object({ accountId: z.string(), gatewayId: z.string() }),
  }),
  z.object({
    ...providerGatewayFields,
    type: z.literal("vercel"),
    config: z.object({}).openapi({
      description: "Vercel's origin is fixed in adapter code, so it has no configuration of its own.",
    }),
  }),
]).openapi("ProviderGateway");

register({
  method: "get",
  path: "/v1/admin/provider-gateways",
  tags: ["Admin provider gateways"],
  operationId: "listProviderGateways",
  summary: "List reusable provider gateways",
  security: operatorSecurity,
  responses: {
    200: response("Provider gateway metadata without tokens.", z.object({
      gateways: z.array(ProviderGatewaySummarySchema),
    })),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/provider-gateways",
  tags: ["Admin provider gateways"],
  operationId: "createProviderGateway",
  summary: "Create a reusable provider gateway connection",
  description: "Cloudflare AI Gateway takes an account and gateway id; Vercel AI Gateway takes only a name and a token. Probes and encrypts the gateway token once. Provider instances are attached separately through the providers API.",
  security: operatorSecurity,
  request: { body: { required: true, content: json(ProviderGatewayCreateRequestSchema) } },
  responses: {
    201: response("Created provider gateway.", z.object({
      gateway: ProviderGatewaySummarySchema,
      validated: ProviderValidatedSchema,
    })),
    ...errorResponses,
  },
});

register({
  method: "patch",
  path: "/v1/admin/provider-gateways/{id}",
  tags: ["Admin provider gateways"],
  operationId: "updateProviderGateway",
  summary: "Rename a provider gateway",
  security: operatorSecurity,
  request: {
    params: ProviderIdPath,
    body: { required: true, content: json(ProviderGatewayUpdateRequestSchema) },
  },
  responses: {
    200: response("Updated provider gateway.", z.object({ gateway: ProviderGatewaySummarySchema })),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/provider-gateways/{id}/rotate",
  tags: ["Admin provider gateways"],
  operationId: "rotateProviderGateway",
  summary: "Rotate a shared provider gateway token",
  description: "Re-probes and re-encrypts the token once for every provider instance referencing this gateway.",
  security: operatorSecurity,
  request: {
    params: ProviderIdPath,
    body: { required: true, content: json(ProviderGatewayRotateRequestSchema) },
  },
  responses: {
    200: response("Rotated provider gateway.", z.object({
      gateway: ProviderGatewaySummarySchema,
      validated: ProviderValidatedSchema,
    })),
    ...errorResponses,
  },
});

register({
  method: "delete",
  path: "/v1/admin/provider-gateways/{id}",
  tags: ["Admin provider gateways"],
  operationId: "deleteProviderGateway",
  summary: "Delete an unused provider gateway",
  security: operatorSecurity,
  request: { params: ProviderIdPath },
  responses: {
    200: response("Provider gateway deleted.", z.object({
      deleted: z.literal(true),
      provider_gateway_id: z.string(),
    })),
    409: response(
      "Provider instances still reference this gateway. Revoked rows are retained for audit and block deletion too; see referencedCount.",
      ErrorResponseSchema,
    ),
    ...errorResponses,
  },
});

const OrganizationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

const OrganizationMembershipSchema = z.object({
  organization: OrganizationSummarySchema,
  role: OrganizationRoleSchema,
  status: z.literal("active"),
  joinedAt: z.string(),
});

const OperatorSessionSchema = z.object({
  session: z.object({
    user: z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string(),
      emailVerified: z.boolean(),
      image: z.string().nullable(),
      createdAt: z.string(),
    }).nullable(),
    organization: OrganizationSummarySchema.nullable(),
    role: OrganizationRoleSchema,
    memberships: z.array(OrganizationMembershipSchema),
    credentialType: z.enum(["session", "apiKey"]),
  }),
});

register({
  method: "get",
  path: "/v1/admin/session",
  tags: ["Admin organizations"],
  operationId: "getOperatorContext",
  summary: "Get the caller's identity, current organization and role",
  description:
    "Operator clients need the caller's role and active organization to gate their UI; the Better Auth session endpoint reports neither.",
  security: operatorSecurity,
  responses: { 200: response("Resolved operator session.", OperatorSessionSchema), ...errorResponses },
});

register({
  method: "get",
  path: "/v1/admin/organizations",
  tags: ["Admin organizations"],
  operationId: "listOperatorOrganizations",
  summary: "List the organizations the caller belongs to",
  security: [{ OperatorSession: [] }],
  responses: {
    200: response("Memberships ordered by organization creation time.", z.object({
      organizations: z.array(OrganizationMembershipSchema),
    })),
    ...errorResponses,
  },
});

register({
  method: "post",
  path: "/v1/admin/organizations/select",
  tags: ["Admin organizations"],
  operationId: "selectOperatorOrganization",
  summary: "Switch the caller's active organization",
  description: "Available to every member, including read-only members, of the target organization.",
  security: [{ OperatorSession: [] }],
  request: { body: { required: true, content: json(OrganizationSelectRequestSchema) } },
  responses: { 200: response("Session rescoped to the selected organization.", OperatorSessionSchema), ...errorResponses },
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
  security: operatorSecurity,
  request: { params: AppPath },
  responses: { 200: response("Paginated application usage events.", UsageEventListSchema), ...errorResponses },
});

for (const route of adminRoutes) {
  register({
    ...route,
    tags: [route.path === "/v1/admin/prices" ? "Admin models" : "Admin operations"],
    security: operatorSecurity,
    responses: { 200: response("Successful operation.", z.unknown()), ...errorResponses },
  });
}

export function createOpenAPIDocument() {
  return registry.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "App AI Gateway API",
      version: "0.1.0",
      description: "A multi-tenant, provider-native LLM proxy for mobile applications and trusted server backends.",
    },
    servers: [{ url: "https://gateway.example.com", description: "Replace with your deployed gateway origin" }],
    tags: [
      { name: "Operations", description: "Unauthenticated service health." },
      { name: "Operator authentication", description: "Better Auth signup and session lifecycle." },
      { name: "Application authentication", description: "Issuer identity plus App Attest or API-key client proof." },
      { name: "Application", description: "Authenticated application-user state." },
      { name: "Provider proxy", description: "Provider-native streaming proxy endpoints." },
      { name: "Named endpoints", description: "Server-configured provider and model behind a stable slug." },
      { name: "Admin applications", description: "Application configuration lifecycle." },
      { name: "Admin operations", description: "Keys, users, and usage." },
      { name: "Admin management keys", description: "Organization-scoped agw_mgmt_ credentials." },
      { name: "Admin providers", description: "Named provider instances and their credentials." },
      { name: "Admin provider gateways", description: "Reusable Cloudflare AI Gateway connections shared by provider instances." },
      { name: "Admin organizations", description: "Operator identity and organization switching." },
      { name: "Admin billing", description: "Optional cf-billing service-binding operations." },
      { name: "Admin models", description: "Model pricing metadata." },
    ],
  });
}
