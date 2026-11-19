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

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Which credential reaches an operation. The document's security schemes are in `./openapi.ts`. */
export type SecurityKind = "public";

export interface OperationSpec {
  readonly method: HttpMethod;
  /** OpenAPI template, such as `/v2/apps/{app}`. The only place a path is written. */
  readonly path: `/v2/${string}`;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly description?: string;
  readonly security: SecurityKind;
  readonly request?: z.ZodType;
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
} as const satisfies Readonly<Record<string, OperationSpec>>;

export type Catalog = typeof CATALOG;
export type OperationName = keyof Catalog;
export type OperationResponse<K extends OperationName> = z.output<Catalog[K]["response"]>;
