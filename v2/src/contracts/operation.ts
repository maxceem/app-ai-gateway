/**
 * What an API operation is: the shape every catalog entry has, and the error
 * body every operation answers with. Plain `zod`.
 */
import { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Which credential reaches an operation. `gateway` is an app key or a gateway
 * token, plus `X-AppAttest-Proof` where the app signs every request.
 * `management` is a management key, an OAuth access token or the console's
 * sign-in. `session` is the console's sign-in only. The document's security
 * schemes are in `./openapi.ts`.
 */
export type SecurityKind = "public" | "gateway" | "management" | "session";

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
  /**
   * Where the success answer is a file rather than JSON: its bytes, of any
   * media type (`*\/*`). `response` is then not read.
   */
  readonly file?: true;
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
    vault: z.enum(["ok", "misconfigured"]).optional().meta({
      description:
        "Whether the key vault is set up: `ok`, or `misconfigured` when its settings are missing or invalid. No provider key can be opened while it is `misconfigured`. Optional: older deployments leave it out.",
    }),
    email: z.enum(["off", "ok", "misconfigured"]).optional().meta({
      description:
        "Whether the deployment can send verification email: `off` when no email is set up (addresses are not verified), `ok`, or `misconfigured` when it is meant to send but its settings are incomplete. Which setting is wrong is logged, never shown here. Optional: older deployments leave it out.",
    }),
  })
  .meta({ id: "HealthResponse" });
