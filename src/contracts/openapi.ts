/**
 * The OpenAPI document, derived from `./catalog.ts`.
 *
 * Nothing about an operation is written here: this module knows how to turn a
 * catalog entry into a `RouteConfig`, and that is all. What an endpoint is —
 * its method, path, parameters, schemas and prose — is declared once, in the
 * catalog, which the server mounts and both clients call through.
 *
 * This and `scripts/generate-openapi.ts` are the only modules that import
 * `@hono/zod-openapi`, which is why the catalog itself is plain zod.
 */
import { OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import {
  CATALOG,
  NO_RESPONSE_BODY,
  type OperationName,
  type OperationSpec,
  type SecurityKind,
} from "./catalog.ts";
import { ErrorResponseSchema } from "./responses.ts";

const response = (description: string, schema: z.ZodType) => ({
  description,
  content: { "application/json": { schema } },
});

/** What any authenticated, body-taking operation can refuse with. */
const sharedErrors: Record<number, string> = {
  400: "The request is invalid.",
  401: "Authentication is required or invalid.",
  403: "The authenticated identity is not allowed to perform this operation.",
  404: "The requested resource does not exist.",
};

const managementSecurity: RouteConfig["security"] = [
  { ConsoleSession: [] },
  { ManagementBearer: [] },
];

const securitySchemes: Record<Exclude<SecurityKind, "public">, RouteConfig["security"]> = {
  session: [{ ConsoleSession: [] }],
  management: managementSecurity,
  gateway: [{ GatewayBearer: [] }],
  cliPoll: [{ CliPollProof: [] }],
};

/** One catalog entry as the generator wants it. */
function routeConfig(name: OperationName): RouteConfig {
  // Widened deliberately: indexing the catalog with a generic name yields a
  // union of entry shapes, and this function reads the optional fields that
  // only some of them carry.
  const entry: OperationSpec = CATALOG[name];
  const parameters = Object.entries(entry.params ?? {}).map(([param, spec]) => {
    const base = spec.pattern === undefined ? z.string() : z.string().regex(spec.pattern);
    return [param, base.openapi({
      param: { name: param, in: "path" },
      ...(spec.description === undefined ? {} : { description: spec.description }),
      ...(spec.example === undefined ? {} : { example: spec.example }),
    })] as const;
  });

  const body = entry.request === undefined
    ? undefined
    : "content" in entry.request
      ? {
          required: entry.request.required ?? true,
          content: Object.fromEntries(
            Object.entries(entry.request.content).map(([type, schema]) => [type, { schema }]),
          ),
        }
      : { required: true, content: { "application/json": { schema: entry.request } } };

  const headers = entry.headers;

  const request = {
    ...(parameters.length === 0 ? {} : { params: z.object(Object.fromEntries(parameters)) }),
    ...(entry.query === undefined ? {} : { query: entry.query }),
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };

  const errors: Record<number, string> = {
    ...(entry.errors === "none" ? {} : sharedErrors),
    ...(typeof entry.errors === "object" ? entry.errors : {}),
  };

  const description = entry.description ?? "";

  return {
    method: entry.method.toLowerCase() as Lowercase<typeof entry.method>,
    path: entry.path,
    tags: [...entry.tags],
    operationId: name,
    summary: entry.summary,
    ...(description === "" ? {} : { description }),
    ...(entry.security === "public" ? {} : { security: securitySchemes[entry.security] }),
    ...(Object.keys(request).length === 0 ? {} : { request }),
    responses: {
      [entry.status ?? 200]: entry.response === NO_RESPONSE_BODY
        ? { description: entry.responseDescription }
        : response(entry.responseDescription, entry.response),
      ...Object.fromEntries(
        Object.entries(errors).map(([status, text]) => [status, response(text, ErrorResponseSchema)]),
      ),
    },
  };
}

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
    type: "http", scheme: "bearer", description: "The initiating CLI's private operation token, distinct from the browser's approval proof.",
  });
  target.openAPIRegistry.registerComponent("securitySchemes", "GatewayBearer", {
    type: "http",
    scheme: "bearer",
    description: "A gateway access token, or an application API key for an issuer-less API-key app.",
  });
}

for (const name of Object.keys(CATALOG) as OperationName[]) {
  const route = routeConfig(name);
  registry.openAPIRegistry.registerPath(route);
  if ((CATALOG[name] as OperationSpec).hidden !== true) {
    documentationRegistry.openAPIRegistry.registerPath(route);
  }
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
