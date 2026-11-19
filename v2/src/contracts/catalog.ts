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

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Which credential reaches an operation. `gateway` is an app key or a gateway
 * token, plus `X-AppAttest-Proof` where the app signs every request. The
 * document's security schemes are in `./openapi.ts`.
 */
export type SecurityKind = "public" | "gateway";

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
} as const satisfies Readonly<Record<string, OperationSpec>>;

export type Catalog = typeof CATALOG;
export type OperationName = keyof Catalog;
export type OperationResponse<K extends OperationName> = z.output<Catalog[K]["response"]>;
