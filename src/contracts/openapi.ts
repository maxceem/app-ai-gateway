import { OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import {
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
  AppWriteSchema,
  DevelopmentTokenRequestSchema,
  UsageRepriceRequestSchema,
} from "./schemas.ts";

export {
  AppAttestRegisterRequestSchema,
  AppAttestTokenRequestSchema,
  AppConfigSchema,
  AppWriteSchema,
  DevelopmentTokenRequestSchema,
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

const ProviderPath = AppPath.extend({
  provider: z.enum(["openai", "anthropic", "xai", "gemini", "perplexity"])
    .openapi({ param: { name: "provider", in: "path" } }),
  path: z.string().openapi({ param: { name: "path", in: "path" }, example: "v1/responses" }),
});

const EndpointPath = AppPath.extend({
  slug: z.string().regex(/^[a-z0-9-]{1,64}$/u)
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
  description: "A gateway access token or server application API key.",
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
  },
});

register({
  method: "post",
  path: "/v1/apps/{app}/auth/token",
  tags: ["Application authentication"],
  operationId: "exchangeGatewayToken",
  summary: "Exchange issuer and device proof for a gateway token",
  description: "App Attest clients send key_id, assertion, and challenge. Development clients send dev_secret instead.",
  request: {
    params: AppPath,
    body: { required: true, content: json(z.union([
      AppAttestTokenRequestSchema,
      DevelopmentTokenRequestSchema,
    ])) },
  },
  responses: {
    200: response("A short-lived gateway access token.", z.object({ access_token: z.string(), expires_in: z.number() })),
    ...errorResponses,
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
  },
});

register({
  method: "post",
  path: "/v1/apps/{app}/proxy/{provider}/{path}",
  tags: ["Provider proxy"],
  operationId: "proxyProviderRequest",
  summary: "Proxy a provider-native model request",
  description: "The body and successful response retain the selected provider's native format. The gateway validates the configured path and model, injects provider credentials through Cloudflare AI Gateway, applies limits, and streams the upstream response without buffering.",
  security: [{ GatewayBearer: [] }],
  request: {
    params: ProviderPath,
    headers: z.object({
      "x-app-version": z.string().optional().openapi({ description: "Required for issuer/App Attest clients; optional for server API keys." }),
      "x-end-user-id": z.string().optional().openapi({ description: "Optional configured end-user identity for server applications." }),
    }),
    body: { required: true, content: json(z.record(z.string(), z.unknown()).openapi({
      description: "Provider-native JSON request. Consult the selected provider's API reference for the exact shape.",
    })) },
  },
  responses: {
    200: response("Provider-native response. Streaming responses remain streamed.", z.unknown()),
    ...errorResponses,
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
      "x-app-version": z.string().optional().openapi({ description: "Required for issuer/App Attest clients; optional for server API keys." }),
      "x-end-user-id": z.string().optional().openapi({ description: "Optional configured end-user identity for server applications." }),
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

const adminRoutes: Omit<RouteConfig, "responses">[] = [
  { method: "get", path: "/v1/admin/apps/{app}/keys", operationId: "listAppKeys", summary: "List application API keys", request: { params: AppPath } },
  { method: "post", path: "/v1/admin/apps/{app}/keys", operationId: "createAppKey", summary: "Create an application API key", request: { params: AppPath, body: { required: true, content: json(z.object({ name: z.string().optional() })) } } },
  { method: "post", path: "/v1/admin/apps/{app}/keys/{key}/revoke", operationId: "revokeAppKey", summary: "Revoke an application API key", request: { params: KeyPath } },
  { method: "get", path: "/v1/admin/apps/{app}/development-credential", operationId: "getDevelopmentCredential", summary: "Get development credential metadata", request: { params: AppPath } },
  { method: "post", path: "/v1/admin/apps/{app}/development-credential", operationId: "createDevelopmentCredential", summary: "Create a development credential", request: { params: AppPath } },
  { method: "post", path: "/v1/admin/apps/{app}/development-credential/rotate", operationId: "rotateDevelopmentCredential", summary: "Rotate a development credential", request: { params: AppPath } },
  { method: "delete", path: "/v1/admin/apps/{app}/development-credential", operationId: "deleteDevelopmentCredential", summary: "Delete a development credential", request: { params: AppPath } },
  { method: "get", path: "/v1/admin/apps/{app}/users", operationId: "listAppUsers", summary: "List application users", request: { params: AppPath } },
  { method: "get", path: "/v1/admin/apps/{app}/users/{user}", operationId: "getAppUser", summary: "Get an application user", request: { params: UserPath } },
  { method: "post", path: "/v1/admin/apps/{app}/users/{user}/block", operationId: "blockAppUser", summary: "Block an application user", request: { params: UserPath } },
  { method: "post", path: "/v1/admin/apps/{app}/users/{user}/unblock", operationId: "unblockAppUser", summary: "Unblock an application user", request: { params: UserPath } },
  { method: "get", path: "/v1/admin/apps/{app}/usage", operationId: "getAppUsage", summary: "Get application usage totals", request: { params: AppPath } },
  { method: "post", path: "/v1/admin/apps/{app}/usage/reprice", operationId: "repriceAppUsage", summary: "Preview or apply current catalog prices to stored usage", request: { params: AppPath, body: { required: true, content: json(UsageRepriceRequestSchema) } } },
  { method: "get", path: "/v1/admin/apps/{app}/usage/timeseries", operationId: "getAppUsageTimeseries", summary: "Get application usage over time", request: { params: AppPath } },
  { method: "get", path: "/v1/admin/apps/{app}/usage/breakdown", operationId: "getAppUsageBreakdown", summary: "Get grouped application usage", request: { params: AppPath } },
  { method: "get", path: "/v1/admin/apps/{app}/events", operationId: "listAppEvents", summary: "List application usage events", request: { params: AppPath } },
  { method: "get", path: "/v1/admin/prices", operationId: "listModelPrices", summary: "List known model prices" },
];

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
      { name: "Application authentication", description: "Issuer and Apple App Attest token exchange." },
      { name: "Application", description: "Authenticated application-user state." },
      { name: "Provider proxy", description: "Provider-native streaming proxy endpoints." },
      { name: "Named endpoints", description: "Server-configured provider and model behind a stable slug." },
      { name: "Admin applications", description: "Application configuration lifecycle." },
      { name: "Admin operations", description: "Keys, users, credentials, and usage." },
      { name: "Admin management keys", description: "Organization-scoped agw_mgmt_ credentials." },
      { name: "Admin models", description: "Model pricing metadata." },
    ],
  });
}
