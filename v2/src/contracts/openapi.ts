/**
 * The OpenAPI document, derived from `./catalog.ts`. Nothing about an
 * operation is written here.
 *
 * This and `scripts/openapi.ts` are the only modules that import
 * `@hono/zod-openapi`, which is why the catalog itself is plain zod.
 */
import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
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
    ...(entry.request === undefined
      ? {}
      : { request: { body: { required: true, content: { "application/json": { schema: entry.request } } } } }),
    responses: {
      200: json(entry.responseDescription, entry.response),
      ...Object.fromEntries(
        Object.entries(entry.errors ?? {}).map(([status, text]) => [status, json(text, ErrorResponseSchema)]),
      ),
    },
  };
}

export function createOpenAPIDocument() {
  const registry = new OpenAPIHono();
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
    tags: [{ name: "Operations", description: "Unauthenticated service health." }],
  });
}
