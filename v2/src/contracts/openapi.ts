/**
 * The OpenAPI document, derived from `./catalog.ts`. Nothing about an
 * operation is written here.
 *
 * This and `scripts/openapi.ts` are the only modules that import
 * `@hono/zod-openapi`, which is why the catalog itself is plain zod.
 */
import { OpenAPIHono, z, type RouteConfig } from "@hono/zod-openapi";
import { CATALOG, ErrorResponseSchema, type OperationName, type OperationSpec } from "./catalog.ts";

const json = (description: string, schema: OperationSpec["response"]) => ({
  description,
  content: { "application/json": { schema } },
});

function routeConfig(name: OperationName): RouteConfig {
  const entry: OperationSpec = CATALOG[name];
  return {
    method: entry.method.toLowerCase() as RouteConfig["method"],
    path: entry.path,
    tags: [...entry.tags],
    operationId: name,
    summary: entry.summary,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.security === "gateway" ? { security: [{ GatewayBearer: [] }] } : {}),
    ...(entry.security === "management" ? { security: [{ ManagementBearer: [] }] } : {}),
    request: {
      ...(entry.params === undefined
        ? {}
        : {
            params: z.object(
              Object.fromEntries(
                Object.entries(entry.params).map(([name, param]) => [
                  name,
                  z.string().openapi({ param: { name, in: "path" }, description: param.description }),
                ]),
              ),
            ),
          }),
      ...(entry.query === undefined ? {} : { query: entry.query }),
      ...(entry.request === undefined
        ? {}
        : { body: { required: true, content: { "application/json": { schema: entry.request } } } }),
    },
    responses: {
      [entry.status ?? 200]: json(entry.responseDescription, entry.response),
      ...Object.fromEntries(
        Object.entries(entry.errors ?? {}).map(([status, text]) => [status, json(text, ErrorResponseSchema)]),
      ),
    },
  };
}

export function createOpenAPIDocument() {
  const registry = new OpenAPIHono();
  registry.openAPIRegistry.registerComponent("securitySchemes", "GatewayBearer", {
    type: "http",
    scheme: "bearer",
    description:
      "A gateway access token from POST /v2/apps/{app}/auth/token, or an app key for a server app that signs no users in. On App Attest apps that sign every request, the request also carries X-AppAttest-Proof.",
  });
  registry.openAPIRegistry.registerComponent("securitySchemes", "ManagementBearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "agw_mgmt_…",
    description:
      "A management key. It acts for one account, with the read or manage grant it was issued with. Writes need the manage grant and an owner or admin role.",
  });
  for (const name of Object.keys(CATALOG) as OperationName[]) {
    registry.openAPIRegistry.registerPath(routeConfig(name));
  }
  return registry.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "App AI Gateway API v2",
      version: "2.0.0-dev",
      description:
        "A provider-native AI proxy for iOS applications and trusted server backends. Provider keys stay on the gateway; requests are checked, limited and recorded before they reach a provider.",
    },
    servers: [
      { url: "https://api.appaigateway.com", description: "The cloud API host. On a self-hosted gateway, use your own origin." },
    ],
    tags: [
      { name: "Operations", description: "Unauthenticated service health." },
      { name: "App sign-in", description: "App Attest challenges and keys, and exchanging a client proof for a gateway token." },
      { name: "Application", description: "The signed-in caller's own state." },
      { name: "Admin applications", description: "Apps and their settings." },
      { name: "Admin providers", description: "Provider connections and their keys. A key is write-only: only its hint is ever returned." },
      { name: "Admin app keys", description: "Keys for server apps." },
    ],
  });
}
